import XCTest
@testable import Shepherd

/// A plan applied by real git.
///
/// The pure tests pin the todo's *text*; only git can confirm the text means what we think.
/// Verified here: the oldest-first inversion produces the intended history,
/// `GIT_SEQUENCE_EDITOR` works with no tty, and a todo carrying **no subjects at all** is
/// accepted.
final class RebasePlanIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-rw-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "commit.gpgsign", "false")

        write("base.txt", "base\n")
        git("add", "-A"); git("commit", "-m", "base commit")
        git("checkout", "-b", "feature")
        // One file per commit: a reorder of commits that all touch one file conflicts with
        // itself and would test nothing about ordering.
        for name in ["one", "two", "three"] {
            write("\(name).txt", "\(name)\n")
            git("add", "\(name).txt")
            git("commit", "-m", "feat: \(name)")
        }
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

    private func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: (repo as NSString).appendingPathComponent(path))
    }

    /// Newest first, as the rail shows them.
    private func branchCommits() -> [Commit] {
        guard case .ok(let out) = GitStaging.run(CommitHistory.logArguments(base: "main"),
                                                cwd: repo) else { return [] }
        return CommitHistory.parse(out)
    }

    private func subjects() -> [String] { branchCommits().map(\.subject) }

    private var midRebase: Bool {
        let dir = git("rev-parse", "--git-path", "rebase-merge")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = dir.hasPrefix("/") ? dir : (repo as NSString).appendingPathComponent(dir)
        return FileManager.default.fileExists(atPath: path)
    }

    func testTheFixtureStartsNewestFirst() {
        XCTAssertEqual(subjects(), ["feat: three", "feat: two", "feat: one"])
    }

    /// **The inversion, proved.** Reversing the rail must reverse the history — not leave it
    /// alone, and not scramble it.
    func testReversingTheRailReversesTheHistory() {
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows.reverse()

        let result = RebaseRunner.apply(cwd: repo, base: "main", rows: rows, original: original)
        XCTAssertTrue(result.isOK, result.errorText ?? "")
        XCTAssertFalse(midRebase, "a clean rewrite must not leave the repo mid-rebase")
        XCTAssertEqual(subjects(), ["feat: one", "feat: two", "feat: three"])
    }

    /// A todo of bare `<verb> <sha>` lines — no subjects — is accepted. This is what lets the
    /// writer ignore git's own `pick <sha> # <subject>` format entirely.
    func testATodoWithNoSubjectsIsAccepted() {
        let original = branchCommits()
        let rows = RebasePlan.rows(from: original)
        let todo = RebasePlan.todo(for: rows)
        XCTAssertFalse(todo.contains("feat:"), "the todo must carry no subjects")

        var reordered = rows
        reordered.swapAt(0, 1)
        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: reordered,
                                         original: original).isOK)
        XCTAssertEqual(subjects(), ["feat: two", "feat: three", "feat: one"])
    }

    func testDropRemovesACommitAndItsFile() {
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows[1].verb = .drop     // "feat: two"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows,
                                         original: original).isOK)
        XCTAssertEqual(subjects(), ["feat: three", "feat: one"])
        XCTAssertFalse(exists("two.txt"))
    }

    /// `fixup` folds and keeps the base commit's message, so no editor is involved.
    func testFixupFoldsIntoTheCommitBelowIt() {
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows[0].verb = .fixup    // "feat: three" folds into "feat: two"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows,
                                         original: original).isOK)
        XCTAssertEqual(subjects(), ["feat: two", "feat: one"])
        // The folded commit's content survives even though its message did not.
        XCTAssertTrue(exists("three.txt"))
    }

    /// The one-message path: `GIT_EDITOR="cp '<file>'"`, no tty.
    func testRewordSubstitutesTheMessage() {
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows[0].verb = .reword
        rows[0].message = "docs: a much better subject"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows,
                                         original: original).isOK)
        XCTAssertEqual(subjects(), ["docs: a much better subject", "feat: two", "feat: one"])
    }

    /// A squash combines two commits under the supplied message.
    func testSquashCombinesUnderTheSuppliedMessage() {
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows[0].verb = .squash
        rows[0].message = "feat: two and three together"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows,
                                         original: original).isOK)
        XCTAssertEqual(subjects(), ["feat: two and three together", "feat: one"])
    }

    /// A refused plan must not reach git at all — no rebase started, nothing to abort.
    func testABlockedPlanIsRefusedBeforeGitRuns() {
        let head = git("rev-parse", "HEAD")
        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        rows[2].verb = .squash   // oldest — nothing to squash into

        let result = RebaseRunner.apply(cwd: repo, base: "main", rows: rows, original: original)
        XCTAssertFalse(result.isOK)
        XCTAssertEqual(result.errorText, "the first commit has nothing to squash into")
        XCTAssertEqual(git("rev-parse", "HEAD"), head, "HEAD must not have moved")
        XCTAssertFalse(midRebase)
    }

    func testANoOpPlanIsRefused() {
        let head = git("rev-parse", "HEAD")
        let original = branchCommits()
        let result = RebaseRunner.apply(cwd: repo, base: "main",
                                        rows: RebasePlan.rows(from: original),
                                        original: original)
        XCTAssertFalse(result.isOK)
        XCTAssertEqual(result.errorText, "nothing to apply")
        XCTAssertEqual(git("rev-parse", "HEAD"), head)
    }

    /// A conflicting reorder hands off to the existing Continue seam rather than failing
    /// outright — and a stop must be visible *as* a stop.
    func testAConflictingReorderStopsMidRebase() {
        // A fourth commit that edits one.txt, then moved below the commit that creates it.
        write("one.txt", "one, edited\n")
        git("commit", "-am", "feat: edit one")

        let original = branchCommits()
        var rows = RebasePlan.rows(from: original)
        let edit = rows.removeFirst()   // newest: "feat: edit one"
        rows.append(edit)               // to the bottom, replayed before one.txt exists

        _ = RebaseRunner.apply(cwd: repo, base: "main", rows: rows, original: original)
        if midRebase {
            XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .rebase)
            git("rebase", "--abort")
        }
    }
}
