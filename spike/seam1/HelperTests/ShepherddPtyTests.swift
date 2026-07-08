import XCTest
import Darwin

/// Drives the built `shepherdd` binary through a PTY this test owns, asserting
/// the wrapper is byte-transparent and tty-faithful.
final class ShepherddPtyTests: XCTestCase {

    private func helperURL() -> URL {
        // The tool product lands beside this test bundle in the Products dir.
        Bundle(for: type(of: self)).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("shepherdd")
    }

    /// Runs `shepherdd <args>`, optionally feeding `input`, with the given pane
    /// size. Returns (stdout-as-string, exit-code).
    private func run(_ args: [String], input: String = "",
                     cols: UInt16 = 80, rows: UInt16 = 24,
                     timeout: TimeInterval = 8) -> (String, Int32) {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = args
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = slaveHandle
        proc.standardOutput = slaveHandle
        proc.standardError = slaveHandle
        do { try proc.run() } catch { XCTFail("launch \(helperURL().path): \(error)"); return ("", -1) }
        close(slave)                                  // the helper owns the slave now

        if !input.isEmpty { _ = input.withCString { write(master, $0, strlen($0)) } }

        // Read master until the helper exits and the pty drains (EIO == EOF here).
        var out = Data()
        let deadline = Date().addingTimeInterval(timeout)
        var buf = [UInt8](repeating: 0, count: 4096)
        while Date() < deadline {
            var pfd = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            let r = poll(&pfd, 1, 200)
            if r > 0 {
                let n = read(master, &buf, buf.count)
                if n > 0 { out.append(contentsOf: buf[0..<n]) } else { break }   // 0/-1 (EIO) → done
            } else if !proc.isRunning && r == 0 { break }
        }
        proc.waitUntilExit()
        close(master)
        return (String(decoding: out, as: UTF8.self), proc.terminationStatus)
    }

    func testHelperDecodesInputAndResizeFrames() {
        // input "hi"
        var buf: [UInt8] = [0,0,0,3, 0x00, 0x68, 0x69,
                            // resize 40x30
                            0,0,0,5, 0x01, 0,40, 0,30]
        let frames = decodeHelperFrames(&buf)
        XCTAssertEqual(frames.count, 2)
        XCTAssertFalse(frames[0].isResize); XCTAssertEqual(frames[0].bytes, [0x68,0x69])
        XCTAssertTrue(frames[1].isResize); XCTAssertEqual(frames[1].cols, 40); XCTAssertEqual(frames[1].rows, 30)
        XCTAssertTrue(buf.isEmpty)   // fully consumed
    }

    func testPassesChildOutputThrough() {
        let (out, code) = run(["pty", "--", "/bin/echo", "shepherd-marker"])
        XCTAssertTrue(out.contains("shepherd-marker"), "got: \(out)")
        XCTAssertEqual(code, 0)
    }

    func testChildSeesARealTTY() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "test -t 0 && echo ISATTY"])
        XCTAssertTrue(out.contains("ISATTY"), "child stdin was not a tty; got: \(out)")
    }

    func testInitialWindowSizePropagates() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "stty size"], cols: 123, rows: 45)
        XCTAssertTrue(out.contains("45 123"), "stty size mismatch; got: \(out)")
    }

    func testExitStatusPropagates() {
        let (_, code) = run(["pty", "--", "/bin/sh", "-c", "exit 7"])
        XCTAssertEqual(code, 7)
    }

    func testInputReachesChild() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "read x; echo got:$x"], input: "hi\n")
        XCTAssertTrue(out.contains("got:hi"), "input not delivered; got: \(out)")
    }
}

extension ShepherddPtyTests {
    func testLiveResizePropagatesToChild() {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        // Re-emit our size whenever the window changes, for ~3s.
        proc.arguments = ["pty", "--", "/bin/sh", "-c", "trap 'stty size' WINCH; sleep 3"]
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)

        // Let the child install its trap, then resize the OUTER pty. The helper
        // forwards the new size to the inner pty, which SIGWINCHes the child → its
        // trap prints it. (Signal delivery to the helper is handled below.)
        usleep(700_000)
        var bigger = winsize(ws_row: 45, ws_col: 123, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(pty_set_winsize(master, &bigger), 0, "resize")
        // In production libghostty owns the outer tty, so the kernel SIGWINCHes
        // the helper on resize. Under XCTest the helper has no controlling tty
        // (tcgetpgrp(master) == 0), so deliver the signal the kernel would.
        kill(proc.processIdentifier, SIGWINCH)

        var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            var pfd = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 200) > 0 {
                let n = read(master, &buf, buf.count)
                if n > 0 { out.append(contentsOf: buf[0..<n]); if String(decoding: out, as: UTF8.self).contains("45 123") { break } }
                else { break }
            }
        }
        proc.terminate(); proc.waitUntilExit(); close(master)
        XCTAssertTrue(String(decoding: out, as: UTF8.self).contains("45 123"),
                      "resize did not reach child; got: \(String(decoding: out, as: UTF8.self))")
    }
}

