import XCTest
import Security
#if canImport(Darwin)
import Darwin
#endif

/// A real `RemoteClient` pairing with a real `RemoteServer` over the TLS LAN listener, code and
/// pin and all. The unit tests prove the pieces; this proves they add up to a working pairing —
/// and that the two ways it should fail do fail.
final class LANPairingE2ETests: XCTestCase {

    private struct Rig {
        let server: RemoteServer
        let listener: LANListener
        let pin: Data
        let port: UInt16
        func tearDown() { listener.stop(); server.stop() }
    }

    private func rig(port: UInt16, code: LANCode?, known: [PairedDevice] = [],
                     approve: Bool = true, persisted: @escaping (PairedDevice) -> Void = { _ in })
    throws -> Rig {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("e2e-\(UUID().uuidString)")
        guard let id = LANIdentity.loadOrMint(dir: dir) else { throw XCTSkip("openssl unavailable") }
        let codeBox = CodeBox(code)
        let server = RemoteServer(
            bindAddress: "127.0.0.1", port: 0,      // the tailnet listener is unused here
            knownDevices: { known },
            persist: persisted,
            requestApproval: { _, _, confirm, decide in
                XCTAssertEqual(confirm, known.isEmpty ? .compareSAS : .trustedOrigin,
                               "a new LAN device must be asked for a SAS comparison")
                decide(approve)
            },
            workspaceTrees: {
                [WorkspaceTree(workspaceID: "w1", name: "SECRET-WORKSPACE-NAME",
                               tabs: [], selectedTabID: nil)]
            },
            updateFCMToken: { _, _ in },
            makeSecret: { "MINTED-SECRET" }, makeNonce: { "NONCE" },
            verifyPeer: { _ in nil }, selfUserID: { "u1" },
            activeLANCode: { codeBox.get() },
            noteLANCodeAttempt: { codeBox.spend() })
        let listener = LANListener(port: port, identity: id.identity,
                                  onBridgedFD: { fd, ip in server.acceptBridged(fd: fd, peerIP: ip) })
        XCTAssertTrue(listener.start())
        XCTAssertTrue(listener.waitUntilReady())
        return Rig(server: server, listener: listener, pin: id.certHash, port: port)
    }

    private final class CodeBox {
        private let lock = NSLock(); private var code: LANCode?
        init(_ c: LANCode?) { code = c }
        func get() -> LANCode? {
            lock.lock(); defer { lock.unlock() }
            guard let c = code, c.isValid(now: Date()) else { return nil }
            return c
        }
        func spend() {
            lock.lock(); if var c = code { c.attemptsLeft -= 1; code = c.attemptsLeft > 0 ? c : nil }
            lock.unlock()
        }
    }

    private func client(_ r: Rig, code: String?, pin: Data? = nil, secret: String? = nil,
                        accepted: XCTestExpectation? = nil, dead: XCTestExpectation? = nil,
                        tree: ((WorkspaceTree) -> Void)? = nil) -> RemoteClient {
        // `.dead` legitimately arrives more than once — the rejection reports it, then the read
        // loop ends and reports it again — so the expectation must tolerate that.
        dead?.assertForOverFulfill = false
        accepted?.assertForOverFulfill = false
        return RemoteClient(host: "127.0.0.1", port: r.port, deviceID: "mac-b", deviceName: "Air",
                            secret: secret, trust: .pinned(pin ?? r.pin), pairingCode: code,
                            onAccepted: { _ in accepted?.fulfill() },
                            onWorkspaceTree: { t in tree?(t) },
                            onState: { _, _, _ in },
                            onStatus: { if $0 == .dead { dead?.fulfill() } })
    }

