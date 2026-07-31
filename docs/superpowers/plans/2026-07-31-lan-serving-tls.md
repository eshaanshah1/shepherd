# LAN Serving over TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Shepherd host to your own Mac and phone over any local link (wifi, hotspot, ethernet) with the wire encrypted end to end, safe on a network you do not control.

**Architecture:** An additive `NWListener` + TLS 1.3 listener on `0.0.0.0:8723`, behind a `Transport` seam so the existing raw-socket tailnet path is untouched. Admission splits into a host-shown 6-digit code (authorization) and a cert-hash SAS confirmed by a three-way pick (channel authentication). Clients pin SHA-256 of the server certificate.

**Tech Stack:** Swift / Network.framework / Security.framework / CryptoKit on macOS; Kotlin / `SSLSocket` / `NsdManager` on Android; `/usr/bin/openssl` for one-shot identity minting.

**Spec:** [`docs/superpowers/specs/2026-07-31-lan-serving-tls-design.md`](../specs/2026-07-31-lan-serving-tls-design.md) — read §4–§6 before Task 3.

## Global Constraints

- **No plaintext fallback on the LAN listener, ever, under any toggle.** A test asserts nothing listens on 8723 while the toggle is off.
- The tailnet path's transport behaviour must not change. `FDTransport` is a move, not a rewrite.
- LAN port is `8723` (`AgentStore.defaultLANPort`); the tailnet port stays `8722`.
- The LAN listener binds `0.0.0.0` — never an enumerated interface.
- Identity: self-signed **RSA-2048**, `~/.shepherd/lan-identity.p12`, mode `0600`, p12 passphrase the constant `"shepherd"` (the file mode is the protection).
- The pin is `SHA256(certificate DER)` — `SecCertificateCopyData` on Swift, `cert.encoded` on Kotlin. Never the SPKI.
- A TLS rejection arrives as `NWConnection.State.waiting`, not `.failed`. Treat a TLS error there as terminal.
- Swift files added or removed require `xcodegen generate` before building; a new **source** in a test target also needs adding to that target's `sources:` list in `project.yml`.
- Build/test from `spike/seam1`, always **build then test** (a cold `-derivedDataPath` fails `test` on module resolution):
  ```sh
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
    CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- A pass counts only when the **test count moves** (`grep -c "passed ("`); `-only-testing:` on an unknown suite reports success vacuously.
- Never `killall Shepherd` — the user runs it as their daily terminal. Verification is compile + unit tests; runtime checks are theirs.

---

### Task 1: `Transport` seam, with the tailnet path moved onto it

**Files:**
- Create: `spike/seam1/Sources/Transport.swift`
- Modify: `spike/seam1/Sources/RemoteServer.swift` (connection read/write path), `spike/seam1/Sources/project.yml` is **not** touched (new source under `Sources/` is globbed by the app target; add `Transport.swift` to `ShepherdRemoteTests` and `ShepherdModelTests` `sources:` lists in `spike/seam1/project.yml`)
- Test: `spike/seam1/RemoteTests/TransportTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `protocol Transport: AnyObject { func send(_ data: Data); var onReceive: ((Data) -> Void)? { get set }; var onClose: (() -> Void)? { get set }; func close() }`, and `final class FDTransport: Transport { init(fd: Int32, queue: DispatchQueue, sendTimeoutSeconds: Int) }`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest

final class TransportTests: XCTestCase {
    func testFDTransportRoundTripsOverASocketPair() throws {
        var fds: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        let t = FDTransport(fd: fds[0], queue: DispatchQueue(label: "t"), sendTimeoutSeconds: 5)
        let got = expectation(description: "received")
        var received = Data()
        t.onReceive = { received.append($0); if received.count >= 5 { got.fulfill() } }
        t.start()
        write(fds[1], "hello", 5)
        wait(for: [got], timeout: 2)
        XCTAssertEqual(String(data: received, encoding: .utf8), "hello")
        t.send(Data("back".utf8))
        var buf = [UInt8](repeating: 0, count: 16)
        let n = read(fds[1], &buf, buf.count)
        XCTAssertEqual(String(bytes: buf[0..<max(0, n)], encoding: .utf8), "back")
        t.close(); close(fds[1])
    }

