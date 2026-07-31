import XCTest
@testable import Shepherd

/// Real `git`, real conflicts. The four ways a tree becomes unmerged leave DIFFERENT state
/// on disk, and a conflicted `stash apply` leaves no sequence record at all — the case that
/// shipped broken once already.
final class RepoSignalsIntegrationTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nudge-signals-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: helpers

    /// Every call passes identity and disables signing: an unset `user.name` fails the
    /// commit, and GPG signing blocks on a passphrase prompt no test can answer.
    @discardableResult
    private func git(_ args: [String], in dir: String) -> GitResult {
        GitStaging.run(["-c", "user.name=T", "-c", "user.email=t@e",
                        "-c", "commit.gpgsign=false"] + args, cwd: dir)
    }

    private func write(_ text: String, _ name: String, in dir: String) throws {
        try text.write(toFile: (dir as NSString).appendingPathComponent(name),
                       atomically: true, encoding: .utf8)
    }

    /// A repo on `main` with `a.txt`, plus a `feature` branch whose `a.txt` conflicts.
    private func conflictingRepo() throws -> String {
        let dir = root.appendingPathComponent("repo").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        git(["init", "-b", "main"], in: dir)
        try write("base\n", "a.txt", in: dir)
        git(["add", "."], in: dir)
        git(["commit", "-m", "base"], in: dir)

        git(["checkout", "-b", "feature"], in: dir)
        try write("feature\n", "a.txt", in: dir)
        git(["commit", "-am", "feature"], in: dir)

        git(["checkout", "main"], in: dir)
        try write("main\n", "a.txt", in: dir)
        git(["commit", "-am", "main"], in: dir)
        return dir
    }

    // MARK: the four flavours

    func testMergeConflict() throws {
        let dir = try conflictingRepo()
        git(["merge", "feature"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .merge)
        XCTAssertEqual(s.branch, "main")
    }

    func testRebaseConflict() throws {
        let dir = try conflictingRepo()
        git(["checkout", "feature"], in: dir)
        git(["rebase", "main"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .rebase)
    }

    func testCherryPickConflict() throws {
        let dir = try conflictingRepo()
        git(["cherry-pick", "feature"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .cherryPick)
    }

    /// The `.loose` case: unmerged files with NO operation recorded anywhere.
    func testStashApplyConflictHasNoOperation() throws {
        let dir = try conflictingRepo()
        try write("stashed\n", "a.txt", in: dir)
        git(["stash"], in: dir)
        try write("other\n", "a.txt", in: dir)
        git(["commit", "-am", "other"], in: dir)
        git(["stash", "apply"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .none,
                       "a conflicted stash apply records no operation — this is the .loose case")
    }

    // MARK: a stopped sequence with nothing left conflicting

    func testResolvedButStillMidMerge() throws {
        let dir = try conflictingRepo()
        git(["merge", "feature"], in: dir)
        try write("resolved\n", "a.txt", in: dir)
        git(["add", "a.txt"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 0)
        XCTAssertEqual(s.state.operation, .merge,
                       "MERGE_HEAD survives resolving the last file — this is continueSequence")
    }

    // MARK: dirty / ahead / branch

    func testDirtyCountsUntrackedAndModified() throws {
        let dir = try conflictingRepo()
        try write("edited\n", "a.txt", in: dir)
        try write("new\n", "b.txt", in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.dirty, 2)
        XCTAssertEqual(s.conflicts, 0)
    }

    func testAheadOfUpstream() throws {
        let dir = try conflictingRepo()
        let originPath = root.appendingPathComponent("origin.git").path
        git(["init", "--bare", "-b", "main", originPath], in: dir)
        git(["remote", "add", "origin", originPath], in: dir)
        git(["push", "-u", "origin", "main"], in: dir)
        try write("more\n", "c.txt", in: dir)
        git(["add", "."], in: dir)
        git(["commit", "-m", "more"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertTrue(s.hasUpstream)
        XCTAssertEqual(s.ahead, 1)
    }

    /// No upstream and no `origin/HEAD` means there is no honest answer, so `ahead` stays 0.
    /// Counting all of `HEAD` instead would report every commit in history as unpushed.
    func testNoUpstreamAndNoOriginHeadReportsZeroAhead() throws {
        let dir = try conflictingRepo()
        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertFalse(s.hasUpstream)
        XCTAssertEqual(s.ahead, 0)
    }

    // MARK: not a repo

    func testNonRepoReturnsNil() throws {
        let plain = root.appendingPathComponent("plain").path
        try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)
        XCTAssertNil(RepoSignalsReader.read(cwd: plain))
    }

    // MARK: worktrees

    /// In a linked worktree `.git` is a FILE pointing at `.git/worktrees/<name>`, and that
    /// directory is where MERGE_HEAD lives. `--absolute-git-dir` resolves it; watching the
    /// `.git` file itself would watch a pointer that never changes.
    func testLinkedWorktreeMidMergeIsSeen() throws {
        let dir = try conflictingRepo()
        let wt = root.appendingPathComponent("wt").path
        git(["worktree", "add", "-b", "wt-branch", wt, "main"], in: dir)
        git(["merge", "feature"], in: wt)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: wt))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .merge)

        let gitDir = try XCTUnwrap(Git.gitDir(wt))
        XCTAssertTrue(gitDir.contains("worktrees/wt"),
                      "expected the per-worktree git dir, got \(gitDir)")
        XCTAssertTrue(FileManager.default
            .fileExists(atPath: (gitDir as NSString).appendingPathComponent("MERGE_HEAD")))
    }
}
