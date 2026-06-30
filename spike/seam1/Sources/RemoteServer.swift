import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// TCP control-channel server. Binds `bindAddress:port` (the Tailscale interface in
/// production, 127.0.0.1 in tests), accepts connections on a background queue, runs
/// the pairing handshake, and broadcasts ControlMessages to paired clients. Decoupled
/// from AgentStore via closures so it is loopback-testable.
///
/// Each connection has exactly one reader loop for its whole lifetime. It starts
/// unpaired; a successful handshake flips a shared per-connection flag and the same
/// loop keeps reading the fd for ping/detach. New-device approval is async — the loop
/// keeps reading but ignores frames until the approval callback admits or rejects, so
/// the fd never gets a second concurrent reader.
final class RemoteServer {
    private let bindAddress: String
    private let port: UInt16
    private let currentCode: () -> String
    private let knownDevices: () -> [PairedDevice]
    private let persist: (PairedDevice) -> Void
    private let requestApproval: (String, String, @escaping (Bool) -> Void) -> Void
    private let snapshot: () -> [PaneInfo]
    private let makeSecret: () -> String
    private let makeNonce: () -> String

    /// A client that can't drain a write within this many seconds is treated as dead and
    /// dropped, so a stalled reader parks at most one worker (its own queue) for ≤ this
    /// long and can't grow its queue unboundedly. (Non-blocking + a coalescing buffer is
    /// the deferred multi-viewer upgrade; for v1 single-viewer, drop-on-stall is correct.)
    private let sendTimeoutSeconds: Int = 10

    private let listenLock = NSLock()
    private var listenFD: Int32 = -1           // guarded by listenLock
    private let acceptQueue = DispatchQueue(label: "shepherd.remote.accept", qos: .utility)
    // Per-connection reader loops run concurrently here so one's blocking read()
    // can't starve another connection's handshake or an approval callback.
    private let connQueue = DispatchQueue(label: "shepherd.remote.conn", qos: .utility, attributes: .concurrent)
    private let clientsLock = NSLock()
    // Paired, writable connections (broadcast targets), keyed by fd. Every write to an
    // fd goes through ITS connection's own serial write queue, so writes to one fd never
    // interleave (a stream-socket write() isn't atomic for large payloads) AND a slow or
    // stalled client only blocks its own queue — never the accept path or other clients.
    private var clients: [Int32: ConnState] = [:]
    // Every live connection's state, keyed by fd: teardown shuts these all down,
    // not just the paired subset in `clients`. A guarded close removes the entry.
    private var conns: [Int32: ConnState] = [:]   // guarded by clientsLock

    /// Per-connection handshake + write state, shared between the reader loop, an async
    /// approval callback, and broadcasts. `phase` advances unpaired → pending →
    /// paired/closed; the reader only acts on `hello` while `.unpaired`. `closed` guards
    /// the fd so it is closed exactly once across the reject/deny/loop-exit/teardown
    /// paths. `writeQueue` is this connection's OWN serial queue — every frame to this fd
    /// is enqueued there, giving FIFO per-fd ordering with no lock held across the write.
    private final class ConnState {
        enum Phase { case unpaired, pending, paired, closed }
        let lock = NSLock()
        var phase: Phase = .unpaired
        var closed = false
        let writeQueue = DispatchQueue(label: "shepherd.remote.write", qos: .utility)
    }

    init(bindAddress: String, port: UInt16,
         currentCode: @escaping () -> String,
         knownDevices: @escaping () -> [PairedDevice],
         persist: @escaping (PairedDevice) -> Void,
         requestApproval: @escaping (String, String, @escaping (Bool) -> Void) -> Void,
         snapshot: @escaping () -> [PaneInfo],
         makeSecret: @escaping () -> String,
         makeNonce: @escaping () -> String) {
        self.bindAddress = bindAddress; self.port = port
        self.currentCode = currentCode; self.knownDevices = knownDevices
        self.persist = persist; self.requestApproval = requestApproval
        self.snapshot = snapshot; self.makeSecret = makeSecret; self.makeNonce = makeNonce
    }