    func testFDTransportReportsCloseOnce() throws {
        var fds: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        let t = FDTransport(fd: fds[0], queue: DispatchQueue(label: "t2"), sendTimeoutSeconds: 5)
        let closed = expectation(description: "closed")
        var calls = 0
        t.onClose = { calls += 1; if calls == 1 { closed.fulfill() } }
        t.start()
        close(fds[1])                  // peer hangs up -> read() returns 0
        wait(for: [closed], timeout: 2)
        t.close()                      // must not fire onClose a second time
        XCTAssertEqual(calls, 1)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: `error: cannot find 'FDTransport' in scope`.

- [ ] **Step 3: Write `Sources/Transport.swift`**

```swift
import Foundation

/// One duplex byte channel. The frame codec sits above it, so the tailnet's raw sockets and
/// the LAN's TLS connections are interchangeable to everything that speaks frames.
protocol Transport: AnyObject {
    func send(_ data: Data)
    var onReceive: ((Data) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    func close()
}

/// The tailnet path's transport: a blocking read loop on `queue`, moved out of RemoteServer
/// unchanged. SIGPIPE stays suppressed via SO_NOSIGPIPE at accept; a send timeout bounds how
/// long a stalled client can block us before it is dropped.
final class FDTransport: Transport {
    var onReceive: ((Data) -> Void)?
    var onClose: (() -> Void)?

    private let fd: Int32
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var closed = false

    init(fd: Int32, queue: DispatchQueue, sendTimeoutSeconds: Int) {
        self.fd = fd; self.queue = queue
        var snd = timeval(tv_sec: sendTimeoutSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd, socklen_t(MemoryLayout<timeval>.size))
    }

    func start() {
        queue.async { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 16 * 1024)
            while true {
                let n = read(self.fd, &buf, buf.count)
                if n > 0 { self.onReceive?(Data(buf[0..<n])) } else if n == 0 || errno != EINTR { break }
            }
            self.reportClose()
        }
    }

    func send(_ data: Data) {
        var off = 0
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            while off < data.count {
                let w = write(fd, base + off, data.count - off)
                if w <= 0 { break }
                off += w
            }
        }
        if off < data.count { close() }
    }

    func close() {
        lock.lock(); let already = closed; closed = true; lock.unlock()
        guard !already else { return }
        shutdown(fd, SHUT_RDWR); Darwin.close(fd)
    }

    private func reportClose() {
        lock.lock(); let already = closed; closed = true; lock.unlock()
        guard !already else { return }
        onClose?()
    }
}
```

- [ ] **Step 4: Rewire `RemoteServer` onto it**

In `acceptLoop`, after `setCloseOnExec(fd)` and the existing `setsockopt` calls, build an `FDTransport` for the connection and store it on the per-connection state instead of the bare fd. Route `onReceive` into the existing `FrameDecoder` feed, and `onClose` into `closeConn`. Delete the connection's own read loop and `rawWrite`; `send` replaces it. Keep `conns`/`clients` keyed by fd — the fd is still the identity.

- [ ] **Step 5: Build + run the full suites**

```sh
xcodebuild … build && xcodebuild … -only-testing:ShepherdRemoteTests -only-testing:ShepherdModelTests test
```
Expected: `** TEST SUCCEEDED **`, count up by 2, and `RemoteServerTests` still green (it covers the tailnet handshake end to end — that is the regression gate for this refactor).

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/Transport.swift spike/seam1/Sources/RemoteServer.swift \
        spike/seam1/RemoteTests/TransportTests.swift spike/seam1/project.yml
git commit -m "refactor(remote): one Transport seam under the control channel"
```

---

### Task 2: LAN identity — mint, load, hash

**Files:**
- Create: `spike/seam1/Sources/LANIdentity.swift`
- Test: `spike/seam1/RemoteTests/LANIdentityTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum LANIdentity { static func loadOrMint(dir: String) -> (identity: SecIdentity, certHash: Data)?; static func certHash(of: SecIdentity) -> Data; static func reset(dir: String) }` and `func sasDigits(certHash: Data) -> String`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
import Security

final class LANIdentityTests: XCTestCase {
    private func tempDir() -> String {
        let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("lanid-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    func testMintsOnceAndReloadsTheSameIdentity() throws {
        let dir = tempDir()
        guard let a = LANIdentity.loadOrMint(dir: dir) else { return XCTFail("mint failed") }
        guard let b = LANIdentity.loadOrMint(dir: dir) else { return XCTFail("reload failed") }
        XCTAssertEqual(a.certHash, b.certHash, "a reload must not re-mint — every pin would break")
        XCTAssertEqual(a.certHash.count, 32)
    }

    func testP12IsOwnerOnly() throws {
        let dir = tempDir()
        _ = LANIdentity.loadOrMint(dir: dir)
        let path = (dir as NSString).appendingPathComponent("lan-identity.p12")
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.int16Value, 0o600)
    }

    func testResetMintsANewIdentity() throws {
        let dir = tempDir()
        guard let a = LANIdentity.loadOrMint(dir: dir) else { return XCTFail() }
        LANIdentity.reset(dir: dir)
        guard let b = LANIdentity.loadOrMint(dir: dir) else { return XCTFail() }
        XCTAssertNotEqual(a.certHash, b.certHash)
    }

    /// Byte-pinned so the Kotlin implementation cannot drift into showing other digits.
    func testSASDigitsAreAPinnedFunctionOfTheHash() {
        let hash = Data([0x00, 0x01, 0x02, 0x03] + [UInt8](repeating: 0xff, count: 28))
        XCTAssertEqual(sasDigits(certHash: hash), String(format: "%06u", 0x00010203 % 1_000_000))
        XCTAssertEqual(sasDigits(certHash: hash).count, 6)
        XCTAssertNotEqual(sasDigits(certHash: hash),
                          sasDigits(certHash: Data([0x00, 0x01, 0x02, 0x04] + [UInt8](repeating: 0xff, count: 28))))
    }
}
```

- [ ] **Step 2: Run it and watch it fail** — `cannot find 'LANIdentity' in scope`.

- [ ] **Step 3: Implement `Sources/LANIdentity.swift`**

```swift
import Foundation
import Security
import CryptoKit

/// The host's LAN TLS identity: a self-signed RSA-2048 cert minted once by /usr/bin/openssl
/// and imported through SecPKCS12Import. RSA rather than EC because an EC p12 written by the
/// system LibreSSL makes SecPKCS12Import raise from inside SecIdentityCreate — a crash, not
/// an error. The passphrase is a constant and is not the protection: the 0600 mode is.
enum LANIdentity {
    static let passphrase = "shepherd"
    static func p12Path(_ dir: String) -> String {
        (dir as NSString).appendingPathComponent("lan-identity.p12")
    }

    static func loadOrMint(dir: String) -> (identity: SecIdentity, certHash: Data)? {
        let path = p12Path(dir)
        if !FileManager.default.fileExists(atPath: path), !mint(dir: dir) { return nil }
        guard let identity = load(path) else { return nil }
        return (identity, certHash(of: identity))
    }

    static func reset(dir: String) { try? FileManager.default.removeItem(atPath: p12Path(dir)) }

    static func certHash(of identity: SecIdentity) -> Data {
        var cert: SecCertificate?
        SecIdentityCopyCertificate(identity, &cert)
        guard let cert else { return Data() }
        return Data(SHA256.hash(data: SecCertificateCopyData(cert) as Data))
    }

    private static func load(_ path: String) -> SecIdentity? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        var items: CFArray?
        guard SecPKCS12Import(data as CFData,
                              [kSecImportExportPassphrase as String: passphrase] as CFDictionary,
                              &items) == errSecSuccess,
              let arr = items as? [[String: Any]],
              let ident = arr.first?[kSecImportItemIdentity as String] else { return nil }
        return (ident as! SecIdentity)
    }

    private static func mint(dir: String) -> Bool {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let key = (dir as NSString).appendingPathComponent("lan-key.pem")
        let cert = (dir as NSString).appendingPathComponent("lan-cert.pem")
        defer { for f in [key, cert] { try? FileManager.default.removeItem(atPath: f) } }
        guard run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7300",
                   "-subj", "/CN=Shepherd LAN", "-keyout", key, "-out", cert]),
              run(["pkcs12", "-export", "-inkey", key, "-in", cert,
                   "-out", p12Path(dir), "-passout", "pass:\(passphrase)", "-name", "Shepherd LAN"])
        else { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                              ofItemAtPath: p12Path(dir))
        return true
    }

    private static func run(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}

/// Six digits both ends derive from the server certificate's SHA-256. A man in the middle
/// must present its own certificate, so its digits differ — that is the whole detection.
/// Byte-pinned in Swift and Kotlin tests; changing it breaks every paired device's compare.
func sasDigits(certHash: Data) -> String {
    let n = certHash.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return String(format: "%06u", n % 1_000_000)
}
```

- [ ] **Step 4: `xcodegen generate`, build, test** — expected: 4 new cases pass.

- [ ] **Step 5: Commit** — `feat(remote): mint and load the host's LAN TLS identity`.

---

### Task 3: admission policy — origin, code, SAS choices (pure)

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (extend `pairingDecision`, add `PeerOrigin` / `ConfirmKind` / `sasChoices`)
- Modify: `spike/seam1/Sources/RemoteServer.swift` (call sites), `spike/seam1/Sources/AgentStore.swift` (call site)
- Test: `spike/seam1/Tests/RemotePairingTests.swift`

**Interfaces:**
- Consumes: `sasDigits(certHash:)` from Task 2.
- Produces:
  ```swift
  enum PeerOrigin: Equatable { case tailnet(VerifiedPeer?), lan }
  enum ConfirmKind: Equatable { case trustedOrigin, compareSAS }
  case needsApproval(deviceID: String, name: String, proposedSecret: String, confirm: ConfirmKind)
  func pairingDecision(deviceID: String, secret: String?, known: [PairedDevice], newSecret: String,
                       origin: PeerOrigin, selfUserID: String?, activeCode: String?,
                       codeAttemptsLeft: Int) -> PairingDecision
  func sasChoices(real: String, decoys: [String], insertAt: Int) -> [String]
  ```

- [ ] **Step 1: Write the failing tests** (add to `RemotePairingTests`)

```swift
func testKnownDeviceAdmittedBySecretOverLAN() {
    let dev = PairedDevice(deviceID: "d1", secret: "s1", name: "Air", fcmToken: nil)
    XCTAssertEqual(pairingDecision(deviceID: "d1", secret: "s1", known: [dev], newSecret: "new",
                                   origin: .lan, selfUserID: "u", activeCode: nil, codeAttemptsLeft: 0),
                   .accept(persistSecret: nil))
}

func testNewLANDeviceNeedsTheCodeAndThenASASCompare() {
    XCTAssertEqual(pairingDecision(deviceID: "d2", secret: nil, known: [], newSecret: "new",
                                   origin: .lan, selfUserID: "u", activeCode: "123456", codeAttemptsLeft: 3),
                   .needsApproval(deviceID: "d2", name: "d2", proposedSecret: "new", confirm: .compareSAS))
}

func testNewLANDeviceWithWrongOrAbsentCodeIsRejected() {
    for code in [nil, "000000"] {
        XCTAssertEqual(pairingDecision(deviceID: "d3", secret: nil, known: [], newSecret: "new",
                                       origin: .lan, selfUserID: "u", activeCode: "123456",
                                       codeAttemptsLeft: 3),
                       .reject(reason: "bad code"), "code=\(code ?? "nil")")
    }
    XCTAssertEqual(pairingDecision(deviceID: "d3", secret: "123456", known: [], newSecret: "new",
                                   origin: .lan, selfUserID: "u", activeCode: nil, codeAttemptsLeft: 3),
                   .reject(reason: "bad code"), "no live code on the host")
    XCTAssertEqual(pairingDecision(deviceID: "d3", secret: "123456", known: [], newSecret: "new",
                                   origin: .lan, selfUserID: "u", activeCode: "123456", codeAttemptsLeft: 0),
                   .reject(reason: "bad code"), "attempts exhausted")
}

func testTailnetPathIsUnchangedAndConfirmsByOrigin() {
    let peer = VerifiedPeer(userID: "u", name: "Air")
    XCTAssertEqual(pairingDecision(deviceID: "d4", secret: nil, known: [], newSecret: "new",
                                   origin: .tailnet(peer), selfUserID: "u", activeCode: nil,
                                   codeAttemptsLeft: 0),
                   .needsApproval(deviceID: "d4", name: "Air", proposedSecret: "new",
                                  confirm: .trustedOrigin))
    XCTAssertEqual(pairingDecision(deviceID: "d5", secret: nil, known: [], newSecret: "new",
                                   origin: .tailnet(nil), selfUserID: "u", activeCode: nil,
                                   codeAttemptsLeft: 0),
                   .reject(reason: "unverified peer"))
}

func testSASChoicesPlaceTheRealCodeAtTheGivenIndex() {
    let out = sasChoices(real: "111111", decoys: ["222222", "333333"], insertAt: 1)
    XCTAssertEqual(out, ["222222", "111111", "333333"])
    XCTAssertEqual(sasChoices(real: "111111", decoys: ["222222", "333333"], insertAt: 99).count, 3)
    XCTAssertTrue(sasChoices(real: "111111", decoys: ["222222", "333333"], insertAt: 99).contains("111111"))
}
```

Note the hello's LAN pairing code travels in `ControlMessage.hello(pairingCode:)`, which already exists; `secret` is reused as the code carrier in **no** case — the third test's use of `secret:` is deliberate, it asserts that a code in the wrong field does not admit.

- [ ] **Step 2: Run and watch them fail** — missing `PeerOrigin`, arity mismatch on `pairingDecision`.

- [ ] **Step 3: Implement in `RemoteProtocol.swift`**

```swift
/// Where a connection came from. The tailnet carries a verifiable identity (source IP
/// resolved against the peer list); a LAN connection carries none, so it must present the
/// host's code and then have its channel confirmed by SAS compare.
enum PeerOrigin: Equatable { case tailnet(VerifiedPeer?), lan }

/// How the human must confirm an approval. `.trustedOrigin` is the tailnet's yes/no;
/// `.compareSAS` is the three-way pick that makes a LAN pairing MITM-resistant.
enum ConfirmKind: Equatable { case trustedOrigin, compareSAS }

func pairingDecision(deviceID: String, secret: String?, known: [PairedDevice], newSecret: String,
                     origin: PeerOrigin, selfUserID: String?, activeCode: String?,
                     codeAttemptsLeft: Int) -> PairingDecision {
    if let dev = known.first(where: { $0.deviceID == deviceID }) {
        return secret == dev.secret ? .accept(persistSecret: nil) : .reject(reason: "bad secret")
    }
    switch origin {
    case .tailnet(let peer):
        if let peer, let selfUserID, peer.userID == selfUserID {
            return .needsApproval(deviceID: deviceID, name: peer.name,
                                  proposedSecret: secret ?? newSecret, confirm: .trustedOrigin)
        }
        return .reject(reason: "unverified peer")
    case .lan:
        return .reject(reason: "bad code")   // replaced in Step 4 by the code check
    }
}

/// The real SAS among decoys, at a caller-chosen index — randomness stays out of the model.
func sasChoices(real: String, decoys: [String], insertAt: Int) -> [String] {
    var out = decoys
    out.insert(real, at: min(max(0, insertAt), out.count))
    return out
}
```

- [ ] **Step 4: Make the LAN branch real**

The LAN case needs the code the client sent, which is `hello`'s `pairingCode`, not `secret`. Add it as a parameter `presentedCode: String?` **before** `activeCode` and implement:

```swift
    case .lan:
        guard let activeCode, codeAttemptsLeft > 0, let presentedCode,
              presentedCode == activeCode else { return .reject(reason: "bad code") }
        return .needsApproval(deviceID: deviceID, name: deviceName ?? deviceID,
                              proposedSecret: secret ?? newSecret, confirm: .compareSAS)
```
Add `deviceName: String?` to the signature too — a LAN peer has no verified name, so the approval sheet shows the self-reported one, clearly labelled as such in Task 5. Update the tests from Step 1 to pass `presentedCode:` and `deviceName:`, and update the two existing call sites (`RemoteServer.admit`, and `AgentStore`'s `knownDevices`/`persist` wiring is unaffected).

- [ ] **Step 5: Build, test, commit** — `feat(remote): admission policy gains a LAN origin`.

---

### Task 4: the TLS listener

**Files:**
- Create: `spike/seam1/Sources/LANListener.swift`, `spike/seam1/Sources/NWTransport.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (`defaultLANPort`, `isServingLAN`, start/stop), `spike/seam1/Sources/RemoteServer.swift` (accept a `Transport` from an external source)
- Test: `spike/seam1/RemoteTests/LANListenerTests.swift`

**Interfaces:**
- Consumes: `Transport` (Task 1), `LANIdentity` (Task 2), `pairingDecision` (Task 3).
- Produces: `final class LANListener { init(port: UInt16, identity: SecIdentity, onConnection: (Transport, String) -> Void, log: (String) -> Void); func start() -> Bool; func stop() }` — the `String` is the peer's IP for logging only, never for identity. `final class NWTransport: Transport { init(_ conn: NWConnection) }`.

- [ ] **Step 1: Write the failing test** — the security assertions, not "did we call a TLS API":

```swift
import XCTest
import Network
import Security
import CryptoKit

final class LANListenerTests: XCTestCase {
    private func identity() throws -> (SecIdentity, Data) {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("lanl-\(UUID().uuidString)")
        guard let got = LANIdentity.loadOrMint(dir: dir) else { throw XCTSkip("openssl unavailable") }
        return (got.identity, got.certHash)
    }

    func testCiphertextOnTheWireAndNoPlaintextPayload() throws {
        let (id, pin) = try identity()
        let secret = "WORKSPACE-ACTIVE-WORK-SECRET"
        let ready = expectation(description: "server got frame")
        var serverSaw = Data()
        let listener = LANListener(port: 18723, identity: id, onConnection: { t, _ in
            t.onReceive = { serverSaw.append($0); if serverSaw.count >= secret.utf8.count { ready.fulfill() } }
            (t as? NWTransport)?.start()
        }, log: { _ in })
        XCTAssertTrue(listener.start())
        defer { listener.stop() }

        // A raw TCP tap in front of the client records exactly what crosses the wire.
        let tap = ByteTap(forwardingTo: 18723)
        XCTAssertTrue(tap.start())
        defer { tap.stop() }

        let client = try TLSPinnedClient(host: "127.0.0.1", port: tap.localPort, pin: pin)
        XCTAssertTrue(client.connect(timeout: 5))
        client.send(Data(secret.utf8))
        wait(for: [ready], timeout: 5)

        XCTAssertEqual(String(data: serverSaw, encoding: .utf8), secret)
        XCTAssertFalse(tap.captured.range(of: Data(secret.utf8)) != nil,
                       "the payload appeared in plaintext on the wire")
    }

    func testMismatchedPinIsRefusedBeforeAnyFrameIsSent() throws {
        let (id, _) = try identity()
        var serverBytes = 0
        let listener = LANListener(port: 18724, identity: id, onConnection: { t, _ in
            t.onReceive = { serverBytes += $0.count }
            (t as? NWTransport)?.start()
        }, log: { _ in })
        XCTAssertTrue(listener.start())
        defer { listener.stop() }
        let client = try TLSPinnedClient(host: "127.0.0.1", port: 18724,
                                         pin: Data(repeating: 0xAB, count: 32))
        XCTAssertFalse(client.connect(timeout: 5), "a wrong pin must not connect")
        XCTAssertEqual(serverBytes, 0)
    }

    func testNothingListensWhenStopped() throws {
        let (id, _) = try identity()
        let listener = LANListener(port: 18725, identity: id, onConnection: { _, _ in }, log: { _ in })
        XCTAssertTrue(listener.start())
        listener.stop()
        XCTAssertFalse(TailscaleDiscovery.probe(host: "127.0.0.1", port: 18725, timeoutMs: 300))
    }
}
```

`ByteTap` (a `socketpair`-free localhost relay recording every byte it forwards) and `TLSPinnedClient` (an `NWConnection` with the verify block from §6, treating a TLS error in `.waiting` as terminal) are **test helpers**; write them in the same file. `TLSPinnedClient.connect` must return `false` on `.waiting(TLS error)` — that behaviour is the thing under test in the second case.

- [ ] **Step 2: Run and watch fail** — `cannot find 'LANListener'`.

- [ ] **Step 3: Implement `NWTransport.swift`**

```swift
import Foundation
import Network

/// A Transport over an NWConnection. Receives are chained (one receive re-arms the next), and
/// a TLS rejection is treated as terminal from `.waiting` — Network.framework considers a
/// handshake failure retryable, so a pin mismatch would otherwise sit in "connecting…" forever.
final class NWTransport: Transport {
    var onReceive: ((Data) -> Void)?
    var onClose: (() -> Void)?
    private let conn: NWConnection
    private let lock = NSLock()
    private var closed = false

    init(_ conn: NWConnection) { self.conn = conn }

    func start(queue: DispatchQueue = .global(qos: .userInitiated)) {
        conn.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: self?.reportClose()
            case .waiting: self?.close()          // handshake refused; do not retry
            default: break
            }
        }
        conn.start(queue: queue)
        pump()
    }

    private func pump() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, err in
            guard let self else { return }
            if let data, !data.isEmpty { self.onReceive?(data) }
            if done || err != nil { self.reportClose(); return }
            self.pump()
        }
    }

    func send(_ data: Data) {
        conn.send(content: data, completion: .contentProcessed { [weak self] err in
            if err != nil { self?.close() }
        })
    }

    func close() {
        lock.lock(); let already = closed; closed = true; lock.unlock()
        guard !already else { return }
        conn.cancel()
        onClose?()
    }

    private func reportClose() {
        lock.lock(); let already = closed; closed = true; lock.unlock()
        guard !already else { return }
        onClose?()
    }
}
```

- [ ] **Step 4: Implement `LANListener.swift`**

```swift
import Foundation
import Network
import Security

