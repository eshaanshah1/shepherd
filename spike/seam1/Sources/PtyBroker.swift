import Foundation
import Darwin

/// A byte ring that retains at most the last `cap` bytes of PTY output for replay to a
/// newly-attaching viewer. Pure/value type — unit-tested. Simple contiguous buffer with
/// front-trim; PTY output is bursty but bounded by `cap`, so trimming on append is fine.
struct PtyRing {
    private var buf: [UInt8] = []
    let cap: Int
    init(cap: Int = 256 * 1024) { self.cap = cap }

    mutating func append(_ bytes: [UInt8]) {
        buf.append(contentsOf: bytes)
        if buf.count > cap { buf.removeFirst(buf.count - cap) }
    }
    func snapshot() -> [UInt8] { buf }
    var count: Int { buf.count }
}

/// Per-pane broker: fans a helper's PTY output out to attached phone viewers and writes
/// viewer input back to the helper. All socket writes go through a serial queue; the
/// viewer set is lock-guarded. Blocking writes with a send timeout + drop-on-stall (same
/// discipline as RemoteServer) — non-blocking I/O + coalescing is the deferred hardening.
final class PtyBroker {
    let paneID: String
    private(set) var cols: Int
    private(set) var rows: Int
    // The pane's desktop grid (the helper's launch size) — the snap-back target after a
    // phone detaches or the pane is refocused on the Mac. Preserved across phone setSize.
    let desktopCols: Int
    let desktopRows: Int
    private let lock = NSLock()
    private var helperFD: Int32 = -1
    private var viewers = Set<Int32>()
    private var ring = PtyRing()
    private var closed = false
    private let q = DispatchQueue(label: "shepherd.pty.broker")

    init(paneID: String, cols: Int, rows: Int) {
        self.paneID = paneID; self.cols = cols; self.rows = rows
        self.desktopCols = cols; self.desktopRows = rows
    }

    func attachHelper(fd: Int32) { lock.lock(); helperFD = fd; lock.unlock() }

    func feedFromHelper(_ bytes: [UInt8]) {
        // Enqueue the fan-out writes WHILE holding the lock so lock-order == queue-order:
        // append+fan-out is atomic, and a concurrent attachViewer's replay can't slip its
        // enqueue between this append and its fan-out. q.async is non-blocking, so holding
        // the lock across the enqueue can't stall.
        lock.lock(); ring.append(bytes); for v in viewers { writeAll(v, bytes) }; lock.unlock()
    }

    func attachViewer(fd: Int32) {
        // Snapshot + insert + enqueue the replay under the lock so the replay is enqueued
        // before any later live byte for this fd (see feedFromHelper) — no out-of-order
        // bytes on attach to an active pane.
        lock.lock()
        let replay = ring.snapshot(); viewers.insert(fd)
        if !replay.isEmpty { writeAll(fd, replay) }
        lock.unlock()
    }

    func detachViewer(fd: Int32) { lock.lock(); viewers.remove(fd); lock.unlock() }

    func inputFromViewer(_ bytes: [UInt8]) {
        lock.lock(); let h = helperFD; lock.unlock()
        if h >= 0 { writeAll(h, Array(HelperFrameCodec.encode(.input(bytes)))) }
    }

    /// Update the pane's grid and push a resize frame to the helper (which resizes
    /// the inner PTY). Records the new size so a later DataReady reflects it.
    func setSize(cols: Int, rows: Int) {
        lock.lock(); self.cols = cols; self.rows = rows; let h = helperFD; lock.unlock()
        if h >= 0 { writeAll(h, Array(HelperFrameCodec.encode(.resize(cols: cols, rows: rows)))) }
    }

    func close() {
        // SHUT_RDWR viewer fds UNDER the lock (mirrors RemoteServer.closeConn): that wakes
        // their serveDataChannel read loop, which is the SOLE closer of a viewer fd — and its
        // detachViewer takes this same lock before its close(), so a fd still in `viewers`
        // here cannot have been closed+recycled yet (no shutdown of a recycled fd). shutdown
        // is non-blocking, so holding the lock across it can't stall; writeAll's queue item
        // also takes this lock, but close() doesn't wait on the queue, so there's no inversion.
        lock.lock()
        for v in viewers { shutdown(v, SHUT_RDWR) }
        viewers.removeAll()
        let h = helperFD; helperFD = -1; closed = true
        lock.unlock()
        // We own the helper fd, so shutdown + close it here.
        if h >= 0 { shutdown(h, SHUT_RDWR); Darwin.close(h) }
    }