    /// Resolve this machine's Tailscale IPv4 (100.64.0.0/10), or nil if Tailscale is down.
    static func currentTailscaleIPv4() -> String? {
        var addrs: [(name: String, ipv4: String)] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return nil }
        defer { freeifaddrs(ifap) }
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            if let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                var sin = UnsafeRawPointer(sa).assumingMemoryBound(to: sockaddr_in.self).pointee
                inet_ntop(AF_INET, &sin.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
                let name = String(cString: cur.pointee.ifa_name)
                addrs.append((name, String(cString: buf)))
            }
            ptr = cur.pointee.ifa_next
        }
        return tailscaleIPv4(from: addrs)
    }

    @discardableResult
    func start() -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, bindAddress, &addr.sin_addr)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(fd, 8) == 0 else { close(fd); return false }
        listenLock.lock(); listenFD = fd; listenLock.unlock()
        acceptQueue.async { [weak self] in self?.acceptLoop() }
        return true
    }

    func stop() {
        // Shut down then close the listen fd so a blocked accept() returns deterministically.
        listenLock.lock(); let lfd = listenFD; listenFD = -1; listenLock.unlock()
        if lfd >= 0 { shutdown(lfd, SHUT_RDWR); close(lfd) }
        // Force every live connection's reader to wake: shutting down the fd makes a
        // blocked read() return ≤0, so each handleConnection loop breaks and exits.
        clientsLock.lock()
        let states = conns
        clients.removeAll()
        clientsLock.unlock()
        // Flip every connection to .closed so a `.pending` approval callback that
        // resolves after teardown short-circuits and can't re-admit a dead fd.
        for (_, state) in states {
            state.lock.lock(); state.phase = .closed; state.lock.unlock()
        }
        for (fd, state) in states { closeConn(fd, state) }
    }

    private func acceptLoop() {
        listenLock.lock(); let lfd = listenFD; listenLock.unlock()
        guard lfd >= 0 else { return }
        while true {
            let fd = accept(lfd, nil, nil)
            if fd < 0 { if errno == EINTR { continue } else { break } }
            // A control channel wants each frame on the wire immediately, not Nagle-batched.
            var on: Int32 = 1
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
            // Writing to a socket whose peer has gone must return EPIPE, not raise SIGPIPE
            // (which would kill the process) — the broadcast-prune path relies on the -1.
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            // Bound how long a write can block on a stalled (non-draining) client: after
            // this, write() returns EAGAIN and we drop the client (see rawWrite).
            var snd = timeval(tv_sec: sendTimeoutSeconds, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd, socklen_t(MemoryLayout<timeval>.size))
            connQueue.async { [weak self] in self?.handleConnection(fd) }
        }
    }

    /// The single reader loop for one connection.
    private func handleConnection(_ fd: Int32) {
        let dec = FrameDecoder()
        let conn = ConnState()
        clientsLock.lock(); conns[fd] = conn; clientsLock.unlock()
        var buf = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            let msgs = (try? dec.feed(Data(buf[0..<n]))) ?? []
            for m in msgs {
                conn.lock.lock(); let phase = conn.phase; conn.lock.unlock()
                if phase == .closed { closeConn(fd, conn); return }
                switch m {
                case let .hello(deviceID, name, code, secret, _, _) where phase == .unpaired:
                    let decision = pairingDecision(deviceID: deviceID, name: name, code: code, secret: secret,
                                                   known: knownDevices(), currentCode: currentCode(),
                                                   newSecret: makeSecret())
                    switch decision {
                    case let .accept(persistSecret):
                        conn.lock.lock(); conn.phase = .paired; conn.lock.unlock()
                        if let persistSecret {
                            persist(PairedDevice(deviceID: deviceID, secret: persistSecret, name: name))
                        }
                        admit(fd, conn)
                    case .reject(let reason):
                        enqueueWriteThenClose(fd, encode(.rejected(reason: reason)), conn); return
                    case let .needsApproval(approveID, approveName, proposedSecret):
                        enqueueWrite(fd, encode(.pendingApproval), on: conn)
                        conn.lock.lock(); conn.phase = .pending; conn.lock.unlock()
                        // The decision may arrive on any thread (in production, the main
                        // queue after the user taps Approve). Phase transitions are
                        // lock-guarded and only one transition out of `.pending` wins, so
                        // exactly one admit/reject happens; the reader loop keeps owning the fd.
                        requestApproval(approveID, approveName) { [weak self] ok in
                            guard let self else { return }
                            conn.lock.lock()
                            guard conn.phase == .pending else { conn.lock.unlock(); return }
                            conn.phase = ok ? .paired : .closed
                            conn.lock.unlock()
                            if ok {
                                self.persist(PairedDevice(deviceID: approveID, secret: proposedSecret, name: approveName))
                                self.admit(fd, conn)
                            } else {
                                self.enqueueWriteThenClose(fd, self.encode(.rejected(reason: "denied")), conn)
                            }
                        }
                    }
                case .ping where phase == .paired:
                    enqueueWrite(fd, encode(.pong), on: conn)
                case .detach:
                    conn.lock.lock(); conn.phase = .closed; conn.lock.unlock()
                    closeConn(fd, conn); return
                default:
                    break
                }
            }
        }
        closeConn(fd, conn)
    }

    /// Mark a connection paired: register it for broadcasts and send accepted + snapshot.
    /// The two frames are distinct events; a client that drains all frames reads both.
    ///
    /// Ordering invariant: a newly-paired client must see accepted → snapshot BEFORE any
    /// delta. We enqueue both frames AND register the fd in `clients` while holding
    /// `clientsLock`; `broadcast` enqueues its deltas under the same lock. Because each
    /// connection's write queue is serial-FIFO, a concurrent broadcast can't slip a delta
    /// for this fd ahead of its accepted/snapshot. `enqueueWrite` returns immediately
    /// (async), so the lock is never held across the actual Darwin.write.
    private func admit(_ fd: Int32, _ state: ConnState) {
        let accepted = encode(.accepted(sessionNonce: makeNonce()))
        let snap = encode(.snapshot(panes: snapshot()))
        clientsLock.lock()
        clients[fd] = state
        enqueueWrite(fd, accepted, on: state)
        enqueueWrite(fd, snap, on: state)
        clientsLock.unlock()
    }

    func broadcast(_ msg: ControlMessage) {
        let data = (try? FrameCodec.encode(msg)) ?? Data()
        clientsLock.lock()
        for (fd, state) in clients { enqueueWrite(fd, data, on: state) }
        clientsLock.unlock()
    }

    /// Close a connection's fd exactly once and drop its bookkeeping. Safe to call from
    /// the reader loop, an async approval callback, or teardown — the `closed` flag on
    /// the shared `ConnState` makes every call after the first a no-op.
    private func closeConn(_ fd: Int32, _ state: ConnState) {
        state.lock.lock()
        if state.closed { state.lock.unlock(); return }
        state.closed = true
        state.lock.unlock()
        clientsLock.lock(); clients[fd] = nil; conns[fd] = nil; clientsLock.unlock()
        shutdown(fd, SHUT_RDWR); close(fd)
    }

    private func encode(_ m: ControlMessage) -> Data { (try? FrameCodec.encode(m)) ?? Data() }

    /// Enqueue a frame for `fd` on THIS connection's own serial write queue. The actual
    /// write runs off-lock. A failed write means a dead or stalled peer — a hard error
    /// (EPIPE/EBADF) or the SO_SNDTIMEO timeout (EAGAIN) after the client stopped draining
    /// — so we fully reap the connection: `closeConn` drops it from `clients`/`conns` and
    /// closes the fd, which wakes its reader loop (read returns ≤0 → loop exits) and makes
    /// every still-queued write on this serial queue fast-fail on the closed fd. A slow
    /// client thus parks at most one worker on its OWN queue for ≤ the timeout, never the
    /// accept path or another client's queue.
    private func enqueueWrite(_ fd: Int32, _ data: Data, on state: ConnState) {
        state.writeQueue.async { [weak self] in
            guard let self else { return }
            // Skip the syscall if this connection was already reaped: its fd is closed and
            // the integer may have been recycled by a freshly accepted client, so writing
            // would inject this dead connection's bytes into a live client's stream.
            state.lock.lock(); let closed = state.closed; state.lock.unlock()
            if closed { return }
            if self.rawWrite(fd, data) < 0 { self.closeConn(fd, state) }
        }
    }

    /// Enqueue a final frame then close, both on this connection's serial write queue so
    /// the close can't beat the (async) write — without this the peer would never see
    /// `rejected` before its fd is torn down. Used by the reject/deny paths.
    private func enqueueWriteThenClose(_ fd: Int32, _ data: Data, _ state: ConnState) {
        state.writeQueue.async { [weak self] in
            guard let self else { return }
            // Skip if already reaped — the fd is closed and may now belong to another client.
            state.lock.lock(); let closed = state.closed; state.lock.unlock()
            if closed { return }
            _ = self.rawWrite(fd, data)
            self.closeConn(fd, state)
        }
    }

    /// One frame to one fd, looping over partial writes and retrying only EINTR. Returns
    /// the total bytes written, or -1 on any other error — a hard failure (EBADF/EPIPE) or
    /// the SO_SNDTIMEO timeout (EAGAIN/EWOULDBLOCK) when a stalled client won't drain. The
    /// caller drops the connection on -1.
    @discardableResult private func rawWrite(_ fd: Int32, _ data: Data) -> Int {
        data.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return 0 }
            var off = 0
            let total = data.count
            while off < total {
                let n = Darwin.write(fd, base + off, total - off)
                if n > 0 { off += n; continue }
                if n < 0 && errno == EINTR { continue }
                // Every other errno — including EAGAIN/EWOULDBLOCK (identical on Darwin) from
                // the SO_SNDTIMEO timeout — intentionally drops the client (caller reaps via
                // closeConn). Do NOT turn this into a retry: that reintroduces an unbounded stall.
                return -1
            }
            return off
        }
    }
}
