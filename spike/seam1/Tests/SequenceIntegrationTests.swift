import XCTest
@testable import Shepherd

/// The sequence seam against real git.
///
/// This test is the only thing that can prove the `GIT_EDITOR` handling works, because the
/// failure mode is a **hang** — a `Process` with no tty waiting on an editor nobody can see.
/// No unit test and no green build can see that. Every assertion here also rests on what files
/// git actually writes, which is knowledge only git has.
final class SequenceIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5a-seq-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "rerere.enabled", "false")
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
        // The harness itself must never let git open an editor either: a rebase that stopped
        // for one would hang the whole test suite.
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_EDITOR"] = "true"
        process.environment = environment
        try? process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func write(_ contents: String) {
        try? contents.write(toFile: (repo as NSString).appendingPathComponent("f.txt"),
                            atomically: true, encoding: .utf8)
    }

    private func unmergedCount() -> Int {
        git("ls-files", "-u").split(separator: "\n").filter { !$0.isEmpty }.count
    }

    /// Two commits on a branch, both of which conflict when replayed onto main.
    private func startTwoConflictRebase() {
        write("base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "feature")
        write("feature one\n")
        git("commit", "-am", "feat: first")
        write("feature two\n")
        git("commit", "-am", "feat: second")
        git("checkout", "main")
        write("main change\n")
        git("commit", "-am", "main")
        git("checkout", "feature")
        git("rebase", "main")
    }

    func testRebaseStopsAndIsDetected() {
        startTwoConflictRebase()
        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .rebase)
        XCTAssertEqual(state.progress, .counted(done: 1, total: 2))
        XCTAssertGreaterThan(unmergedCount(), 0)
    }

    func testPendingMessageIsReadableAndStripped() {
        startTwoConflictRebase()
        let raw = SequenceRunner.pendingMessage(cwd: repo, operation: .rebase)
        XCTAssertNotNil(raw)
        XCTAssertEqual(SequencePolicy.displayMessage(raw ?? ""), "feat: first")
    }

    /// The whole loop: resolve, continue, hit the second conflict, resolve, continue, done.
    /// If `GIT_EDITOR` is mishandled this hangs rather than failing.
    func testResolveContinueLoopFinishesTheRebase() {
        startTwoConflictRebase()

        write("resolved one\n")
        git("add", "f.txt")
        XCTAssertEqual(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil), .stopped)

        // The second commit conflicts too, so we are stopped again — 2 of 2 this time.
        XCTAssertGreaterThan(unmergedCount(), 0)
        let mid = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(mid.operation, .rebase)
        XCTAssertEqual(mid.progress, .counted(done: 2, total: 2))

        write("resolved two\n")
        git("add", "f.txt")
        // The last one runs to the end, so this is `.finished` and not another stop.
        XCTAssertEqual(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil),
                       .finished)

        // Finished: no operation, nothing unmerged.
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertEqual(unmergedCount(), 0)
    }

    /// Keep-as-is must not disturb the message.
    func testContinueWithoutARewordKeepsTheOriginalSubject() {
        startTwoConflictRebase()
        write("resolved\n")
        git("add", "f.txt")
        XCTAssertEqual(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil), .stopped)
        XCTAssertTrue(git("log", "--format=%s").contains("feat: first"))
    }

    /// The reword path, which is why `GIT_EDITOR=true` alone was not good enough.
    func testContinueWithARewordRewritesTheSubject() {
        startTwoConflictRebase()
        write("resolved\n")
        git("add", "f.txt")
        let result = SequenceRunner.cont(cwd: repo, operation: .rebase,
                                        message: "reworded: chosen in the workbench")
        // Only the first of two conflicting commits was resolved, so it advances and stops.
        XCTAssertEqual(result, .stopped)
        let log = git("log", "--format=%s")
        XCTAssertTrue(log.contains("reworded: chosen in the workbench"))
        XCTAssertFalse(log.contains("feat: first"))
    }

    /// `--continue` with an unstaged conflict must surface git's own words — not hang, and not
    /// silently report success.
    ///
    /// This is the case that makes `headMoved` the discriminator rather than the exit status
    /// or the unmerged count: this refusal and a stop-at-the-next-conflict both exit non-zero
    /// *and* leave unmerged files. Only "did a commit get made" tells them apart.
    func testContinueWithUnstagedConflictFailsWithAReason() {
        startTwoConflictRebase()
        // Resolve the text but never `git add` it.
        write("resolved but unstaged\n")
        let result = SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil)
        guard case .failed(let reason) = result else {
            return XCTFail("expected a failure, got \(result)")
        }
        XCTAssertFalse(reason.isEmpty)
    }

    func testMergeContinueCommitsTheMerge() {
        write("base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("side\n")
        git("commit", "-am", "side")
        git("checkout", "main")
        write("main\n")
        git("commit", "-am", "main")
        git("merge", "side")
        XCTAssertGreaterThan(unmergedCount(), 0)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .merge)

        write("resolved\n")
        git("add", "f.txt")
        XCTAssertEqual(SequenceRunner.cont(cwd: repo, operation: .merge, message: nil), .finished)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertEqual(unmergedCount(), 0)
    }

    func testCherryPickContinue() {
        write("base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("side\n")
        git("commit", "-am", "pick me")
        git("checkout", "main")
        write("main\n")
        git("commit", "-am", "main")
        git("cherry-pick", "side")
        XCTAssertGreaterThan(unmergedCount(), 0)

        write("resolved\n")
        git("add", "f.txt")
        XCTAssertEqual(SequenceRunner.cont(cwd: repo, operation: .cherryPick, message: nil), .finished)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
    }

    /// A message file only exists while something is pending.
    func testNoPendingMessageWhenNothingIsInFlight() {
        write("base\n")
        git("add", "-A"); git("commit", "-m", "base")
        XCTAssertNil(SequenceRunner.pendingMessage(cwd: repo, operation: .none))
    }
}