/// The LAN control listener: TLS 1.3 on 0.0.0.0, advertising _shepherd._tcp. One listener
/// covers wifi, ethernet and a hotspot — no interface enumeration, which is the class of bug
/// that put the tailnet listener on an OpenVPN tunnel.
final class LANListener {
    private let port: UInt16
    private let identity: SecIdentity
    private let onConnection: (Transport, String) -> Void
    private let log: (String) -> Void
    private var listener: NWListener?

    init(port: UInt16, identity: SecIdentity,
         onConnection: @escaping (Transport, String) -> Void, log: @escaping (String) -> Void) {
        self.port = port; self.identity = identity; self.onConnection = onConnection; self.log = log
    }

    @discardableResult
    func start() -> Bool {
        let tls = NWProtocolTLS.Options()
        guard let secIdentity = sec_identity_create(identity) else { return false }
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, secIdentity)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        let params = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        params.includePeerToPeer = false
        guard let nwPort = NWEndpoint.Port(rawValue: port),
              let l = try? NWListener(using: params, on: nwPort) else { return false }
        l.service = NWListener.Service(type: "_shepherd._tcp")
        l.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            let ip: String
            if case let .hostPort(host, _) = conn.endpoint { ip = "\(host)" } else { ip = "?" }
            let t = NWTransport(conn)
            self.onConnection(t, ip)
            t.start()
        }
        l.start(queue: .global(qos: .userInitiated))
        listener = l
        log("LAN serving on 0.0.0.0:\(port) (TLS)")
        return true
    }

    func stop() { listener?.cancel(); listener = nil }
}
```

- [ ] **Step 5: Wire it into `AgentStore`** — `static let defaultLANPort: UInt16 = 8723`, `var isServingLAN: Bool { UserDefaults.standard.bool(forKey: "shepherd.remote.servingLAN") }`, `setServingLAN(_:)` mirroring `setServing(_:)`, and `startLANServingIfEnabled()` which loads the identity (`LANIdentity.loadOrMint(dir: supportDir)`) and hands each `Transport` to the same `RemoteServer` frame path with `origin: .lan`. Tear down in `stopRemoteServing`'s LAN counterpart.

- [ ] **Step 6: Build, test, commit** — expected: 3 new cases pass, including the plaintext-absence assertion. `feat(remote): TLS 1.3 LAN listener`.

---

### Task 5: Mac UI — toggle, code, three-way pick, LAN rows

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (Remote tab: *Serve on local network*, *Reset LAN identity*), `spike/seam1/Sources/PairingApprovalView.swift` (`.compareSAS` variant), `spike/seam1/Sources/RemoteDeviceSheet.swift` (`.lanUnpaired` rows + code entry), `spike/seam1/Sources/TailscaleDiscovery.swift` (`Pairability.lanUnpaired`), `spike/seam1/Sources/AgentStore.swift` (`activeLANCode`, attempts, browser)
- Create: `spike/seam1/Sources/LANBrowser.swift` (`NWBrowser` wrapper publishing `[LANHost]`)
- Test: `spike/seam1/Tests/LANCodeTests.swift`

**Interfaces:**
- Consumes: `sasDigits`, `sasChoices`, `ConfirmKind`.
- Produces: `struct LANCode { let digits: String; let issued: Date; var attemptsLeft: Int; func isValid(now: Date) -> Bool }`, `final class LANBrowser { var onChange: (([LANHost]) -> Void)?; func start(); func stop() }`, `struct LANHost: Equatable, Identifiable { let id: String; let name: String; let endpoint: NWEndpoint }`.

- [ ] **Step 1: Write the failing test**

```swift
func testCodeExpiresAfterFiveMinutes() {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let code = LANCode(digits: "123456", issued: t0, attemptsLeft: 3)
    XCTAssertTrue(code.isValid(now: t0.addingTimeInterval(299)))
    XCTAssertFalse(code.isValid(now: t0.addingTimeInterval(301)))
}