extension ShepherddPtyTests {
    // Regression: the helper must put its controlling (outer) tty into raw mode,
    // or the outer PTY's line discipline echoes + line-cooks input — breaking
    // arrow keys, bracketed paste, Ctrl-C, and live syntax highlighting in the
    // wrapped shell. We silence the INNER pty (stty -echo -icanon) before probing,
    // so any echo we then observe can only be the OUTER pty's.
    func testOuterTTYIsRawSoInputIsNotEchoed() {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = ["pty", "--", "/bin/sh", "-c", "stty -echo -icanon; sleep 2"]
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)

        // Let the inner `stty -echo` take effect, THEN probe. Any echo of the
        // probe now can only come from the OUTER pty's line discipline.
        usleep(700_000)
        let probe = "ECHOPROBE\n"
        _ = probe.withCString { write(master, $0, strlen($0)) }

        var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline {
            var pfd = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 200) > 0 {
                let n = read(master, &buf, buf.count)
                if n > 0 { out.append(contentsOf: buf[0..<n]) } else { break }
            }
        }
        proc.terminate(); proc.waitUntilExit(); close(master)
        XCTAssertFalse(String(decoding: out, as: UTF8.self).contains("ECHOPROBE"),
                       "outer PTY echoed input → helper didn't set raw mode; got: \(String(decoding: out, as: UTF8.self))")
    }
}

extension ShepherddPtyTests {
    // The tap: with $SHEPHERD_PTY_SOCK pointed at a listener the test owns, the helper
    // dials in, sends a ptyHello frame, mirrors inner output to the socket, and injects
    // bytes written to the socket into the inner PTY.

