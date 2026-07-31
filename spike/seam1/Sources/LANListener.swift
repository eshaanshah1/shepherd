import Foundation
import Network
import Security
import CryptoKit
#if canImport(Darwin)
import Darwin
#endif

/// The LAN control listener: TLS 1.3 on `0.0.0.0`, advertising `_shepherd._tcp`.
///
/// One listener covers wifi, ethernet and a phone hotspot — no interface enumeration, which is
/// the class of bug that once put the tailnet listener on an OpenVPN tunnel. It answers on the
/// tailnet address too, which is harmless: TLS plus a code or a known secret is still required.
///
/// It terminates TLS and then hands `RemoteServer` one end of a **socketpair**, rather than
/// abstracting the whole control path behind a transport protocol. `RemoteServer` is fd-keyed
/// everywhere that matters (`clients[fd]`, a per-fd write queue, the data-channel handoff that
/// gives the raw fd to `serveDataChannel`, the broker's viewer fds), so bridging buys the
/// encryption with zero changes to the path the user's tailnet already depends on. The
/// plaintext exists only in this process's memory and a kernel socket buffer it owns — never
/// on a wire.
final class LANListener {
    private let port: UInt16
    private let identity: SecIdentity
    private let onBridgedFD: (Int32, String?) -> Void
    private let log: (String) -> Void
    private var listener: NWListener?
    private var bridges: [ObjectIdentifier: LANBridge] = [:]
    private let lock = NSLock()
    private let readySem = DispatchSemaphore(value: 0)
    /// Set once the listener has actually bound. `start()` returning true only means the
    /// listener object was created — NWListener binds ASYNCHRONOUSLY, so a port already in use
    /// fails later, through `stateUpdateHandler`, long after start() has said yes.
    private(set) var isReady = false

    /// - Parameter onBridgedFD: receives the app-side fd of a socketpair carrying one client's
    ///   plaintext frames, plus the peer's IP for logging only — never for identity.
    init(port: UInt16, identity: SecIdentity,
         onBridgedFD: @escaping (Int32, String?) -> Void,
         log: @escaping (String) -> Void = { _ in }) {
        self.port = port; self.identity = identity
        self.onBridgedFD = onBridgedFD; self.log = log
    }

    @discardableResult
    func start() -> Bool {
        guard let secIdentity = sec_identity_create(identity) else {
            log("LAN listener: sec_identity_create failed"); return false
        }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, secIdentity)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        let params = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        params.includePeerToPeer = false
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port),
              let l = try? NWListener(using: params, on: nwPort) else {
            log("LAN listener: could not bind \(port)"); return false
        }
        l.service = NWListener.Service(type: "_shepherd._tcp")
        l.newConnectionHandler = { [weak self] conn in self?.adopt(conn) }
        l.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                self.lock.lock(); self.isReady = true; self.lock.unlock()
                self.readySem.signal()
                self.log("LAN serving on 0.0.0.0:\(self.port) (TLS 1.3)")
            case .failed(let e):
                self.lock.lock(); self.isReady = false; self.lock.unlock()
                self.readySem.signal()
                self.log("LAN listener failed on \(self.port): \(e)")
            case .cancelled:
                self.lock.lock(); self.isReady = false; self.lock.unlock()
            default: break
            }
        }
        l.start(queue: .global(qos: .userInitiated))
        lock.lock(); listener = l; lock.unlock()
        return true
    }

    /// Block until the listener is bound (or has failed). Tests and any caller that needs to
    /// know it is really up must use this rather than trusting `start()`'s return value.
    @discardableResult
    func waitUntilReady(timeout: TimeInterval = 5) -> Bool {
        _ = readySem.wait(timeout: .now() + timeout)
        lock.lock(); defer { lock.unlock() }
        return isReady
    }

    func stop() {
        lock.lock()
        let l = listener; listener = nil
        let live = bridges; bridges.removeAll()
        lock.unlock()
        l?.cancel()
        for (_, b) in live { b.close() }
    }

    private func adopt(_ conn: NWConnection) {
        var ip: String?
        if case let .hostPort(host, _) = conn.endpoint { ip = "\(host)" }
        guard let bridge = LANBridge(conn) else { conn.cancel(); return }
        let key = ObjectIdentifier(bridge)
        lock.lock(); bridges[key] = bridge; lock.unlock()
        bridge.onClose = { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.bridges[key] = nil; self.lock.unlock()
        }
        onBridgedFD(bridge.appFD, ip)
        bridge.start()
    }
}