    func testCorrectCodeAndPinPairsAndMirrorsTheWorkspace() throws {
        var persistedSecret: String?
        let lock = NSLock()
        let r = try rig(port: 18731, code: LANCode.fresh(now: Date(), digits: "424242"),
                        persisted: { dev in lock.lock(); persistedSecret = dev.secret; lock.unlock() })
        defer { r.tearDown() }

        let ok = expectation(description: "accepted")
        let got = expectation(description: "tree")
        let c = client(r, code: "424242", accepted: ok,
                       tree: { if $0.name == "SECRET-WORKSPACE-NAME" { got.fulfill() } })
        c.start()
        defer { c.stop() }
        wait(for: [ok, got], timeout: 12)
        lock.lock(); let s = persistedSecret; lock.unlock()
        XCTAssertEqual(s, "MINTED-SECRET", "approval must persist the device so reconnects skip the code")
    }

    func testWrongCodeIsRejected() throws {
        let r = try rig(port: 18732, code: LANCode.fresh(now: Date(), digits: "424242"))
        defer { r.tearDown() }
        let died = expectation(description: "dead")
        let c = client(r, code: "000000", dead: died)
        c.start()
        defer { c.stop() }
        wait(for: [died], timeout: 12)
    }

    func testWrongPinNeverReachesTheHandshake() throws {
        let r = try rig(port: 18733, code: LANCode.fresh(now: Date(), digits: "424242"))
        defer { r.tearDown() }
        let died = expectation(description: "dead")
        let c = client(r, code: "424242", pin: Data(repeating: 0x11, count: 32), dead: died)
        c.start()
        defer { c.stop() }
        wait(for: [died], timeout: 12)
    }

    /// A code is spent by its three attempts, so a guessing client locks itself out.
    func testThreeWrongCodesExhaustTheCode() throws {
        let r = try rig(port: 18734, code: LANCode.fresh(now: Date(), digits: "424242"))
        defer { r.tearDown() }
        for i in 0..<3 {
            let died = expectation(description: "dead \(i)")
            let c = client(r, code: "000000", dead: died)
            c.start()
            wait(for: [died], timeout: 12)
            c.stop()
        }
        let died = expectation(description: "even the right code now fails")
        let c = client(r, code: "424242", dead: died)
        c.start()
        defer { c.stop() }
        wait(for: [died], timeout: 12)
    }

    /// First pairing has no pin yet: the client learns the certificate and reports its hash,
    /// which must equal the host's — that equality is what the SAS comparison shows the user.
    func testFirstPairingLearnsTheHostsCertificate() throws {
        let r = try rig(port: 18736, code: LANCode.fresh(now: Date(), digits: "424242"))
        defer { r.tearDown() }
        let ok = expectation(description: "accepted")
        ok.assertForOverFulfill = false
        let seen = expectation(description: "observed cert")
        seen.assertForOverFulfill = false
        let lock = NSLock()
        var observed: Data?
        let c = RemoteClient(host: "127.0.0.1", port: r.port, deviceID: "mac-b", deviceName: "Air",
                             secret: nil, trust: .learn, pairingCode: "424242",
                             onObservedCert: { h in
                                 lock.lock(); observed = h; lock.unlock(); seen.fulfill()
                             },
                             onAccepted: { _ in ok.fulfill() },
                             onWorkspaceTree: { _ in },
                             onState: { _, _, _ in },
                             onStatus: { _ in })
        c.start()
        defer { c.stop() }
        wait(for: [seen, ok], timeout: 12)
        lock.lock(); let got = observed; lock.unlock()
        XCTAssertEqual(got, r.pin, "the learned hash is the pin every later connection compares")
        XCTAssertEqual(got.map { sasDigits(certHash: $0) }, sasDigits(certHash: r.pin))
    }

    /// A device the host already knows pairs by secret over the LAN — no code, and the approval
    /// closure asserts it is not asked for a SAS comparison.
    func testKnownDeviceReconnectsWithoutACode() throws {
        let r = try rig(port: 18735, code: nil,
                        known: [PairedDevice(deviceID: "mac-b", secret: "OLD", name: "Air", fcmToken: nil)])
        defer { r.tearDown() }
        let ok = expectation(description: "accepted")
        let c = client(r, code: nil, secret: "OLD", accepted: ok)
        c.start()
        defer { c.stop() }
        wait(for: [ok], timeout: 12)
    }
}
