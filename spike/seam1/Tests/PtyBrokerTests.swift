import XCTest
import Darwin

final class PtyBrokerFramingTests: XCTestCase {
    /// Read whatever the broker's serial write queue has flushed to `fd`, up to `count`
    /// bytes per read, stopping once the socket goes idle after delivering data.
    private func readAvailable(_ fd: Int32, count: Int, timeout: TimeInterval = 1.0) -> [UInt8] {
        var out = [UInt8]()
        var buf = [UInt8](repeating: 0, count: count)
        let deadline = Date().addingTimeInterval(timeout)
        var idleAfterData = 0
        while Date() < deadline {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let r = poll(&pfd, 1, 100)
            if r > 0 {
                let n = read(fd, &buf, count)
                if n > 0 { out.append(contentsOf: buf[0..<n]); idleAfterData = 0; continue }
                if n == 0 { break }
            } else if r == 0, !out.isEmpty {
                idleAfterData += 1; if idleAfterData >= 2 { break }
            }
        }
        return out
    }

    func testBrokerFramesInputAndResizeToHelper() throws {
        var fds = [Int32](repeating: 0, count: 2); socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
        defer { close(fds[1]) }
        let b = PtyBroker(paneID: "p1", cols: 80, rows: 24)
        b.attachHelper(fd: fds[0])
        b.inputFromViewer([0x61])
        b.setSize(cols: 40, rows: 30)
        let got = readAvailable(fds[1], count: 64)
        XCTAssertEqual(got, Array(HelperFrameCodec.encode(.input([0x61]))) + Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30))))
        XCTAssertEqual(b.cols, 40); XCTAssertEqual(b.rows, 30)
    }

    func testReleaseSizeFramesReleaseAndRestoresDesktopGrid() throws {
        var fds = [Int32](repeating: 0, count: 2); socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
        defer { close(fds[1]) }
        let b = PtyBroker(paneID: "p1", cols: 80, rows: 24)   // desktop grid = 80x24
        b.attachHelper(fd: fds[0])
        b.setSize(cols: 40, rows: 30)                          // a viewer sized it down
        b.releaseSize()                                        // last viewer left → release
        let got = readAvailable(fds[1], count: 64)
        XCTAssertEqual(got, Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30)))
                          + Array(HelperFrameCodec.encode(.releaseSize)))
        XCTAssertEqual(b.cols, 80); XCTAssertEqual(b.rows, 24)  // broker record back at the desktop grid
    }
}

final class PtyRingTests: XCTestCase {
    func testAppendUnderCapKeepsEverythingInOrder() {
        var r = PtyRing(cap: 16)
        r.append(Array("abc".utf8)); r.append(Array("def".utf8))
        XCTAssertEqual(r.snapshot(), Array("abcdef".utf8))
        XCTAssertEqual(r.count, 6)
    }

    func testAppendOverCapEvictsOldest() {
        var r = PtyRing(cap: 4)
        r.append(Array("abcdef".utf8))          // only last 4 survive
        XCTAssertEqual(r.snapshot(), Array("cdef".utf8))
        XCTAssertEqual(r.count, 4)
    }

    func testAppendAcrossBoundaryEvictsAcrossCalls() {
        var r = PtyRing(cap: 4)
        r.append(Array("ab".utf8)); r.append(Array("cde".utf8))  // "abcde" → last 4 = "bcde"
        XCTAssertEqual(r.snapshot(), Array("bcde".utf8))
    }

    func testSingleAppendLargerThanCapKeepsTail() {
        var r = PtyRing(cap: 3)
        r.append(Array("abcdefgh".utf8))
        XCTAssertEqual(r.snapshot(), Array("fgh".utf8))
    }
}