/// Pumps bytes between a TLS `NWConnection` and one end of a socketpair, handing the other end
/// to `RemoteServer` as if it had accepted an ordinary socket.
final class LANBridge {
    /// The end `RemoteServer` reads and writes. Owned by it from `acceptBridged` onward.
    let appFD: Int32
    private let netFD: Int32
    private let conn: NWConnection
    private let queue = DispatchQueue(label: "shepherd.lan.bridge", qos: .userInitiated)
    private let lock = NSLock()
    private var closed = false
    private let readySem = DispatchSemaphore(value: 0)
    private var ready = false
    var onClose: (() -> Void)?

    /// How a client decides whether the certificate it is offered is the right one.
    enum Trust: Equatable {
        /// Every connection after the first: the hash must match or the handshake is refused.
        case pinned(Data)
        /// First pairing only. There is no pin yet, so the certificate is accepted and its hash
        /// reported — the user then confirms the SAS derived from it against the host's screen,
        /// which is what makes this safe. Nothing is stored until that confirmation lands.
        case learn
    }

    /// Client side: dial `host:port` over TLS 1.3. Returns nil when the handshake is refused —
    /// and a refusal must never be retried: a wrong pin is a decision about identity, not a
    /// transient outage. `observed` always fires with the leaf's SHA-256 before the verdict.
    static func dialTLS(host: String, port: UInt16, trust: Trust,
                        observed: ((Data) -> Void)? = nil,
                        timeout: TimeInterval = 10) -> LANBridge? {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust_, complete in
            let secTrust = sec_trust_copy_ref(trust_).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate],
                  let leaf = chain.first else { complete(false); return }
            let seen = Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data))
            observed?(seen)
            switch trust {
            case .pinned(let pin): complete(seen == pin)
            case .learn:           complete(true)
            }
        }, DispatchQueue(label: "shepherd.lan.verify"))
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return nil }
        let conn = NWConnection(to: .hostPort(host: .init(host), port: nwPort),
                               using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
        guard let bridge = LANBridge(conn) else { conn.cancel(); return nil }
        bridge.start()
        guard bridge.waitUntilReady(timeout) else { bridge.close(); return nil }
        return bridge
    }

    /// Block until the TLS handshake completes. False ⇒ refused or timed out.
    func waitUntilReady(_ timeout: TimeInterval) -> Bool {
        _ = readySem.wait(timeout: .now() + timeout)
        lock.lock(); defer { lock.unlock() }
        return ready && !closed
    }

    init?(_ conn: NWConnection) {
        var fds: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { return nil }
        appFD = fds[0]; netFD = fds[1]
        // Keep both ends out of every PTY child we later fork: an inherited fd would hold the
        // connection open long after the app dropped it.
        for fd in fds { _ = fcntl(fd, F_SETFD, fcntl(fd, F_GETFD) | FD_CLOEXEC) }
        var on: Int32 = 1
        setsockopt(netFD, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        self.conn = conn
    }

    func start() {
        conn.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                self.lock.lock(); self.ready = true; self.lock.unlock()
                self.readySem.signal()
            // A TLS rejection lands in .waiting, not .failed — Network.framework treats a
            // handshake failure as retryable — so treat any error there as terminal.
            case .failed, .cancelled, .waiting:
                self.readySem.signal()
                self.close()
            default: break
            }
        }
        conn.start(queue: queue)
        pumpDown()
        pumpUp()
    }

    /// TLS → plaintext socketpair.
    private func pumpDown() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, err in
            guard let self else { return }
            if let data, !data.isEmpty {
                var off = 0
                data.withUnsafeBytes { raw in
                    guard let base = raw.baseAddress else { return }
                    while off < data.count {
                        let w = write(self.netFD, base + off, data.count - off)
                        if w <= 0 { break }
                        off += w
                    }
                }
                if off < data.count { self.close(); return }
            }
            if done || err != nil { self.close(); return }
            self.pumpDown()
        }
    }

    /// Plaintext socketpair → TLS. A dedicated thread: the read is blocking, and it must not
    /// share a queue with the NWConnection's callbacks.
    private func pumpUp() {
        let fd = netFD
        Thread.detachNewThread { [weak self] in
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let n = read(fd, &buf, buf.count)
                if n <= 0 { if n < 0 && errno == EINTR { continue }; break }
                guard let self else { return }
                self.conn.send(content: Data(buf[0..<n]), completion: .contentProcessed { _ in })
            }
            self?.close()
        }
    }

    func close() {
        lock.lock(); let already = closed; closed = true; lock.unlock()
        guard !already else { return }
        conn.cancel()
        // Only the net end. `appFD` belongs to RemoteServer, which closes it on its own
        // teardown path — closing it here would pull an fd out from under its reader loop,
        // and a recycled number would then be written to by whatever inherited it.
        shutdown(netFD, SHUT_RDWR); Darwin.close(netFD)
        onClose?()
    }
}
