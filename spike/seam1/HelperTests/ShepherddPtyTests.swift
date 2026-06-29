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

        // Let the child install its trap, then resize the OUTER pty. The kernel
        // SIGWINCHes the helper (slave fg proc); the helper forwards to the inner
        // pty, which SIGWINCHes the child → its trap prints the new size.
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
