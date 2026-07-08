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
    private let workspaceTrees: () -> [WorkspaceTree]
    // A paired client's structural command (cmd*). Forwarded verbatim to the app, which
    // applies it to the real store on main and re-broadcasts the affected workspace tree.
    private let onCommand: (ControlMessage) -> Void
    private let updateFCMToken: (String, String) -> Void
    private let makeSecret: () -> String
    private let makeNonce: () -> String
    private let lookupBroker: (String) -> PtyBroker?
    // The pane's last-known desktop grid, used to snap back on data-channel detach.
    private let desktopSize: (String) -> (Int, Int)?
    // "Is the desktop showing this pane RIGHT NOW (visible tab, lid open)?" Consulted only
    // when the phone requests a pane (attach / live resize) to resolve the tie: if the desktop
    // is already showing it, the desktop wins and the phone's size is NOT applied — the pane
    // stays desktop-sized. Not a continuous arbiter: desktop focus/tab/zoom never resize on
    // their own. Defaults to "desktop shows nothing" for tests/dark-ship (phone always wins).
    private let desktopOwnsSize: (String) -> Bool

    /// A client that can't drain a write within this many seconds is treated as dead and
    /// dropped, so a stalled reader parks at most one worker (its own queue) for ≤ this
    /// long and can't grow its queue unboundedly. (Non-blocking + a coalescing buffer is
    /// the deferred multi-viewer upgrade; for v1 single-viewer, drop-on-stall is correct.)
    private let sendTimeoutSeconds: Int = 10

    private let listenLock = NSLock()
    private var listenFD: Int32 = -1           // guarded by listenLock
    private var actualPort: UInt16 = 0         // guarded by listenLock; the OS-assigned port when bound with port 0

    /// The port the listen socket is actually bound to — equals `port`, or the OS-assigned
    /// ephemeral port when constructed with port 0 (loopback tests). Zero before `start()`.
    var boundPort: UInt16 { listenLock.lock(); defer { listenLock.unlock() }; return actualPort }

    // Nonces of live control sessions. A data channel is admitted only if its dataHello
    // carries a nonce still in this set (i.e. an authenticated control session is open).
    private var liveNonces = Set<String>()
    private let nonceLock = NSLock()

    /// True while some live control session was issued this sessionNonce.
    func hasLiveNonce(_ nonce: String) -> Bool {
        nonceLock.lock(); defer { nonceLock.unlock() }; return liveNonces.contains(nonce)
    }

    // Open data-channel viewer fds keyed by the sessionNonce that admitted them. When a
    // control session drops (closeConn) we SHUT_RDWR every data channel it authorized so a
    // revoked/dropped device can't keep streaming. serveDataChannel is the sole CLOSER of a
    // viewer fd; this registry is only used to wake it on revoke.
    private var dataViewers: [String: Set<Int32>] = [:]
    private let dataViewersLock = NSLock()
    // Active data-channel VIEWERS per pane. A pane is sized by whoever is actively viewing it
    // (a viewer's DataReady size wins over the desktop grid, unless the desktop is showing the
    // pane right now — see desktopOwnsSize). Refcounted so a pane snaps back to its desktop grid
    // only when its LAST viewer detaches. Per-connection, not one global pane: a Mac client views
    // a whole workspace (many panes) at once, each pane sized independently. A phone views one
    // pane at a time, so its count is 1 for that pane — same behavior as the old single-pane model.
    private var paneViewers: [String: Int] = [:]
    private let sizeLock = NSLock()
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
        var deviceID: String?
        var nonce: String?
        let writeQueue = DispatchQueue(label: "shepherd.remote.write", qos: .utility)
    }

    init(bindAddress: String, port: UInt16,
         currentCode: @escaping () -> String,
         knownDevices: @escaping () -> [PairedDevice],
         persist: @escaping (PairedDevice) -> Void,
         requestApproval: @escaping (String, String, @escaping (Bool) -> Void) -> Void,
         workspaceTrees: @escaping () -> [WorkspaceTree],
         updateFCMToken: @escaping (String, String) -> Void,
         makeSecret: @escaping () -> String,
         makeNonce: @escaping () -> String,
         lookupBroker: @escaping (String) -> PtyBroker? = { _ in nil },
         desktopSize: @escaping (String) -> (Int, Int)? = { _ in nil },
         desktopOwnsSize: @escaping (String) -> Bool = { _ in false },
         onCommand: @escaping (ControlMessage) -> Void = { _ in }) {
        self.bindAddress = bindAddress; self.port = port
        self.currentCode = currentCode; self.knownDevices = knownDevices
        self.persist = persist; self.requestApproval = requestApproval
        self.workspaceTrees = workspaceTrees; self.updateFCMToken = updateFCMToken
        self.makeSecret = makeSecret; self.makeNonce = makeNonce
        self.lookupBroker = lookupBroker
        self.desktopSize = desktopSize
        self.desktopOwnsSize = desktopOwnsSize
        self.onCommand = onCommand
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
        var actual = sockaddr_in()
        var alen = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &alen)
        } }
        listenLock.lock(); listenFD = fd; actualPort = UInt16(bigEndian: actual.sin_port); listenLock.unlock()
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

    /// Read exactly `count` bytes from `fd`, looping over partial reads. Returns nil on
    /// EOF/error. Used to consume EXACTLY the first frame (length prefix + body) so the
    /// socket is never over-read — the control FrameDecoder loop (or the data raw pump)
    /// then starts cleanly on the remaining socket bytes.
    private func readExactly(_ fd: Int32, _ count: Int) -> [UInt8]? {
        if count == 0 { return [] }
        var out = [UInt8](); out.reserveCapacity(count)
        var buf = [UInt8](repeating: 0, count: count)
        while out.count < count {
            let n = read(fd, &buf, count - out.count)
            if n <= 0 { if n < 0 && errno == EINTR { continue }; return nil }
            out.append(contentsOf: buf[0..<n])
        }
        return out
    }

    /// The single reader loop for one connection. Reads exactly one frame and sniffs it:
    /// a `DataMessage.dataHello` routes to the raw PTY data channel; anything else is a
    /// control frame and enters the control path seeded with that first message.
    private func handleConnection(_ fd: Int32) {
        let conn = ConnState()
        clientsLock.lock(); conns[fd] = conn; clientsLock.unlock()

        guard let lenBytes = readExactly(fd, 4) else { closeConn(fd, conn); return }
        let len = lenBytes.withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
        guard len <= 8 * 1024 * 1024, let body = readExactly(fd, len) else { closeConn(fd, conn); return }
        let json = Data(body)

        if case let .dataHello(nonce, paneID, cols, rows)? = try? JSONDecoder().decode(DataMessage.self, from: json) {
            // The control server no longer owns this fd; serveDataChannel + the broker do.
            clientsLock.lock(); conns[fd] = nil; clientsLock.unlock()
            serveDataChannel(fd, nonce: nonce, paneID: paneID, cols: cols, rows: rows)
            return
        }
        guard let first = try? JSONDecoder().decode(ControlMessage.self, from: json) else { closeConn(fd, conn); return }
        handleControlConnection(fd, conn: conn, firstMessage: first)
    }

    private enum MsgOutcome { case keepReading, stop }

    /// The control reader loop: process the sniffed first message, then keep reading frames.
    private func handleControlConnection(_ fd: Int32, conn: ConnState, firstMessage: ControlMessage) {
        if process(firstMessage, fd: fd, conn: conn) == .stop { return }
        let dec = FrameDecoder()
        var buf = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            let msgs = (try? dec.feed(Data(buf[0..<n]))) ?? []
            for m in msgs {
                if process(m, fd: fd, conn: conn) == .stop { return }
            }
        }
        closeConn(fd, conn)
    }

    /// Handle one control message on `conn`. `.stop` means the connection is done (closed
    /// or handed off) and the caller must not keep reading.
    private func process(_ m: ControlMessage, fd: Int32, conn: ConnState) -> MsgOutcome {
        conn.lock.lock(); let phase = conn.phase; conn.lock.unlock()
        if phase == .closed { closeConn(fd, conn); return .stop }
        switch m {
        case let .hello(deviceID, name, code, secret, fcmToken, _) where phase == .unpaired:
            conn.lock.lock(); conn.deviceID = deviceID; conn.lock.unlock()
            let decision = pairingDecision(deviceID: deviceID, name: name, code: code, secret: secret,
                                           known: knownDevices(), currentCode: currentCode(),
                                           newSecret: makeSecret())
            switch decision {
            case let .accept(persistSecret):
                conn.lock.lock(); conn.phase = .paired; conn.lock.unlock()
                if let persistSecret {
                    persist(PairedDevice(deviceID: deviceID, secret: persistSecret, name: name, fcmToken: fcmToken))
                } else if let fcmToken {
                    updateFCMToken(deviceID, fcmToken)   // known-device reconnect: reconcile a rotated token
                }
                admit(fd, conn)
            case .reject(let reason):
                enqueueWriteThenClose(fd, encode(.rejected(reason: reason)), conn); return .stop
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
                        self.persist(PairedDevice(deviceID: approveID, secret: proposedSecret, name: approveName, fcmToken: fcmToken))
                        self.admit(fd, conn)
                    } else {
                        self.enqueueWriteThenClose(fd, self.encode(.rejected(reason: "denied")), conn)
                    }
                }
            }
        case .ping where phase == .paired:
            enqueueWrite(fd, encode(.pong), on: conn)
        case let .refreshFCMToken(token) where phase == .paired:
            conn.lock.lock(); let id = conn.deviceID; conn.lock.unlock()
            if let id { updateFCMToken(id, token) }
        case let .resize(paneID, cols, rows) where phase == .paired:
            applyResize(paneID: paneID, cols: cols, rows: rows)
        case .detach:
            conn.lock.lock(); conn.phase = .closed; conn.lock.unlock()
            closeConn(fd, conn); return .stop
        case .cmdNewTab, .cmdSplit, .cmdClosePane, .cmdFocusPane, .cmdZoom,
             .cmdRenamePane, .cmdReorderTab, .cmdSwitchTab:
            // Structural commands are honored only from a paired, live session — an
            // unpaired socket can't mutate the host. The host never sends these.
            if phase == .paired { onCommand(m) }
        default:
            break
        }
        return .keepReading
    }

    /// Serve a phone's raw PTY data channel: gate on a live nonce + a known pane's broker,
    /// then DataReady → attachViewer (replays the ring + live fan-out) → pump viewer input
    /// into the helper until EOF. On rejection or teardown the fd is shut down and closed.
    private func serveDataChannel(_ fd: Int32, nonce: String, paneID: String, cols: Int, rows: Int) {
        guard hasLiveNonce(nonce), let broker = lookupBroker(paneID) else {
            _ = rawWrite(fd, (try? DataFrameCodec.encode(.dataRejected(reason: "bad nonce"))) ?? Data())
            shutdown(fd, SHUT_RDWR); close(fd); return
        }
        // This viewer takes the pane at its size — UNLESS the desktop is showing it right now, in
        // which case the desktop wins the tie and the pane stays desktop-sized (DataReady echoes
        // that). Refcounted per pane so other panes this device views are untouched.
        viewerAttached(paneID, cols: cols, rows: rows)
        _ = rawWrite(fd, (try? DataFrameCodec.encode(.dataReady(cols: broker.cols, rows: broker.rows))) ?? Data())
        // Attach + register atomically under dataViewersLock, re-checking the nonce is STILL
        // live inside the lock. closeConn removes the nonce (under nonceLock) then sweeps
        // dataViewers[nonce] (under dataViewersLock) sequentially; if the control session
        // dropped between the early guard and here, that sweep already ran, so the recheck
        // fails and we abort rather than register an orphaned fd revocation already swept.
        // Nesting is one-directional (dataViewersLock → nonceLock via hasLiveNonce); closeConn
        // takes the two locks sequentially (not nested), so there is no AB/BA cycle.
        dataViewersLock.lock()
        guard hasLiveNonce(nonce) else {
            dataViewersLock.unlock()
            _ = rawWrite(fd, (try? DataFrameCodec.encode(.dataRejected(reason: "bad nonce"))) ?? Data())
            shutdown(fd, SHUT_RDWR); close(fd); return
        }
        broker.attachViewer(fd: fd)                 // replays the ring, then registers for live fan-out
        dataViewers[nonce, default: []].insert(fd)  // revocable by closeConn from now on
        dataViewersLock.unlock()
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            broker.inputFromViewer(Array(buf[0..<n]))
        }
        // Read-loop exit is the ONE place a viewer fd is closed. Deregister, detach from the
        // broker, then shut down + close exactly once. closeConn/broker only SHUT_RDWR this fd.
        dataViewersLock.lock()
        dataViewers[nonce]?.remove(fd)
        if dataViewers[nonce]?.isEmpty == true { dataViewers[nonce] = nil }
        dataViewersLock.unlock()
        broker.detachViewer(fd: fd)
        // This viewer left the pane. Drop its count; if it was the pane's LAST viewer, snap the
        // pane back to its desktop grid so the Mac's own grid is never left at a remote size.
        viewerDetached(paneID)
        shutdown(fd, SHUT_RDWR); close(fd)
    }

    /// Apply a live resize (rotation / soft-keyboard / client window resize) from a control
    /// channel. Applied only to a pane that currently has an active viewer — a resize for an
    /// unviewed pane is ignored, since the desktop owns any pane no remote is viewing. Also
    /// deferred when the desktop is showing the pane right now (desktop wins the tie).
    func applyResize(paneID: String, cols: Int, rows: Int) {
        sizeLock.lock(); let viewed = (paneViewers[paneID] ?? 0) > 0; sizeLock.unlock()
        guard viewed, !desktopOwnsSize(paneID), let b = lookupBroker(paneID) else { return }
        b.setSize(cols: cols, rows: rows)
    }

    /// A viewer attached to `paneID` at (cols,rows): bump its viewer count and size the pane to
    /// this viewer — unless the desktop is showing it now, in which case the desktop wins the tie.
    private func viewerAttached(_ paneID: String, cols: Int, rows: Int) {
        sizeLock.lock(); paneViewers[paneID, default: 0] += 1; sizeLock.unlock()
        if !desktopOwnsSize(paneID) { lookupBroker(paneID)?.setSize(cols: cols, rows: rows) }
    }

    /// A viewer detached from `paneID`: drop its count and, if it was the pane's LAST viewer,
    /// snap the pane back to its desktop grid. Other panes' counts are untouched.
    private func viewerDetached(_ paneID: String) {
        sizeLock.lock()
        let remaining = (paneViewers[paneID] ?? 1) - 1
        if remaining <= 0 { paneViewers[paneID] = nil } else { paneViewers[paneID] = remaining }
        sizeLock.unlock()
        guard remaining <= 0, let (dc, dr) = desktopSize(paneID) else { return }
        lookupBroker(paneID)?.setSize(cols: dc, rows: dr)
    }

    /// Mark a connection paired: register it for broadcasts and send accepted →
    /// workspaceList → one workspaceTree per workspace. These are distinct frames; a
    /// client that drains them all rebuilds the full mirror.
    ///
    /// Ordering invariant: a newly-paired client must see accepted → the structure frames
    /// BEFORE any delta. We enqueue all of them AND register the fd in `clients` while
    /// holding `clientsLock`; `broadcast` enqueues its deltas under the same lock. Because
    /// each connection's write queue is serial-FIFO, a concurrent broadcast can't slip a
    /// delta for this fd ahead of its accepted/structure frames. `enqueueWrite` returns
    /// immediately (async), so the lock is never held across the actual Darwin.write.
    private func admit(_ fd: Int32, _ state: ConnState) {
        let nonce = makeNonce()
        state.lock.lock(); state.nonce = nonce; state.lock.unlock()
        nonceLock.lock(); liveNonces.insert(nonce); nonceLock.unlock()
        let accepted = encode(.accepted(sessionNonce: nonce))
        let trees = workspaceTrees()
        let listFrame = encode(.workspaceList(ids: trees.map { $0.workspaceID }))
        let treeFrames = trees.map { encode(.workspaceTree($0)) }
        clientsLock.lock()
        clients[fd] = state
        enqueueWrite(fd, accepted, on: state)
        enqueueWrite(fd, listFrame, on: state)
        for f in treeFrames { enqueueWrite(fd, f, on: state) }
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
        let n = state.nonce; state.nonce = nil
        state.lock.unlock()
        if let n {
            nonceLock.lock(); liveNonces.remove(n); nonceLock.unlock()
            // Tear down every data channel this session authorized: SHUT_RDWR ONLY (never
            // close — that wakes the blocked read in serveDataChannel, which is the sole
            // closer + detacher). Held under dataViewersLock so a registered fd can't be
            // closed by its own serveDataChannel (which removes under the same lock before
            // closing) while we shut it down — no shutdown of a recycled fd.
            dataViewersLock.lock()
            for v in dataViewers[n] ?? [] { shutdown(v, SHUT_RDWR) }
            dataViewers[n] = nil
            dataViewersLock.unlock()
        }
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
