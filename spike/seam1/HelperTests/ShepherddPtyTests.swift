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
