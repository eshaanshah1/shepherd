import XCTest
import Darwin

/// Drives PtyHub + PtyBroker over a real AF_UNIX loopback socket: a fake helper connects,
/// sends a ptyHello then raw bytes, and we assert the broker captured them in its ring.
final class DataChannelTests: XCTestCase {
    func testHelperAttachAndRingCapture() throws {
        let path = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: path, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start())
        defer { hub.stop() }

        let fd = try connectUnix(path)
        defer { close(fd) }
        try writeFrame(fd, .ptyHello(paneID: "paneX", cols: 100, rows: 30))
        writeRaw(fd, Array("hello-world".utf8))

        let broker = try waitFor { hub.broker(for: "paneX") }
        XCTAssertEqual(broker.cols, 100); XCTAssertEqual(broker.rows, 30)
        try waitUntil { broker.ringSnapshotForTest() == Array("hello-world".utf8) }
    }

    // MARK: - Task 4: nonce lifecycle

    func testNonceLifecycleViaLoopback() throws {
        let server = try makePairedLoopbackServer()
        defer { server.stop() }
        let (fd, nonce) = try pairAndGetNonce(server)
        XCTAssertTrue(server.hasLiveNonce(nonce))
        close(fd)                                        // control session drops
        try waitUntil { !server.hasLiveNonce(nonce) }    // nonce invalidated on close
    }

    // MARK: - Task 5: data-channel accept path

    func testDataChannelEndToEnd() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        // The phone attaches at the helper's current grid (90×25), so the idempotent setSize
        // emits no resize frame — this test isolates streaming + input framing.
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        // fake helper attaches + emits a screenful before any viewer is present
        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "paneY", cols: 90, rows: 25))
        writeRaw(helperFD, Array("PRE".utf8))                      // pre-attach → into ring
        // Wait until the ring has actually captured PRE so the viewer's replay is deterministic.
        try waitUntil { hub.broker(for: "paneY")?.ringSnapshotForTest() == Array("PRE".utf8) }

        // phone opens the data channel with the nonce
        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "paneY", cols: 90, rows: 25))
        let ready = try readOneDataMessage(dataFD)
        XCTAssertEqual(ready, .dataReady(cols: 90, rows: 25))
        XCTAssertEqual(try readRaw(dataFD, 3), Array("PRE".utf8))  // ring replay

        // live fan-out (raw, viewer direction) + input round-trip (framed, helper direction)
        writeRaw(helperFD, Array("LIVE".utf8))
        XCTAssertEqual(try readRaw(dataFD, 4), Array("LIVE".utf8))
        writeRaw(dataFD, Array("keys".utf8))
        let keyFrame = Array(HelperFrameCodec.encode(.input(Array("keys".utf8))))
        XCTAssertEqual(try readRaw(helperFD, keyFrame.count), keyFrame)
    }

    // MARK: - Phase 2: attach size + snap-back on detach

    func testDataChannelAppliesAttachSizeAndSnapsBack() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        // The pane the phone opens is always phone-owned; the broker launched at 80x24.
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "p1", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "p1") }

        let dataFD = try connectTCP(server.boundPort)
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "p1", cols: 40, rows: 30))

        // Attach applies the phone's size to the helper, and DataReady echoes it.
        let attach = Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30)))
        XCTAssertEqual(try readRaw(helperFD, attach.count), attach)
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataReady(cols: 40, rows: 30))

        // Detach releases the pane: the helper resumes sizing from its own outer PTY.
        close(dataFD)
        let release = Array(HelperFrameCodec.encode(.releaseSize))
        XCTAssertEqual(try readRaw(helperFD, release.count), release)
    }

    // MARK: - Phone drives size: attach resizes the pane, DataReady echoes the phone's grid

    func testAttachResizesPaneToPhoneGrid() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "p1", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "p1") }
        // The phone opens the pane at 40x30 → the broker resizes the helper to the phone grid
        // (the desktop no longer wins — the phone always drives the size while viewing).
        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "p1", cols: 40, rows: 30))
        let attach = Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30)))
        XCTAssertEqual(try readRaw(helperFD, attach.count), attach)
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataReady(cols: 40, rows: 30))  // phone grid
    }

    func testDataChannelRejectsBadNonce() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: "not-a-real-nonce", paneID: "paneY", cols: 80, rows: 24))
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataRejected(reason: "bad nonce"))
    }

    // MARK: - H5: control-channel resize reaches the helper (only for the phone's open pane)

    func testControlResizeReachesHelper() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "p1", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "p1") }

        // The phone must have p1 open (active) for a control resize to apply. Attach at the
        // helper's current grid so the attach emits no resize (idempotent), isolating the control one.
        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "p1", cols: 80, rows: 24))
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataReady(cols: 80, rows: 24))

        try writeControl(ctlFD, .resize(paneID: "p1", cols: 50, rows: 20))
        let frame = Array(HelperFrameCodec.encode(.resize(cols: 50, rows: 20)))
        XCTAssertEqual(try readRaw(helperFD, frame.count), frame)
    }

    // MARK: - Per-connection sizing: concurrently-viewed panes keep independent sizes

    func testTwoPanesKeepIndependentSizes() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        // Both panes launch at the 80x24 desktop grid.
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        let helperA = try connectUnix(ptyPath); defer { close(helperA) }
        try writeFrame(helperA, .ptyHello(paneID: "A", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "A") }
        let helperB = try connectUnix(ptyPath); defer { close(helperB) }
        try writeFrame(helperB, .ptyHello(paneID: "B", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "B") }

        // A client opens A at 40x30 → A resizes to 40x30.
        let dataA = try connectTCP(server.boundPort); defer { close(dataA) }
        try writeFrame(dataA, .dataHello(sessionNonce: nonce, paneID: "A", cols: 40, rows: 30))
        let attachA = Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30)))
        XCTAssertEqual(try readRaw(helperA, attachA.count), attachA)
        XCTAssertEqual(try readOneDataMessage(dataA), .dataReady(cols: 40, rows: 30))

        // It also opens B (a DIFFERENT size) while still holding A → B takes 44x28 and A is left
        // untouched (per-connection): sending a byte to A and reading it back proves no snap-back
        // resize was injected ahead of it — A kept its 40x30.
        let dataB = try connectTCP(server.boundPort); defer { close(dataB) }
        try writeFrame(dataB, .dataHello(sessionNonce: nonce, paneID: "B", cols: 44, rows: 28))
        let attachB = Array(HelperFrameCodec.encode(.resize(cols: 44, rows: 28)))
        XCTAssertEqual(try readRaw(helperB, attachB.count), attachB)
        writeRaw(dataA, Array("x".utf8))
        let keyA = Array(HelperFrameCodec.encode(.input(Array("x".utf8))))
        XCTAssertEqual(try readRaw(helperA, keyA.count), keyA)   // no resize precedes it → A untouched

        // Each pane releases back to the desktop only when ITS OWN last viewer detaches.
        close(dataA)
        let release = Array(HelperFrameCodec.encode(.releaseSize))
        XCTAssertEqual(try readRaw(helperA, release.count), release)
    }

    // MARK: - C1: a data channel must not outlive its control session

    func testDataChannelClosesWhenControlSessionDrops() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server)

        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "paneZ", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "paneZ") }

        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "paneZ", cols: 80, rows: 24))
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataReady(cols: 80, rows: 24))

        // Drop the control session: the nonce is revoked AND the open data channel is torn down.
        close(ctlFD)
        try waitUntil { !server.hasLiveNonce(nonce) }
        try expectEOF(dataFD)
    }

    // MARK: - I3: pane close (helper EOF) tears the viewer down without a double-close

    func testDataChannelClosesWhenHelperExits() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        let helperFD = try connectUnix(ptyPath)
        try writeFrame(helperFD, .ptyHello(paneID: "paneH", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "paneH") }

        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "paneH", cols: 80, rows: 24))
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataReady(cols: 80, rows: 24))

        // Close the helper (pane closed): broker.close() SHUT_RDWRs the viewer, serveDataChannel
        // does the sole close — the viewer socket reaches EOF and nothing double-closes.
        close(helperFD)
        try expectEOF(dataFD)
    }

    // MARK: - I2: broker is removed from the hub on helper EOF (no leak / dead reattach)

    func testBrokerRemovedFromHubOnHelperEOF() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }

        let helperFD = try connectUnix(ptyPath)
        try writeFrame(helperFD, .ptyHello(paneID: "paneQ", cols: 80, rows: 24))
        _ = try waitFor { hub.broker(for: "paneQ") }

        close(helperFD)                                       // helper disconnects (EOF)
        try waitUntil { hub.broker(for: "paneQ") == nil }     // broker dropped, not lingering
    }

    // --- helpers (loopback plumbing) ---

    /// Start a RemoteServer on an ephemeral 127.0.0.1 port that auto-approves pairing and
    /// mints a unique nonce per session. `lookupBroker` defaults to none (control-only tests).
    func makePairedLoopbackServer(lookupBroker: @escaping (String) -> PtyBroker? = { _ in nil }) throws -> RemoteServer {
        let server = RemoteServer(
            bindAddress: "127.0.0.1", port: 0,
            knownDevices: { [] },
            persist: { _ in },
            requestApproval: { _, _, decide in decide(true) },
            workspaceTrees: { [] },
            updateFCMToken: { _, _ in },
            makeSecret: { "SECRET" },
            makeNonce: { UUID().uuidString },
            verifyPeer: { _ in VerifiedPeer(userID: "u1", name: "Pixel") },
            selfUserID: { "u1" },
            lookupBroker: lookupBroker)
        XCTAssertTrue(server.start())
        return server
    }

    /// Pair a fresh TCP control client (good code, auto-approved), returning the live fd and
    /// the accepted sessionNonce.
    func pairAndGetNonce(_ server: RemoteServer) throws -> (Int32, String) {
        let fd = try connectTCP(server.boundPort)
        try writeControl(fd, .hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                                    secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if case let .accepted(nonce) = try readOneControlMessage(fd) { return (fd, nonce) }
        }
        throw TestErr.timeout
    }

    func connectTCP(_ port: UInt16) throws -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 0, tv_usec: 100_000)   // periodic read wakeups for deadline checks
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        XCTAssertEqual(r, 0, "connectTCP errno \(errno)")
        return fd
    }

    func writeControl(_ fd: Int32, _ m: ControlMessage) throws {
        let d = try FrameCodec.encode(m); _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) }
    }

    /// Read exactly `n` bytes (one length-prefix or one body at a time — never over-reads).
    func readRaw(_ fd: Int32, _ n: Int, timeout: TimeInterval = 3) throws -> [UInt8] {
        var out = [UInt8](); out.reserveCapacity(n)
        var buf = [UInt8](repeating: 0, count: max(1, n))
        let deadline = Date().addingTimeInterval(timeout)
        while out.count < n {
            let r = read(fd, &buf, n - out.count)
            if r > 0 { out.append(contentsOf: buf[0..<r]); continue }
            if r == 0 { XCTFail("readRaw eof at \(out.count)/\(n)"); throw TestErr.timeout }
            if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK {
                if Date() > deadline { XCTFail("readRaw timed out at \(out.count)/\(n)"); throw TestErr.timeout }
                continue
            }
            XCTFail("readRaw errno \(errno)"); throw TestErr.timeout
        }
        return out
    }

    /// Assert `fd` reaches EOF (read returns 0, or a hard error) within `timeout`, tolerating
    /// the periodic SO_RCVTIMEO wakeups (EAGAIN) the loopback client sets.
    func expectEOF(_ fd: Int32, timeout: TimeInterval = 3) throws {
        var buf = [UInt8](repeating: 0, count: 256)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let r = read(fd, &buf, buf.count)
            if r == 0 { return }                                              // clean EOF
            if r > 0 { continue }                                             // drain any stray bytes
            if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }
            return                                                            // other error ⇒ also closed
        }
        XCTFail("socket never reached EOF")
    }

    func readOneDataMessage(_ fd: Int32) throws -> DataMessage {
        let lenBytes = try readRaw(fd, 4)
        let len = lenBytes.withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
        return try JSONDecoder().decode(DataMessage.self, from: Data(try readRaw(fd, len)))
    }

    func readOneControlMessage(_ fd: Int32) throws -> ControlMessage {
        let lenBytes = try readRaw(fd, 4)
        let len = lenBytes.withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
        return try JSONDecoder().decode(ControlMessage.self, from: Data(try readRaw(fd, len)))
    }

    enum TestErr: Error { case timeout }

    // --- helpers (loopback plumbing) ---
    func connectUnix(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(r, 0, "connect errno \(errno)")
        return fd
    }
    func writeFrame(_ fd: Int32, _ m: DataMessage) throws {
        let d = try DataFrameCodec.encode(m); _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) }
    }
    func writeRaw(_ fd: Int32, _ bytes: [UInt8]) { var b = bytes; _ = write(fd, &b, b.count) }
    func waitFor<T>(_ f: () -> T?, timeout: TimeInterval = 2) throws -> T {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if let v = f() { return v }; usleep(10_000) }
        throw XCTSkip("timed out")
    }
    func waitUntil(_ cond: () -> Bool, timeout: TimeInterval = 2) throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if cond() { return }; usleep(10_000) }
        XCTFail("condition never held")
    }
}
