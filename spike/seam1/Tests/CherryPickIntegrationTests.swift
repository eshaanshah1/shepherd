import XCTest
@testable import Shepherd

/// A multi-commit cherry-pick, against real git.
///
/// Measured on git 2.55: a cherry-pick sequence writes `CHERRY_PICK_HEAD`, `sequencer/todo`
/// and `MERGE_MSG`, has **no `msgnum`/`end`**, and keeps **no record of what it started
/// with** — the todo shrinks in place and the directory holds only `todo`, `head` and
/// `abort-safety`. So the only honest label is how many are left.
final class CherryPickIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-cp-" + UUID().uuidString
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

    /// `side` gets three commits; the **last** touches the same line `main` moves, so a pick
    /// of all three stops on the third with two already applied.
    private func setUpDivergence() {
        write("f.txt", "a\nb\nc\n")
        write("k.txt", "keep\n")
        git("add", "-A"); git("commit", "-m", "base")

        git("checkout", "-b", "side")
        write("one.txt", "one\n"); git("add", "-A"); git("commit", "-m", "side one")
        write("two.txt", "two\n"); git("add", "-A"); git("commit", "-m", "side two")
        write("f.txt", "a\nSIDE\nc\n"); git("commit", "-am", "side touches f")

        git("checkout", "main")
        write("f.txt", "a\nMAIN\nc\n"); git("commit", "-am", "main touches f")
    }

    func testStoppedCherryPickReportsRemainingNotAFraction() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")

        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .cherryPick)
        // One pick is left — the conflicted one. There is no denominator to report.
        XCTAssertEqual(state.progress, .remaining(1))
        XCTAssertEqual(state.summary?.contains("1 remaining"), true)
    }

    /// The two clean picks did land, which is why a fraction would need state we do not have.
    func testTheEarlierPicksAreAlreadyApplied() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")
        let log = git("log", "--format=%s")
        XCTAssertTrue(log.contains("side one"))
        XCTAssertTrue(log.contains("side two"))
    }

    /// The loop: resolve, continue, finish — driven through the same seam a rebase uses.
    func testResolveThenContinueFinishesTheSequence() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")

        write("f.txt", "a\nRESOLVED\nc\n")
        git("add", "f.txt")

        let outcome = SequenceRunner.cont(cwd: repo, operation: .cherryPick, message: nil)
        XCTAssertEqual(outcome, .finished)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertTrue(git("log", "--format=%s").contains("side touches f"))
    }

    /// A single-commit pick writes no sequencer directory, so progress is absent rather than
    /// `remaining(0)` — which would render as "0 remaining" beside a live conflict.
    func testASingleCommitPickHasNoProgress() {
        setUpDivergence()
        git("cherry-pick", "side")
        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .cherryPick)
        XCTAssertNil(state.progress)
    }
}
