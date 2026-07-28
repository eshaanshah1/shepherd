import XCTest
@testable import Shepherd

/// `git blame --porcelain` emits a sha's author/time/summary headers only on that sha's
/// **first** occurrence, so the parser must carry a sha → meta dictionary. That elision is
/// the whole reason for using `--porcelain` over `--line-porcelain`: on a file where three
/// commits own a thousand lines, it is three header blocks instead of a thousand.
final class BlameParseTests: XCTestCase {

    /// Real porcelain shape: a group header line, then headers, then a tab-prefixed content
    /// line. The second group repeats the sha and so carries no headers.
    private let sample = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
    author Eshaan Shah
    author-mail <eshaan@browserstack.com>
    author-time 1785235121
    author-tz +0530
    summary side-by-side diff
    filename f.swift
    \tlet a = 1
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
    \tlet b = 2
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1
    author Someone Else
    author-mail <other@example.com>
    author-time 1785000000
    author-tz +0000
    summary earlier change
    filename f.swift
    \tlet c = 3
    """

    func testMapsEveryLineToItsCommit() {
        let result = BlameParse.parse(sample)
        XCTAssertEqual(result.shaByLine[1], String(repeating: "a", count: 40))
        XCTAssertEqual(result.shaByLine[2], String(repeating: "a", count: 40))
        XCTAssertEqual(result.shaByLine[3], String(repeating: "b", count: 40))
    }

    /// The elided-header case: line 2's group has no headers of its own.
    func testMetadataIsCarriedAcrossGroupsOfTheSameCommit() {
        let result = BlameParse.parse(sample)
        let meta = result.meta[String(repeating: "a", count: 40)]
        XCTAssertEqual(meta?.author, "Eshaan Shah")
        XCTAssertEqual(meta?.summary, "side-by-side diff")
        XCTAssertEqual(meta?.timestamp, Date(timeIntervalSince1970: 1_785_235_121))
    }

    func testSecondCommitGetsItsOwnMetadata() {
        let result = BlameParse.parse(sample)
        XCTAssertEqual(result.meta[String(repeating: "b", count: 40)]?.author, "Someone Else")
        XCTAssertEqual(result.meta.count, 2)
    }

    /// An uncommitted line is a real state the lane draws, not a parse failure.
    func testUncommittedLines() {
        let porcelain = """
        0000000000000000000000000000000000000000 4 4 1
        author Not Committed Yet
        author-mail <not.committed.yet>
        author-time 1785235999
        author-tz +0530
        summary Version of f.swift from f.swift
        filename f.swift
        \tlet d = 4
        """
        let result = BlameParse.parse(porcelain)
        XCTAssertEqual(result.shaByLine[4], BlameResult.uncommittedSha)
    }

    /// A content line is tab-prefixed, so a line of *code* that looks like a header must
    /// not be read as one.
    func testContentThatLooksLikeAHeaderIsNotParsedAsOne() {
        let porcelain = """
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
        author Real Author
        author-time 100
        summary real summary
        filename f.swift
        \tauthor Fake Author
        """
        let result = BlameParse.parse(porcelain)
        XCTAssertEqual(result.meta[String(repeating: "a", count: 40)]?.author, "Real Author")
    }

    func testEmptyInput() {
        XCTAssertTrue(BlameParse.parse("").shaByLine.isEmpty)
        XCTAssertTrue(BlameParse.parse("").meta.isEmpty)
    }

    /// `--porcelain`, never `--line-porcelain`, and `--` before the path so a file named
    /// like a revision is still a file.
    func testArguments() {
        XCTAssertEqual(BlameParse.arguments(path: "Sources/A.swift"),
                       ["blame", "--porcelain", "--", "Sources/A.swift"])
    }

    // MARK: - Against real git

    /// The sample above is hand-written, and a blame that parses to nothing fails **silently**
    /// — the lane just draws empty. So the format is pinned against real output too, the same
    /// way `ConflictIntegrationTests` pins what git writes mid-merge.
    func testParsesRealGitOutput() throws {
        let repo = NSTemporaryDirectory() + "shepherd-blame-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: repo) }

        @discardableResult
        func git(_ args: String...) -> String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", repo] + args
            let out = Pipe(), err = Pipe()
            process.standardOutput = out
            process.standardError = err
            try? process.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            _ = err.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(data: data, encoding: .utf8) ?? ""
        }
        func write(_ contents: String) {
            try? contents.write(toFile: (repo as NSString).appendingPathComponent("f.txt"),
                                atomically: true, encoding: .utf8)
        }

        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "First Author")
        write("one\ntwo\n")
        git("add", "-A"); git("commit", "-m", "first commit")
        let first = git("rev-parse", "HEAD").trimmingCharacters(in: .whitespacesAndNewlines)

        git("config", "user.name", "Second Author")
        write("one\ntwo\nthree\n")
        git("commit", "-am", "second commit")
        let second = git("rev-parse", "HEAD").trimmingCharacters(in: .whitespacesAndNewlines)

        let porcelain = git("blame", "--porcelain", "--", "f.txt")
        let result = BlameParse.parse(porcelain)

        XCTAssertEqual(result.shaByLine[1], first, "line 1 came from the first commit")
        XCTAssertEqual(result.shaByLine[2], first)
        XCTAssertEqual(result.shaByLine[3], second, "line 3 came from the second commit")
        XCTAssertEqual(result.meta[first]?.author, "First Author")
        XCTAssertEqual(result.meta[second]?.author, "Second Author")
        XCTAssertEqual(result.meta[second]?.summary, "second commit")

        // An unsaved line reports the all-zeros sha, which the lane draws as its own state.
        write("one\ntwo\nthree\nfour\n")
        let dirty = BlameParse.parse(git("blame", "--porcelain", "--", "f.txt"))
        XCTAssertEqual(dirty.shaByLine[4], BlameResult.uncommittedSha)
    }
}