func testCodeIsSixDigitsAndAttemptsStartAtThree() {
    let code = LANCode.fresh(now: Date(), digits: "000042")
    XCTAssertEqual(code.digits.count, 6)
    XCTAssertEqual(code.attemptsLeft, 3)
}

func testExhaustedCodeIsInvalidEvenWhenFresh() {
    let t0 = Date()
    var code = LANCode.fresh(now: t0, digits: "123456")
    code.attemptsLeft = 0
    XCTAssertFalse(code.isValid(now: t0))
}
```

- [ ] **Step 2: Run, watch fail. Step 3: implement `LANCode`** in `Sources/LANIdentity.swift` (it belongs with the other LAN-pairing model):

```swift
/// The host-shown pairing code: 6 digits, 5 minutes, 3 attempts, one device. Authorization
/// only — it proves a human is at the host. Channel authentication is the SAS.
struct LANCode: Equatable {
    static let lifetime: TimeInterval = 300
    let digits: String
    let issued: Date
    var attemptsLeft: Int

    static func fresh(now: Date, digits: String) -> LANCode {
        LANCode(digits: digits, issued: now, attemptsLeft: 3)
    }
    func isValid(now: Date) -> Bool {
        attemptsLeft > 0 && now.timeIntervalSince(issued) <= Self.lifetime
    }
}
```

- [ ] **Step 4: Build the UI**, in this order, checking the build after each file:
  1. `TailscaleDiscovery.Pairability` gains `case lanUnpaired`; `RemoteDeviceSheet.subtitle` returns `"on this network — pair to connect"`; the row is enabled and its tap opens code entry rather than calling `addRemoteHost` directly.
  2. `LANBrowser` — `NWBrowser(for: .bonjour(type: "_shepherd._tcp", domain: nil), using: .tcp)`, publishing results on main; `AgentStore` starts it while the sheet is open and stops on dismiss (a browser running forever is a wakeup source).
  3. `SettingsView` Remote tab: the *Serve on local network* toggle bound to `store.isServingLAN`, the live 6-digit code + a *New code* button while serving, and *Reset LAN identity* behind a confirm alert whose text says every paired LAN device must pair again.
  4. `PairingApprovalView`'s `.compareSAS` variant: the self-reported device name labelled *unverified name*, three code buttons from `sasChoices`, and a *None of these match* button that rejects. Picking a wrong one rejects too — only the real SAS admits.

- [ ] **Step 5: Build, test, commit** — `feat(remote): LAN pairing UI with a three-way SAS pick`.

---

### Task 6: the data channel over the LAN listener

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (`serveDataChannel` reached through a `Transport`), `spike/seam1/Sources/PtyBroker.swift` (viewer writes through `Transport`), `spike/seam1/Sources/AgentStore.swift` (LAN data channel wiring)
- Test: `spike/seam1/RemoteTests/DataChannelTests.swift` (extend)

**Interfaces:**
- Consumes: `LANListener`, `NWTransport`, the existing `DataMessage` / `DataFrameCodec` and `sessionNonce` gate.
- Produces: no new API — the LAN listener's connections reach `serveDataChannel` on the same nonce rule as the tailnet's.

- [ ] **Step 1: Write the failing test** — a LAN data channel replays the ring and streams PTY bytes, and the tap sees none of them in plaintext:

```swift
func testLANDataChannelStreamsPTYBytesEncrypted() throws {
    // Same ByteTap + TLSPinnedClient helpers as LANListenerTests; assert the ring's
    // replayed bytes ("PROMPT$ ") arrive at the client and never appear in tap.captured.
}
```
Write it against the existing `DataChannelTests` loopback fixture, swapping its raw socket for `TLSPinnedClient`.

- [ ] **Step 2–4: run, implement, re-run.** The only real work is that `PtyBroker`'s viewer set becomes `[Transport]` instead of `[Int32]`; its `write`-with-timeout logic moves into `FDTransport` (Task 1 already put it there).

- [ ] **Step 5: Commit** — `feat(remote): PTY data channels over the LAN listener`.

---

### Task 7: Android — discovery, pinning, SAS

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/transport/RemoteConnection.kt`, `.../transport/DataChannel.kt`
- Create: `android/app/src/main/java/com/eshaan/shepherd/transport/Pinning.kt`, `.../transport/LanDiscovery.kt`, `.../ui/LanPairingScreen.kt`
- Test: `android/app/src/test/java/com/eshaan/shepherd/transport/PinningTest.kt`, `.../transport/SasTest.kt`

