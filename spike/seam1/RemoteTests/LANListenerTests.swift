import XCTest
import Network
import Security
import CryptoKit
#if canImport(Darwin)
import Darwin
#endif

/// These assert about BYTES, not about having called a TLS API. The claim being tested is
/// "safe on a public network", and only the wire can settle that.
final class LANListenerTests: XCTestCase {

    private func mintIdentity() throws -> (SecIdentity, Data) {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("lanl-\(UUID().uuidString)")
        guard let got = LANIdentity.loadOrMint(dir: dir) else { throw XCTSkip("openssl unavailable") }
        return (got.identity, got.certHash)
    }

    /// Reads whatever arrives on the bridged fd — standing in for RemoteServer.
    private func drain(_ fd: Int32, into sink: @escaping (Data) -> Void) {
        Thread.detachNewThread {
            var buf = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = read(fd, &buf, buf.count)
                if n <= 0 { break }
                sink(Data(buf[0..<n]))
            }
        }
    }

    func testPayloadCrossesTheWireAsCiphertext() throws {
        let (id, pin) = try mintIdentity()
        let secret = "WORKSPACE-ACTIVE-WORK-SECRET"
        let got = expectation(description: "server received the payload")
        let lock = NSLock()
        var serverSaw = Data()

        let listener = LANListener(port: 18723, identity: id, onBridgedFD: { [weak self] fd, _ in
            self?.drain(fd) { chunk in
                lock.lock(); serverSaw.append(chunk)
                let done = serverSaw.count >= secret.utf8.count
                lock.unlock()
                if done { got.fulfill() }
            }
        })
        XCTAssertTrue(listener.start())
        defer { listener.stop() }

        // A relay in front of the listener records every byte that actually crosses.
        let tap = ByteTap(forwardTo: 18723)
        XCTAssertTrue(tap.start())
        defer { tap.stop() }

        let client = TLSPinnedClient(host: "127.0.0.1", port: tap.localPort, pin: pin)
        XCTAssertEqual(client.connect(timeout: 8), .connected)
        client.send(Data(secret.utf8))
        wait(for: [got], timeout: 8)

        lock.lock(); let received = serverSaw; lock.unlock()
        XCTAssertEqual(String(data: received, encoding: .utf8), secret,
                       "the bridge must deliver the plaintext to the control path")
        XCTAssertNil(tap.captured.range(of: Data(secret.utf8)),
                     "the payload appeared in plaintext on the wire")
        client.close()
    }

    func testMismatchedPinIsRefusedAndNoBytesReachTheApp() throws {
        let (id, _) = try mintIdentity()
        let lock = NSLock()
        var appBytes = 0
        let listener = LANListener(port: 18724, identity: id, onBridgedFD: { [weak self] fd, _ in
            self?.drain(fd) { chunk in lock.lock(); appBytes += chunk.count; lock.unlock() }
        })
        XCTAssertTrue(listener.start())
        defer { listener.stop() }

        let client = TLSPinnedClient(host: "127.0.0.1", port: 18724,
                                     pin: Data(repeating: 0xAB, count: 32))
        XCTAssertEqual(client.connect(timeout: 8), .refused,
                       "a wrong pin must be refused, and refused promptly — not left hanging")
        client.send(Data("SHOULD-NEVER-ARRIVE".utf8))
        Thread.sleep(forTimeInterval: 0.5)
        lock.lock(); let n = appBytes; lock.unlock()
        XCTAssertEqual(n, 0)
        client.close()
    }

    func testNothingListensOnceStopped() throws {
        let (id, _) = try mintIdentity()
        let listener = LANListener(port: 18725, identity: id, onBridgedFD: { _, _ in })
        XCTAssertTrue(listener.start())
        XCTAssertTrue(listener.waitUntilReady(), "NWListener binds asynchronously")
        XCTAssertTrue(probe(port: 18725), "sanity: it should be up before we stop it")
        listener.stop()
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertFalse(probe(port: 18725), "the toggle being off must mean nothing is listening")
    }

    private func probe(port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }
}

// MARK: - Helpers

/// A localhost TCP relay that forwards to `forwardTo` and keeps a copy of every byte it saw in
/// either direction. This is the wire, from the point of view of someone on the same wifi.
final class ByteTap {
    private let target: UInt16
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var seen = Data()
    private(set) var localPort: UInt16 = 0

    init(forwardTo: UInt16) { target = forwardTo }

    var captured: Data { lock.lock(); defer { lock.unlock() }; return seen }

    func start() -> Bool {
        listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else { return false }
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0                       // ephemeral
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(listenFD, 4) == 0 else { close(listenFD); return false }
        var actual = sockaddr_in()
        var alen = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listenFD, $0, &alen) }
        }
        localPort = UInt16(bigEndian: actual.sin_port)
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
        return true
    }

    func stop() { if listenFD >= 0 { shutdown(listenFD, SHUT_RDWR); close(listenFD); listenFD = -1 } }

    private func acceptLoop() {
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 { break }
            guard let upstream = dial(target) else { close(client); continue }
            relay(from: client, to: upstream)
            relay(from: upstream, to: client)
        }
    }

    private func dial(_ port: UInt16) -> Int32? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        if !ok { close(fd); return nil }
        return fd
    }

    private func relay(from: Int32, to: Int32) {
        Thread.detachNewThread { [weak self] in
            var buf = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = read(from, &buf, buf.count)
                if n <= 0 { break }
                let chunk = Data(buf[0..<n])
                self?.lock.lock(); self?.seen.append(chunk); self?.lock.unlock()
                var off = 0
                chunk.withUnsafeBytes { raw in
                    guard let base = raw.baseAddress else { return }
                    while off < chunk.count {
                        let w = write(to, base + off, chunk.count - off)
                        if w <= 0 { break }
                        off += w
                    }
                }
                if off < chunk.count { break }
            }
            shutdown(to, SHUT_WR)
        }
    }
}

/// An NWConnection pinning the server's certificate hash, with the `.waiting` rule from the
/// design: a TLS rejection surfaces there rather than in `.failed`, and Network.framework will
/// retry forever unless the client treats it as terminal.
final class TLSPinnedClient {
    enum Outcome: Equatable { case connected, refused, timedOut }

    private let conn: NWConnection
    private let sem = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var outcome: Outcome?

    init(host: String, port: UInt16, pin: Data) {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate],
                  let leaf = chain.first else { complete(false); return }
            complete(Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data)) == pin)
        }, DispatchQueue(label: "pin.verify"))
        conn = NWConnection(to: .hostPort(host: .init(host), port: .init(rawValue: port)!),
                            using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
    }

    func connect(timeout: TimeInterval) -> Outcome {
        conn.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.outcome == nil else { return }   // first verdict wins
            switch st {
            case .ready:            self.outcome = .connected; self.sem.signal()
            case .failed:           self.outcome = .refused; self.sem.signal()
            case .waiting:          self.outcome = .refused; self.sem.signal()
            default: break
            }
        }
        conn.start(queue: DispatchQueue(label: "pin.client"))
        if sem.wait(timeout: .now() + timeout) == .timedOut { return .timedOut }
        lock.lock(); defer { lock.unlock() }
        return outcome ?? .timedOut
    }

    func send(_ data: Data) { conn.send(content: data, completion: .contentProcessed { _ in }) }
    func close() { conn.cancel() }
}
