import XCTest
@testable import Shepherd

/// `DiffReader.readCommit` against real git.
///
/// The load-bearing case is the merge commit: `git show -M --format= <merge>` prints
/// **nothing** (it defaults to a combined `@@@` diff, which is suppressed without `-m`),
/// so drilling into a merge would render a silently blank buffer. Only real git can say.
final class CommitDiffIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5a-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String...) -> String {
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

    private func write(_ path: String, _ contents: String) {
        try? contents.write(toFile: (repo as NSString).appendingPathComponent(path),
                            atomically: true, encoding: .utf8)
    }

    private func head() -> String {
        git("rev-parse", "HEAD").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testReadsAnOrdinaryCommitAsADiff() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nCHANGED\nc\n")
        git("commit", "-am", "change b")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertTrue(result.isRepo)
        XCTAssertEqual(result.files.map(\.path), ["f.txt"])
        XCTAssertEqual(result.files.first?.addedCount, 1)
        XCTAssertEqual(result.files.first?.removedCount, 1)
        // Nothing is staged in a historical view — the rail must render no stage buttons.
        XCTAssertTrue(result.stagedFiles.isEmpty)
    }

    /// The regression this task exists to prevent.
    func testMergeCommitIsNotBlank() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("f.txt", "a\nSIDE\nc\n")
        git("commit", "-am", "side")
        git("checkout", "main")
        write("g.txt", "new\n")
        git("add", "-A"); git("commit", "-m", "main")
        git("merge", "side", "-m", "merge side")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertFalse(result.files.isEmpty,
                       "a merge commit must not read as an empty diff")
        XCTAssertTrue(result.files.contains { $0.path == "f.txt" })
    }

    /// A root commit has no `^`, so the old-side label cannot be assumed resolvable.
    func testRootCommitReadsAsAllAdditions() {
        write("f.txt", "a\nb\n")
        git("add", "-A"); git("commit", "-m", "root")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertEqual(result.files.map(\.path), ["f.txt"])
        XCTAssertEqual(result.files.first?.addedCount, 2)
    }

    /// The commit list, through the **real** `Process` path.
    ///
    /// This is the test whose absence let a crash ship: `logArguments` was asserted for shape
    /// and `parse` was fed hand-built strings, but nothing ever handed those arguments to
    /// `Process`. They contained literal NULs, which `fileSystemRepresentation` cannot encode,
    /// so `run()` threw an ObjC exception and took the app down on ⌘G. Only running it can say.
    func testCommitListReadsThroughProcess() {
        write("f.txt", "a\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "feature")
        write("f.txt", "b\n")
        // A subject carrying the characters a human-readable delimiter would split on.
        git("commit", "-am", "feat: a|b — [wip] \"quoted\" 100%")
        write("f.txt", "c\n")
        git("commit", "-am", "second one")

        guard case .ok(let out) = GitStaging.run(CommitHistory.logArguments(base: "main"),
                                                cwd: repo) else {
            return XCTFail("git log failed to run at all")
        }
        let commits = CommitHistory.parse(out)
        XCTAssertEqual(commits.map(\.subject),
                       ["second one", "feat: a|b — [wip] \"quoted\" 100%"])
        XCTAssertEqual(commits.first?.author, "Test")
        XCTAssertEqual(commits.count, 2, "base is on main, so it is outside main..HEAD")
        XCTAssertFalse(commits.contains { $0.sha.isEmpty || $0.shortSha.isEmpty })
    }

    func testNotARepoIsReportedNotCrashed() {
        let empty = NSTemporaryDirectory() + "shepherd-w5a-norepo-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: empty) }
        XCTAssertFalse(DiffReader.readCommit(cwd: empty, sha: "HEAD").isRepo)
    }
}