**Interfaces:**
- Consumes: the wire protocol unchanged; `sasDigits` semantics from Task 2.
- Produces: `fun sasDigits(certHash: ByteArray): String`, `fun pinnedSocketFactory(pin: ByteArray): SSLSocketFactory`, `class LanDiscovery(context: Context) { fun start(onHosts: (List<LanHost>) -> Unit); fun stop() }`.

- [ ] **Step 1: Write the failing tests**

```kotlin
class SasTest {
    @Test fun `sas digits match the Swift vector`() {
        val hash = byteArrayOf(0x00, 0x01, 0x02, 0x03) + ByteArray(28) { 0xff.toByte() }
        assertEquals("%06d".format(0x00010203L % 1_000_000L), sasDigits(hash))
    }
}

class PinningTest {
    @Test fun `mismatched pin throws before any byte is written`() { /* local SSLServerSocket
        with a generated self-signed cert; assert SSLHandshakeException and zero bytes read */ }
}
```
The first test's expected value must equal the Swift `LANIdentityTests` vector — that pair is the only thing keeping the two implementations from showing different digits for the same host.

- [ ] **Step 2: Run** — `./gradlew :app:testDebugUnitTest --tests '*SasTest*'` with `JDK17` + `ANDROID_HOME` set (see the build-env memory), expected: unresolved reference `sasDigits`.

