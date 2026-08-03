import XCTest
@testable import Shepherd

/// The formatting is the whole value of the log: a line without a millisecond timestamp
/// cannot be correlated against a packet capture, which is exactly what this file exists
/// to make possible.
final class LogTests: XCTestCase {
    private func date(_ m: Int, _ d: Int, _ h: Int, _ min: Int, _ s: Int, ms: Int) -> Date {
        var c = DateComponents()
        c.year = 2026; c.month = m; c.day = d; c.hour = h; c.minute = min; c.second = s
        c.nanosecond = ms * 1_000_000
        return Calendar.current.date(from: c)!
    }

    func testFormatCarriesStampLevelCategoryAndMessage() {
        let line = ShepherdLog.format(.info, .lan, "listening on 0.0.0.0:8723",
                                      at: date(8, 3, 11, 6, 1, ms: 295))
        XCTAssertTrue(line.hasPrefix("08-03 11:06:01.295 "), line)
        XCTAssertTrue(line.contains("INFO"), line)
        XCTAssertTrue(line.contains("lan"), line)
        XCTAssertTrue(line.hasSuffix("listening on 0.0.0.0:8723"), line)
    }

    /// Milliseconds are the point — a whole-second stamp cannot be lined up with tcpdump.
    func testFormatKeepsMilliseconds() {
        let line = ShepherdLog.format(.error, .remote, "x", at: date(1, 9, 4, 5, 6, ms: 7))
        XCTAssertTrue(line.contains("04:05:06.007"), line)
    }

    /// Columns must not shift between levels, or grep and the eye both suffer.
    func testMessageColumnIsStableAcrossLevels() {
        let at = date(8, 3, 11, 6, 1, ms: 295)
        let offsets = [LogLevel.debug, .info, .warn, .error].map { lvl -> Int in
            let line = ShepherdLog.format(lvl, .lan, "MSG", at: at)
            return line.distance(from: line.startIndex, to: line.range(of: "MSG")!.lowerBound)
        }
        XCTAssertEqual(Set(offsets).count, 1, "message column moved: \(offsets)")
    }

    func testCategoryPaddingDoesNotTruncateTheLongestCategory() {
        let line = ShepherdLog.format(.info, .worktree, "M", at: date(8, 3, 1, 1, 1, ms: 0))
        XCTAssertTrue(line.contains("worktree"), line)
    }

    func testLevelOrdering() {
        XCTAssertTrue(LogLevel.debug < .info)
        XCTAssertTrue(LogLevel.info < .warn)
        XCTAssertTrue(LogLevel.warn < .error)
    }

    /// A typo in the config must not silence the log.
    func testLevelParseDefaultsToInfo() {
        XCTAssertEqual(LogLevel.parse("debug"), .debug)
        XCTAssertEqual(LogLevel.parse("DEBUG"), .debug)
        XCTAssertEqual(LogLevel.parse(" warn "), .warn)
        XCTAssertEqual(LogLevel.parse("warning"), .warn)
        XCTAssertEqual(LogLevel.parse("error"), .error)
        XCTAssertEqual(LogLevel.parse(nil), .info)
        XCTAssertEqual(LogLevel.parse("chatty"), .info)
    }

    func testRotationDecision() {
        XCTAssertFalse(ShepherdLog.shouldRotate(size: 0, cap: 100))
        XCTAssertFalse(ShepherdLog.shouldRotate(size: 99, cap: 100))
        XCTAssertTrue(ShepherdLog.shouldRotate(size: 100, cap: 100))
        XCTAssertTrue(ShepherdLog.shouldRotate(size: 1_000, cap: 100))
    }

    /// End-to-end through the real file path: a log nobody can read is not a log.
    func testWritesAndRotatesOnDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shepherd-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("events.log").path

        let log = ShepherdLog(path: path)
        log.write(.error, .lan, "first line")
        log.write(.error, .lan, "second line")
        // The write queue is async; give it a moment to drain.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if let t = try? String(contentsOfFile: path), t.contains("second line") { break }
            usleep(20_000)
        }
        let text = try String(contentsOfFile: path)
        XCTAssertTrue(text.contains("first line"), text)
        XCTAssertTrue(text.contains("second line"), text)
        XCTAssertEqual(text.split(separator: "\n").count, 2, text)
    }

    /// Below-level lines must not reach the file at all.
    func testLevelFiltersWrites() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shepherd-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("events.log").path

        let log = ShepherdLog(path: path)   // default .info
        log.write(.debug, .lan, "chatter")
        log.write(.warn, .lan, "kept")
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if let t = try? String(contentsOfFile: path), t.contains("kept") { break }
            usleep(20_000)
        }
        let text = (try? String(contentsOfFile: path)) ?? ""
        XCTAssertTrue(text.contains("kept"), text)
        XCTAssertFalse(text.contains("chatter"), text)
    }
}

/// The shim regression: a symlink to a deleted build is not "installed", and treating it as
/// installed is what let `shepherd` resolve to the GUI binary instead.
final class CLIShimTests: XCTestCase {
    private let want = "/Applications/Shepherd.app/Contents/MacOS/shepherdd"

    func testMissingWhenNothingIsThere() {
        let s = CLIShim.state(linkTarget: nil, pathExists: false, targetIsPresent: { _ in false }, want: want)
        XCTAssertEqual(s, .missing)
        XCTAssertTrue(s.shouldInstall)
    }

    func testCurrentWhenAlreadyOurs() {
        let s = CLIShim.state(linkTarget: want, pathExists: true, targetIsPresent: { _ in true }, want: want)
        XCTAssertEqual(s, .current)
        XCTAssertFalse(s.shouldInstall)
    }

    /// The exact state this machine was in: a link into a build directory that was deleted.
    func testDanglingLinkIsRepairable() {
        let dead = "/Users/x/checkout/build/Build/Products/Debug/Shepherd.app/Contents/MacOS/shepherdd"
        let s = CLIShim.state(linkTarget: dead, pathExists: true,
                             targetIsPresent: { _ in false }, want: want)
        XCTAssertEqual(s, .dangling(target: dead))
        XCTAssertTrue(s.shouldInstall, "a dangling shim must be repaired, not left to shadow PATH")
    }

    /// Someone else's working link is their business — same rule as the plugin installer.
    func testForeignButLiveLinkIsLeftAlone() {
        let other = "/Users/x/other/shepherdd"
        let s = CLIShim.state(linkTarget: other, pathExists: true,
                             targetIsPresent: { _ in true }, want: want)
        XCTAssertEqual(s, .foreign(target: other))
        XCTAssertFalse(s.shouldInstall)
    }

    func testRealFileIsNeverReplaced() {
        let s = CLIShim.state(linkTarget: nil, pathExists: true, targetIsPresent: { _ in true }, want: want)
        XCTAssertEqual(s, .occupied)
        XCTAssertFalse(s.shouldInstall)
    }

    /// Through the real filesystem, including the trap that `fileExists` follows symlinks and
    /// so reports a dangling link as absent.
    func testInspectDistinguishesDanglingFromMissingOnDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shim-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let link = dir.appendingPathComponent("shepherd").path

        XCTAssertEqual(CLIShim.inspect(path: link, want: want), .missing)
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: dir.appendingPathComponent("gone").path)
        XCTAssertEqual(CLIShim.inspect(path: link, want: want),
                       .dangling(target: dir.appendingPathComponent("gone").path))
    }
}