    /// Bind + listen on a unix socket at `path`; return the listening fd.
    private func startUnixListener(_ path: String) throws -> Int32 {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0, "socket()")
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let br = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(br, 0, "bind(\(path)) errno=\(errno)")
        XCTAssertEqual(listen(fd, 4), 0, "listen")
        return fd
    }

    /// A loopback TCP listener on an OS-assigned port. Returns (listenFD, port).
    private func startTCPListener() throws -> (Int32, UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0, "socket()")
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET); addr.sin_port = 0
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let br = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        XCTAssertEqual(br, 0, "bind errno=\(errno)")
        XCTAssertEqual(listen(fd, 4), 0, "listen")
        var actual = sockaddr_in(); var alen = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &alen) } }
        return (fd, UInt16(bigEndian: actual.sin_port))
    }

    /// Write a `[u32 BE len][json]` frame to `fd`.
    private func writeFrameJSON(_ fd: Int32, _ json: String) {
        let jd = Array(json.utf8)
        var frame: [UInt8] = [UInt8((jd.count >> 24) & 0xff), UInt8((jd.count >> 16) & 0xff),
                              UInt8((jd.count >> 8) & 0xff), UInt8(jd.count & 0xff)]
        frame.append(contentsOf: jd); writeRaw(fd, frame)
    }

    /// Read one `[u32 BE len][json]` frame off `fd`, returning the JSON string.
    private func readOneFrameString(_ fd: Int32, timeout: TimeInterval = 5) -> String {
        var acc = [UInt8](); let deadline = Date().addingTimeInterval(timeout)
        func need(_ k: Int) -> Bool {
            while acc.count < k, Date() < deadline {
                var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&pfd, 1, 200) > 0 { var b = [UInt8](repeating: 0, count: 4096); let n = read(fd, &b, b.count); if n > 0 { acc.append(contentsOf: b[0..<n]) } else { break } }
            }
            return acc.count >= k
        }
        guard need(4) else { return "" }
        let len = (Int(acc[0]) << 24) | (Int(acc[1]) << 16) | (Int(acc[2]) << 8) | Int(acc[3])
        guard need(4 + len) else { return "" }
        return String(decoding: acc[4..<(4 + len)], as: UTF8.self)
    }

    /// Accept one connection within `timeout`, or fail.
    private func acceptOne(_ listenFD: Int32, timeout: TimeInterval = 5) throws -> Int32 {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var pfd = pollfd(fd: listenFD, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 200) > 0 {
                let c = accept(listenFD, nil, nil)
                if c >= 0 { return c }
            }
        }
        XCTFail("helper never dialed in"); return -1
    }

    /// Read the first `[u32 BE len][json]` frame off `fd` and parse its JSON,
    /// returning the inner `ptyHello` object as a dictionary.
    private func readOnePtyHelloJSON(_ fd: Int32, timeout: TimeInterval = 5) throws -> [String: Any] {
        var acc = [UInt8]()
        let deadline = Date().addingTimeInterval(timeout)
        func needBytes(_ k: Int) -> Bool {
            while acc.count < k, Date() < deadline {
                var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&pfd, 1, 200) > 0 {
                    var b = [UInt8](repeating: 0, count: 4096)
                    let n = read(fd, &b, b.count)
                    if n > 0 { acc.append(contentsOf: b[0..<n]) } else { break }
                }
            }
            return acc.count >= k
        }
        guard needBytes(4) else { XCTFail("no frame header"); return [:] }
        let len = (UInt32(acc[0]) << 24) | (UInt32(acc[1]) << 16) | (UInt32(acc[2]) << 8) | UInt32(acc[3])
        guard needBytes(4 + Int(len)) else { XCTFail("frame body truncated"); return [:] }
        let json = Data(acc[4..<(4 + Int(len))])
        let obj = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
        return (obj?["ptyHello"] as? [String: Any]) ?? [:]
    }

    /// True if `fd` yields bytes containing `needle` within `timeout`.
    private func sees(_ fd: Int32, contains needle: String, timeout: TimeInterval = 5) -> Bool {
        var acc = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 200) > 0 {
                let n = read(fd, &buf, buf.count)
                if n > 0 { acc.append(contentsOf: buf[0..<n]); if String(decoding: acc, as: UTF8.self).contains(needle) { return true } }
                else { break }
            }
        }
        return false
    }

    private func writeRaw(_ fd: Int32, _ bytes: [UInt8]) {
        var b = bytes; _ = b.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
    }

    func testHelperStreamsAndInjectsOverPtySock() throws {
        let path = NSTemporaryDirectory() + "shep-pty-t-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let listenFD = try startUnixListener(path)
        defer { close(listenFD); unlink(path) }

        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = ["pty", "--", "/bin/cat"]
        var env = ProcessInfo.processInfo.environment
        env["SHEPHERD_PTY_SOCK"] = path
        env["SHEPHERD_TAB_ID"] = "paneZ"
        proc.environment = env
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)
        defer { proc.terminate(); proc.waitUntilExit(); close(master) }

        let conn = try acceptOne(listenFD)
        defer { close(conn) }
        let hello = try readOnePtyHelloJSON(conn)
        XCTAssertEqual(hello["paneID"] as? String, "paneZ")

        writeRaw(master, Array("abc\n".utf8))                         // user types into the pane
        XCTAssertTrue(sees(conn, contains: "abc"), "cat echo not mirrored to socket")

        // Phone input is now framed (HelperFrame.input): [u32 BE len][0x00][raw bytes].
        let payload = Array("xyz\n".utf8)
        var frame: [UInt8] = [0, 0, 0, UInt8(payload.count + 1), 0x00]
        frame.append(contentsOf: payload)
        writeRaw(conn, frame)                                         // phone input via socket
        XCTAssertTrue(sees(master, contains: "xyz"), "socket input not injected into inner PTY")
    }

    // MARK: - attach: client-side raw PTY pipe

    func testAttachHandshakesThenPipesRawBothWays() throws {
        let (listenFD, port) = try startTCPListener()
        defer { close(listenFD) }

        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 30, ws_col: 40, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = ["attach"]
        var env = ProcessInfo.processInfo.environment
        env["SHEPHERD_ATTACH_HOST"] = "127.0.0.1"
        env["SHEPHERD_ATTACH_PORT"] = String(port)
        env["SHEPHERD_ATTACH_NONCE"] = "nonce-1"
        env["SHEPHERD_ATTACH_PANE"] = "paneR"
        proc.environment = env
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)
        defer { proc.terminate(); proc.waitUntilExit(); close(master) }

        let conn = try acceptOne(listenFD)
        defer { close(conn) }

        // Handshake: attach sends dataHello (with its 40x30 grid + nonce/pane), we reply dataReady.
        let hello = readOneFrameString(conn)
        XCTAssertTrue(hello.contains("\"dataHello\""), "expected dataHello, got: \(hello)")
        XCTAssertTrue(hello.contains("\"paneID\":\"paneR\""))
        XCTAssertTrue(hello.contains("\"nonce-1\""))
        XCTAssertTrue(hello.contains("\"cols\":40") && hello.contains("\"rows\":30"), "initial size in dataHello")
        writeFrameJSON(conn, "{\"dataReady\":{\"cols\":40,\"rows\":30}}")

        // Raw duplex: client stdin → socket; socket → client stdout.
        writeRaw(master, Array("type-this\n".utf8))
        XCTAssertTrue(sees(conn, contains: "type-this"), "stdin not forwarded to socket")
        writeRaw(conn, Array("HOST-OUTPUT".utf8))
        XCTAssertTrue(sees(master, contains: "HOST-OUTPUT"), "socket bytes not written to stdout")
    }

    func testAttachExitsWhenHostRejects() throws {
        let (listenFD, port) = try startTCPListener()
        defer { close(listenFD) }
        let (out, code) = runAttach(port: port, expectAccept: false, on: listenFD)
        XCTAssertNotEqual(code, 0, "attach must exit non-zero on rejection; stdout=\(out)")
    }

    /// Spawn `shepherdd attach` against `port`; if `expectAccept` is false, reply dataRejected.
    private func runAttach(port: UInt16, expectAccept: Bool, on listenFD: Int32) -> (String, Int32) {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0)
        let proc = Process(); proc.executableURL = helperURL(); proc.arguments = ["attach"]
        var env = ProcessInfo.processInfo.environment
        env["SHEPHERD_ATTACH_HOST"] = "127.0.0.1"; env["SHEPHERD_ATTACH_PORT"] = String(port)
        env["SHEPHERD_ATTACH_NONCE"] = "n"; env["SHEPHERD_ATTACH_PANE"] = "p"
        proc.environment = env
        let hh = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = hh; proc.standardOutput = hh; proc.standardError = hh
        try? proc.run(); close(slave)
        if let conn = try? acceptOne(listenFD) {
            _ = readOneFrameString(conn)
            writeFrameJSON(conn, expectAccept ? "{\"dataReady\":{\"cols\":80,\"rows\":24}}"
                                              : "{\"dataRejected\":{\"reason\":\"bad nonce\"}}")
            if !expectAccept { close(conn) }
        }
        proc.waitUntilExit(); close(master)
        return ("", proc.terminationStatus)
    }

    // Regression: the tap is strictly non-load-bearing. When the app closes the helper's
    // tap socket mid-session, the tap fd goes to persistent-readable EOF — the pump must
    // retire that fd (no busy-spin) and the LOCAL terminal must keep working exactly as M0.
    func testLocalTerminalSurvivesTapClose() throws {
        let path = NSTemporaryDirectory() + "shep-pty-death-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let listenFD = try startUnixListener(path)
        defer { close(listenFD); unlink(path) }

        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = ["pty", "--", "/bin/cat"]
        var env = ProcessInfo.processInfo.environment
        env["SHEPHERD_PTY_SOCK"] = path
        env["SHEPHERD_TAB_ID"] = "paneDeath"
        proc.environment = env
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)
        defer { proc.terminate(); proc.waitUntilExit(); close(master) }

        let conn = try acceptOne(listenFD)
        _ = try readOnePtyHelloJSON(conn)

        // Sanity: the tap is live and mirroring.
        writeRaw(master, Array("before\n".utf8))
        XCTAssertTrue(sees(conn, contains: "before"), "tap not mirroring before close")

        // The app drops the tap socket mid-session.
        close(conn)
        usleep(300_000)          // let the helper observe EOF and retire the tap slot

        // The key guarantee: the local terminal still round-trips through the inner PTY.
        writeRaw(master, Array("survive\n".utf8))
        XCTAssertTrue(sees(master, contains: "survive"),
                      "local terminal stopped echoing after the tap died — tap was load-bearing")
    }
}

extension ShepherddPtyTests {
    // Regression: when libghostty kills the pane it closes the OUTER pty. The helper
    // must tear down — break its pump AND hang up the inner shell — instead of
    // blocking in waitpid on a child that has no reason to exit. Otherwise the helper
    // and the shell leak as orphans.
    func testClosingOuterPTYTearsDownHelper() {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = ["pty", "--", "/bin/sh", "-c", "sleep 30"]
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)

        usleep(300_000)          // let it settle into the pump
        close(master)            // libghostty closing the pane / window

        // The helper must exit promptly, not block in waitpid on the live `sleep`.
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline && proc.isRunning { usleep(50_000) }
        let exited = !proc.isRunning
        if !exited { proc.terminate() }
        proc.waitUntilExit()
        XCTAssertTrue(exited, "helper did not exit after its outer PTY closed — orphaned")
    }
}
