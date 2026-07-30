import XCTest
@testable import Shepherd

/// Real-git behaviour around stashes, and the `.loose` state a conflicted pop produces.
///
/// The load-bearing case: a conflicted `git stash pop` leaves unmerged files and **no
/// operation at all**. Only real git can say that, and it is the difference between a
/// workbench with an exit and one without.
final class StashIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "commit.gpgsign", "false")
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

    private func read(_ path: String) -> String {
        (try? String(contentsOfFile: (repo as NSString).appendingPathComponent(path),
                     encoding: .utf8)) ?? ""
    }

    /// Leaves the repo with a conflicted stash pop in progress, plus one unrelated dirty
    /// file that was never at risk.
    private func conflictedPop() {
        write("f.txt", "a\nb\nc\n")
        write("other.txt", "unrelated original\n")
        git("add", "-A"); git("commit", "-m", "base")

        write("f.txt", "a\nSTASHED\nc\n")
        git("stash", "push", "-m", "wip | with a pipe")
        write("f.txt", "a\nHEAD-MOVED\nc\n")
        git("commit", "-am", "moves the same line")
        write("other.txt", "unrelated EDITED\n")
        git("stash", "pop")
    }

    func testConflictedPopLeavesUnmergedFilesAndNoOperation() {
        conflictedPop()
        let result = ConflictReader.read(cwd: repo)
        XCTAssertFalse(result.isEmpty, "the pop must leave something unmerged")
        XCTAssertEqual(result.state.operation, .none,
                       "a stash pop is not an operation git records")
        XCTAssertEqual(SequencePolicy.context(operation: result.state.operation,
                                             hasConflicts: !result.isEmpty),
                       .loose)
    }

    /// The stash survives a conflicted pop, so the discard is recoverable.
    func testTheStashEntrySurvivesAConflictedPop() {
        conflictedPop()
        XCTAssertTrue(git("stash", "list").contains("wip | with a pipe"))
    }

    /// The escape hatch: per-path, so unrelated work is untouched.
    func testDiscardRestoresOnlyTheConflictedPaths() {
        conflictedPop()
        let paths = ConflictReader.read(cwd: repo).files.map(\.path)
        XCTAssertEqual(paths, ["f.txt"])

        let outcome = GitStaging.restoreFiles(paths, cwd: repo)
        XCTAssertTrue(outcome.isOK, outcome.errorText ?? "")

        XCTAssertTrue(ConflictReader.read(cwd: repo).isEmpty,
                      "the unmerged stages must be gone")
        XCTAssertEqual(read("f.txt"), "a\nHEAD-MOVED\nc\n", "f.txt returns to HEAD")
        XCTAssertEqual(read("other.txt"), "unrelated EDITED\n",
                       "an unrelated dirty file must survive the discard")
    }

    func testRestoringNothingIsNotAnError() {
        conflictedPop()
        XCTAssertTrue(GitStaging.restoreFiles([], cwd: repo).isOK)
    }

    // MARK: - a stash is a commit-shaped document

    /// The spec's central reuse claim, against real git. A stash is a 3-parent merge commit,
    /// and `readCommit` already passes `-m --first-parent` — added in W5a so drilling into a
    /// merge commit would not render blank. That is exactly what makes a stash readable.
    func testStashReadsAsADiffThroughReadCommit() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        write("s.txt", "staged\n")
        git("add", "s.txt")
        git("stash", "push", "-m", "wip: auth")

        let stashes = StashRunner.list(cwd: repo)
        XCTAssertEqual(stashes.count, 1)
        XCTAssertEqual(stashes[0].ref, "stash@{0}")
        XCTAssertTrue(stashes[0].message.contains("wip: auth"))

        let result = DiffReader.readCommit(cwd: repo, sha: stashes[0].sha)
        XCTAssertTrue(result.isRepo)
        // Both the unstaged edit and the staged addition are in the first-parent diff.
        XCTAssertTrue(result.files.contains { $0.path == "f.txt" })
        XCTAssertTrue(result.files.contains { $0.path == "s.txt" })
        // Nothing is staged in a historical view — the rail must draw no stage buttons.
        XCTAssertTrue(result.stagedFiles.isEmpty)
    }

    /// A stash's blobs are readable by sha, which is what `BlobCache` needs for gap expansion
    /// and syntax colours inside a stash view.
    func testStashBlobsAreReadableBySha() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "wip")

        let sha = StashRunner.list(cwd: repo)[0].sha
        let blob = GitStaging.run(CommitHistory.blobArguments(sha: sha, path: "f.txt"),
                                  cwd: repo)
        guard case .ok(let text) = blob else {
            return XCTFail("could not read the stash's blob: \(blob.errorText ?? "")")
        }
        XCTAssertEqual(text, "a\nWIP\nc\n")
    }

    /// Untracked files are in the **third** parent and nowhere in the first-parent diff, so
    /// they are listed rather than previewed. Measured — this is why the rail says
    /// "untracked (not previewed)" instead of synthesizing rows.
    func testUntrackedFilesAreInTheThirdParentOnly() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        write("u.txt", "untracked\n")
        git("stash", "push", "-u", "-m", "wip with untracked")

        let sha = StashRunner.list(cwd: repo)[0].sha
        let diff = DiffReader.readCommit(cwd: repo, sha: sha)
        XCTAssertFalse(diff.files.contains { $0.path == "u.txt" },
                       "an untracked file must not appear in the first-parent diff")

        XCTAssertEqual(StashRunner.untrackedPaths(cwd: repo, ref: "stash@{0}"), ["u.txt"])
    }

    /// A stash pushed without `-u` has no third parent. That read fails, and failing is the
    /// ordinary case — it must come back empty rather than surfacing an error.
    func testNoThirdParentIsAnEmptyListNotAnError() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "no untracked")

        XCTAssertTrue(StashRunner.untrackedPaths(cwd: repo, ref: "stash@{0}").isEmpty)
    }

    func testPushAndApplyRoundTrip() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")

        XCTAssertTrue(StashRunner.push(cwd: repo, message: "round trip", scope: .all).isOK)
        XCTAssertEqual(read("f.txt"), "a\nb\nc\n", "the tree is clean after a push")

        XCTAssertTrue(StashRunner.apply(cwd: repo, ref: "stash@{0}", pop: true).isOK)
        XCTAssertEqual(read("f.txt"), "a\nWIP\nc\n", "pop restores the work")
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty, "pop consumes the entry")
    }

    func testDropRemovesTheEntry() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "doomed")

        XCTAssertTrue(StashRunner.drop(cwd: repo, ref: "stash@{0}").isOK)
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty)
    }

    /// Nothing to stash must not invent an entry. git 2.55 exits 0 saying "No local changes
    /// to save", so the entry count is what the assertion rests on, not the exit status.
    func testPushWithACleanTreeCreatesNothing() {
        write("f.txt", "a\n")
        git("add", "-A"); git("commit", "-m", "base")

        _ = StashRunner.push(cwd: repo, message: "nothing", scope: .all)
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty)
    }
}