- [ ] **Step 3: Implement** `Pinning.kt` (an `X509TrustManager` comparing `SHA-256(cert.encoded)`, throwing `CertificateException` on mismatch, and refusing to fall back to the platform trust store), `sasDigits` beside it, then `LanDiscovery` over `NsdManager` for `_shepherd._tcp`, then thread the pinned factory through `RemoteConnection` and `DataChannel`.

- [ ] **Step 4: Pairing screen** — host list from discovery, a 6-digit code field, and the SAS shown large with the instruction to pick it on the Mac. No Confirm button on the phone: the pick happens on the host.

- [ ] **Step 5: Build + test + commit** — `feat(android): LAN mode with pinned TLS`.

---

### Task 8: evidence pass

**Files:** none (verification only), then `CLAUDE.md` + the spec's status line.

- [ ] **Step 1:** `xcodebuild … build` then `… -only-testing:ShepherdModelTests -only-testing:ShepherdRemoteTests test`; record the case count.
- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest`; record it.
- [ ] **Step 3:** Hand the user the runtime checklist, which is theirs to run (never relaunch their daily app):
  - Toggle *Serve on local network* on Mac A; on Mac B the LAN row appears, pair with the code, pick the SAS.
  - `sudo tcpdump -i en0 -A 'tcp port 8723'` during a pane stream — confirm no plaintext, no workspace names.
  - Wrong SAS pick ⇒ refused; wrong pin (after *Reset LAN identity* on the host) ⇒ the client reports a refusal rather than hanging.
  - Toggle off ⇒ `nc -z <ip> 8723` refused.
- [ ] **Step 4:** Update `CLAUDE.md`'s remote section + the spec status to `shipped`, and commit.

---

## Deviations taken during implementation (2026-07-31)

1. **Task 1 became a bridge, not a `Transport` seam.** Reading the code first: `RemoteServer` is
   fd-keyed at every level that matters — `clients[fd]`, a per-fd serial write queue, the
   data-channel handoff that gives the raw fd to `serveDataChannel`, and `PtyBroker`'s viewer fds.
   Abstracting all of it would have rewritten the path the user's tailnet depends on daily. The LAN
   listener instead terminates TLS and hands over one end of a `socketpair` (`LANBridge`), so the
   whole control path is reached unmodified and **Task 6 came for free** — a `dataHello` on a
   bridged connection sniffs and routes exactly as it does on the tailnet. The security property is
   unchanged: TLS terminates in-process and the plaintext only ever exists in this process's memory
   and a socket buffer it owns.
2. **`PeerOrigin` has no associated value.** The spec wrote `.tailnet(VerifiedPeer?)`; keeping
   `peer:` as its own parameter meant the seven existing tailnet policy tests compile untouched,
   which is a stronger statement that the tailnet path did not move.
3. **Tests consolidated into `Tests/LANIdentityTests.swift`** (model target) rather than split
   across `RemoteTests` and a separate `LANCodeTests`, since `LANCode` lives in `LANIdentity.swift`.
4. **`LANBridge.Trust.learn` was added** — the spec did not say how a *first* pairing gets a pin it
   does not have yet. It accepts the certificate, reports its hash, and the pin is stored only once
   the host's user confirms the SAS derived from it.
5. **Task 7 (Android) done.** `Pinning.kt` (trust manager + `sasDigits` + connectors),
   `LanDiscovery` over `NsdManager`, the pin persisted on `Pairing`, and the SAS panel on
   `PairingScreen`. `RemoteConnection` ends its retry loop on `PinMismatch` — the Kotlin mirror of
   the Swift `.waiting` rule. Its tests do a real TLS handshake against a real self-signed server
   (fixture `app/src/test/resources/lan-test-identity.p12`), not a mocked one.

## Self-review

**Spec coverage:** §1 → Tasks 1, 4. §2 → Task 4's tap test. §3 → Task 5.2 (`LANBrowser`) + Task 4's `l.service`. §4 → Tasks 2 (`sasDigits`), 3 (policy), 5 (code + pick). §5 → Task 2. §6 → Task 4 (`NWTransport.waiting`) + Task 7 (`Pinning.kt`). §7 → Tasks 4, 6, 7, 8. §8 stages map 1:1 onto Tasks 1–8. §9's risks: identity settled (Task 2), custom sheet (Task 5.4), firewall (Task 8 runtime), blind picker documented.

**Placeholders:** Task 6 Step 1 carries a described-not-written test body and Step 2–4 are collapsed; that is deliberate — it is a mechanical repeat of Task 4's fixture, and the plan says exactly which fixture to copy and what to swap. Task 7 Step 1's `PinningTest` body is likewise a described fixture. Both are called out here rather than left to look finished.

**Type consistency:** `Transport` / `FDTransport` / `NWTransport` names are stable across Tasks 1, 4, 6. `pairingDecision`'s final signature (Task 3 Step 4) adds `presentedCode:` and `deviceName:` to Step 3's version — Step 4 says so explicitly and tells you to update Step 1's tests. `sasDigits(certHash:)` is the label in both languages. `LANCode` lives in `LANIdentity.swift`, not its own file.
