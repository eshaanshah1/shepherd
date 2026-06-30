import XCTest
import Darwin

/// Drives RemoteServer over loopback with a raw TCP client speaking the frame protocol.
final class RemoteServerTests: XCTestCase {

    // A tiny blocking TCP client + frame reader for tests.
    final class TestClient {
        let fd: Int32
        let dec = FrameDecoder()
        // Decoded-but-unmatched frames carried across waitFor calls, so a frame that
        // arrives coalesced with (or ahead of) the one a call is waiting on isn't lost.
        private var pending: [ControlMessage] = []
        // Set if dec.feed ever throws — i.e. the length-prefixed stream desynced
        // (a corrupt frame length from interleaved writes). Stays false on a clean stream.
        private(set) var decodeError = false
        init(port: UInt16) {
            fd = socket(AF_INET, SOCK_STREAM, 0)
            var on: Int32 = 1
            // Writing to a socket whose peer closed must return EPIPE, not raise SIGPIPE.
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
            _ = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        func send(_ msg: ControlMessage) { let d = try! FrameCodec.encode(msg); _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) } }
        /// Read until `predicate` matches a received message or timeout. Frames decoded
        /// but not matched are buffered for later calls — robust to TCP coalescing.
        func waitFor(_ timeout: TimeInterval = 3, _ predicate: (ControlMessage) -> Bool) -> ControlMessage? {
            if let i = pending.firstIndex(where: predicate) { return pending.remove(at: i) }
            let deadline = Date().addingTimeInterval(timeout)
            var buf = [UInt8](repeating: 0, count: 4096)
            while Date() < deadline {
                var tv = timeval(tv_sec: 0, tv_usec: 200_000)
                var set = fd_set(); withUnsafeMutablePointer(to: &set) { fdZero($0) }; fdSet(fd, &set)
                if select(fd + 1, &set, nil, nil, &tv) > 0 {
                    let n = read(fd, &buf, buf.count); if n <= 0 { break }
                    feed(Data(buf[0..<n]))
                    if let i = pending.firstIndex(where: predicate) { return pending.remove(at: i) }
                }
            }
            return nil
        }
        /// Decode bytes; flag a desync if the length-prefixed stream can't be parsed.
        private func feed(_ data: Data) {
            do { pending.append(contentsOf: try dec.feed(data)) }
            catch { decodeError = true }
        }
        /// Drain everything readable until `quiet` seconds pass with no new bytes,
        /// returning all frames decoded across this client's lifetime (including any
        /// buffered by waitFor). The window resets on every read so a long burst drains.
        func drainUntilQuiet(_ quiet: TimeInterval = 0.5) -> [ControlMessage] {
            var collected = pending; pending.removeAll()
            var buf = [UInt8](repeating: 0, count: 4096)
            var deadline = Date().addingTimeInterval(quiet)
            while Date() < deadline {
                var tv = timeval(tv_sec: 0, tv_usec: 100_000)
                var set = fd_set(); withUnsafeMutablePointer(to: &set) { fdZero($0) }; fdSet(fd, &set)
                if select(fd + 1, &set, nil, nil, &tv) > 0 {
                    let n = read(fd, &buf, buf.count); if n <= 0 { break }
                    feed(Data(buf[0..<n]))
                    collected.append(contentsOf: pending); pending.removeAll()
                    deadline = Date().addingTimeInterval(quiet)   // reset window on activity
                }
            }
            return collected
        }
        deinit { close(fd) }
    }

    private func makeServer(port: UInt16, approve: Bool, known: [PairedDevice] = [],
                            snapshot: @escaping () -> [PaneInfo] = {
                                [PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "working", reason: nil)]
                            }) -> RemoteServer {
        RemoteServer(
            bindAddress: "127.0.0.1", port: port,
            currentCode: { "8421" },
            knownDevices: { known },
            persist: { _ in },
            requestApproval: { _, _, decide in decide(approve) },
            snapshot: snapshot,
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" })
    }

    /// A fat snapshot (many panes) so the `accepted`+`snapshot` writes to a freshly
    /// admitted fd are a large, multi-syscall payload — the frame most likely to be
    /// spliced if writes to one fd weren't serialized. With the per-connection serial
    /// write queue it can never interleave with a concurrent broadcast to the same fd.
    private func fatSnapshot(_ count: Int = 1500) -> [PaneInfo] {
        (0..<count).map {
            PaneInfo(paneID: "pane-\($0)", title: "agent-\($0)-long-enough-title-to-bulk-up-the-frame-significantly",
                     workspace: "Workspace-\($0 % 8)", state: "working", reason: "running a tool with a verbose reason")
        }
    }

    func testPairWithGoodCodeApprovedReceivesSnapshot() {
        let port: UInt16 = 48721
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .accepted = $0 { return true }; return false }, "expected accepted")
        XCTAssertNotNil(c.waitFor { if case .snapshot(let p) = $0 { return p.first?.paneID == "p1" }; return false }, "expected snapshot")
    }

    func testWrongCodeRejected() {
        let port: UInt16 = 48722
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "0000",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .rejected = $0 { return true }; return false }, "expected rejected")
    }

    func testBroadcastReachesPairedClient() {
        let port: UInt16 = 48723
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        _ = c.waitFor { if case .snapshot = $0 { return true }; return false }
        server.broadcast(.state(paneID: "p1", state: "blocked", reason: "approve Bash"))
        let got = c.waitFor { if case .state = $0 { return true }; return false }
        XCTAssertEqual(got, .state(paneID: "p1", state: "blocked", reason: "approve Bash"))
    }

    /// Regression for the frame-interleave race (IMP#1). The hazard: two writers touching
    /// the SAME fd concurrently — `admit` writing a freshly-paired client's big
    /// accepted+snapshot while a `broadcast` from another thread writes a `state` delta to
    /// that same fd. A stream-socket write() isn't atomic for a multi-syscall payload, so
    /// without serialization the two splice together mid-frame, the length prefix goes
    /// wrong, and the peer's FrameDecoder desyncs permanently. Two writers also have no
    /// defined order, so a delta could land ahead of the snapshot.
    ///
    /// This asserts the INVARIANT the per-connection serial write queue guarantees, rather
    /// than chasing a timing repro: under a heavy burst of broadcasts fired from several
    /// threads at once (all enqueuing onto the one client's serial queue concurrently with
    /// its admit), the client (a) never desyncs, and (b) sees a coherent
    /// accepted → snapshot → state… sequence with every state frame well-formed. These
    /// hold deterministically with the fix; they were violated on the old direct-write
    /// code (a concurrent broadcast spliced the snapshot or jumped ahead of it).
    func testConcurrentBroadcastDuringPairingDoesNotCorruptStream() {
        let port: UInt16 = 48724
        let server = makeServer(port: port, approve: true, snapshot: { self.fatSnapshot() })
        XCTAssertTrue(server.start()); defer { server.stop() }

        let c = TestClient(port: port)
        var received: [ControlMessage] = []

        // Pair and wait for `accepted` — which proves admit has registered this fd as a
        // broadcast target AND that its big snapshot is already enqueued on the
        // connection's serial write queue (snapshot is enqueued right after accepted, both
        // under clientsLock). So every broadcast we now fire is guaranteed to target this
        // fd, racing the still-flushing snapshot and each other on the one serial queue.
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        if let acc = c.waitFor(5, { if case .accepted = $0 { return true }; return false }) { received.append(acc) }

        // Fire a burst of broadcasts from several threads at once — maximizing genuinely
        // concurrent broadcast() calls enqueuing onto this client's serial write queue. A
        // trailing sentinel (enqueued strictly last) marks the end of the stream so we
        // drain deterministically rather than guessing at timing.
        let perThread = 600, threads = 4
        let storm = DispatchGroup()
        for t in 0..<threads {
            DispatchQueue.global().async(group: storm) {
                for i in 0..<perThread {
                    server.broadcast(.state(paneID: "p1", state: "working", reason: "t\(t)-\(i)"))
                }
            }
        }
        XCTAssertEqual(storm.wait(timeout: .now() + 10), .success, "storm should finish enqueuing")
        server.broadcast(.state(paneID: "p1", state: "idle", reason: "END"))   // sentinel (enqueued last)

        // Drain until the sentinel arrives (or we time out / desync). Because the
        // connection's write queue is serial-FIFO, the sentinel — enqueued after every
        // other frame — arrives strictly last, so seeing it means we've read everything.
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            received.append(contentsOf: c.drainUntilQuiet(0.3))
            if c.decodeError { break }
            if received.contains(where: { if case .state(_, "idle", "END") = $0 { return true }; return false }) { break }
        }

        // (a) The stream never desynced.
        XCTAssertFalse(c.decodeError, "stream desynced — a concurrent write corrupted a frame")
        XCTAssertTrue(received.contains { if case .state(_, "idle", "END") = $0 { return true }; return false },
                      "never received the trailing sentinel — stream stalled or desynced")
        // (b) Coherent ordering: accepted, then a full uncorrupted snapshot, then every
        // state delta — relative order, since an unknown device first gets pendingApproval.
        let acceptedIdx = received.firstIndex { if case .accepted = $0 { return true }; return false }
        let snapshotIdx = received.firstIndex { if case .snapshot(let p) = $0 { return p.count == 1500 }; return false }
        let firstState  = received.firstIndex { if case .state = $0 { return true }; return false }
        XCTAssertNotNil(acceptedIdx, "expected accepted")
        XCTAssertNotNil(snapshotIdx, "expected a full, uncorrupted snapshot (1500 panes)")
        if let a = acceptedIdx, let s = snapshotIdx { XCTAssertLessThan(a, s, "accepted must precede snapshot") }
        if let s = snapshotIdx, let f = firstState { XCTAssertLessThan(s, f, "snapshot must precede any state delta") }
        // (c) Every delta arrived exactly once and intact. The client was a registered
        // broadcast target before the storm, so all threads*perThread deltas plus the
        // sentinel must be present — none lost, none duplicated, none spliced. (A spliced
        // frame would have thrown above as decodeError or decoded to garbage below.)
        let states = received.filter { if case .state = $0 { return true }; return false }
        XCTAssertEqual(states.count, threads * perThread + 1, "expected every delta + the sentinel, intact")
        for s in states {
            guard case let .state(paneID, st, reason) = s else { XCTFail("non-state frame"); continue }
            XCTAssertEqual(paneID, "p1", "corrupted paneID")
            XCTAssertTrue(st == "working" || st == "idle", "corrupted state: \(st)")
            XCTAssertTrue(reason == "END" || reason?.hasPrefix("t") == true,
                          "corrupted body \(String(describing: reason))")
        }
    }
}

// fd_set helpers (Swift can't use the FD_* macros directly).
private func fdZero(_ s: UnsafeMutablePointer<fd_set>) { bzero(s, MemoryLayout<fd_set>.size) }
private func fdSet(_ fd: Int32, _ s: inout fd_set) {
    let o = Int(fd) / 32, b = Int(fd) % 32
    withUnsafeMutablePointer(to: &s.fds_bits) {
        $0.withMemoryRebound(to: Int32.self, capacity: 32) { $0[o] |= Int32(1 << b) }
    }
}