    private func writeAll(_ fd: Int32, _ bytes: [UInt8]) {
        q.async { [self] in
            lock.lock(); let isClosed = closed; lock.unlock()
            if isClosed { return }   // fd may be closed/recycled after teardown
            var off = 0
            bytes.withUnsafeBytes { raw in
                let base = raw.bindMemory(to: UInt8.self).baseAddress!
                while off < bytes.count {
                    let w = write(fd, base + off, bytes.count - off)
                    if w < 0 { if errno == EINTR { continue }; return }   // drop on stall/error
                    off += w
                }
            }
        }
    }

    // Test-only.
    func ringSnapshotForTest() -> [UInt8] { lock.lock(); defer { lock.unlock() }; return ring.snapshot() }
}

/// Accepts helper connections on a unix-domain socket ($SHEPHERD_PTY_SOCK), reads each
/// helper's PtyHello, and routes it to its pane's broker (created on first sight).
final class PtyHub {
    private let socketPath: String
    private let makeBroker: (String, Int, Int) -> PtyBroker
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var brokers: [String: PtyBroker] = [:]

    init(socketPath: String, makeBroker: @escaping (String, Int, Int) -> PtyBroker) {
        self.socketPath = socketPath; self.makeBroker = makeBroker
    }

    func broker(for paneID: String) -> PtyBroker? { lock.lock(); defer { lock.unlock() }; return brokers[paneID] }

    func start() -> Bool {
        unlink(socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { return false }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = socketPath.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 } }
        guard ok, listen(fd, 16) == 0 else { close(fd); return false }
        listenFD = fd
        Thread.detachNewThread { [weak self] in self?.acceptLoop(fd) }
        return true
    }

    func stop() {
        // Shut down then close the listen fd so a blocked accept() returns deterministically.
        if listenFD >= 0 { shutdown(listenFD, SHUT_RDWR); close(listenFD); listenFD = -1 }
        unlink(socketPath)
        lock.lock(); let bs = brokers.values; brokers.removeAll(); lock.unlock()
        bs.forEach { $0.close() }
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { if errno == EINTR { continue }; break }
            // A viewer's input write() to this helper fd runs on the broker's shared serial
            // queue; bound how long it can block if the inner program stops draining (else one
            // stalled helper freezes all viewer output for that pane). Mirror RemoteServer's
            // 10s viewer timeout. NOSIGPIPE so a dead peer returns EPIPE instead of killing us.
            var on: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var snd = timeval(tv_sec: 10, tv_usec: 0)
            setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &snd, socklen_t(MemoryLayout<timeval>.size))
            Thread.detachNewThread { [weak self] in guard let self else { close(c); return }; self.serveHelper(c) }
        }
    }

    private func serveHelper(_ fd: Int32) {
        let dec = DataFrameDecoder()
        var broker: PtyBroker?
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            if let b = broker {
                b.feedFromHelper(Array(buf[0..<n]))                          // raw after hello
                continue
            }
            // Pre-hello: feed one byte at a time so the frame decoder stops the instant the
            // ptyHello completes and never parses trailing raw PTY bytes (which arrive in the
            // same read once writes coalesce) as another frame — that would throw frameTooLarge
            // and lose the just-decoded hello.
            var i = 0
            while i < n, broker == nil {
                let msgs = (try? dec.feed(Data(buf[i...i]))) ?? []
                i += 1
                for case let .ptyHello(paneID, cols, rows) in msgs {
                    let b = makeBroker(paneID, cols, rows)
                    lock.lock(); brokers[paneID] = b; lock.unlock()
                    b.attachHelper(fd: fd)
                    broker = b
                }
            }
            if let b = broker, i < n { b.feedFromHelper(Array(buf[i..<n])) }  // rest of read = raw
        }
        if let b = broker {
            b.close()
            // Drop it from the registry so it doesn't linger holding its ring and lookupBroker
            // never hands back a dead broker. Identity-guard so a newer broker for the same pane
            // (a helper that reconnected) isn't clobbered.
            lock.lock(); if brokers[b.paneID] === b { brokers[b.paneID] = nil }; lock.unlock()
        }
    }
}
