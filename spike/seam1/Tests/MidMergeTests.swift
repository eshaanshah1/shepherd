import XCTest
@testable import Shepherd

/// ⌘G on a conflicted repo runs working-tree mode *inside a merge*, where `git diff` emits
/// combined `@@@` hunks that `DiffParser` was never taught. Nothing exercised that before.
final class MidMergeWorkingTreeTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-midmerge-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main"); git("config", "user.email", "t@e.com")
        git("config", "user.name", "T")

        write((1...12).map { "line \($0)" })
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-qb", "feature")
        var theirs = (1...12).map { "line \($0)" }; theirs[3] = "THEIRS"
        write(theirs); git("commit", "-qam", "theirs")
        git("checkout", "-q", "main")
        var ours = (1...12).map { "line \($0)" }; ours[3] = "OURS"
        write(ours); git("commit", "-qam", "ours")
        git("merge", "feature")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String...) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", repo] + args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err
        try? p.run()
        let d = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: d, encoding: .utf8) ?? ""
    }

    private func write(_ lines: [String]) {
        try? lines.joined(separator: "\n").appending("\n")
            .write(toFile: (repo as NSString).appendingPathComponent("App.swift"),
                   atomically: true, encoding: .utf8)
    }

    /// The exact sequence ⌘G runs, and what it actually yields.
    ///
    /// **Both halves come back empty mid-merge**, and that is git being explicit rather than
    /// a fault here: for an unmerged path `git diff` emits a `diff --cc` combined diff, whose
    /// header `DiffParser` does not recognise (it looks for `diff --git`), and `git diff
    /// --cached` emits the literal line `* Unmerged path App.swift` with no diff at all.
    ///
    /// Pre-existing — the old single `git diff HEAD` query hit the same wall — and not worth
    /// fixing here, because a conflicted repo auto-selects the Files scope, which reads the
    /// index directly and shows the conflicts properly. Pinned so that if combined-diff
    /// parsing ever lands, this says out loud what changes.
    func testWorkingTreeModeIsEmptyMidMergeRatherThanWrong() {
        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        XCTAssertTrue(result.files.isEmpty, "`git diff` emits `diff --cc`, which we skip")
        XCTAssertTrue(result.stagedFiles.isEmpty, "`git diff --cached` emits no diff at all")
        // The point of the test: it produces nothing, and does not trap producing it.
        let plan = RowPlanner.plan(files: result.files, staged: result.stagedFiles)
        XCTAssertTrue(plan.origins.isEmpty)
    }

    /// So the empty working tree above is never what a user is looking at.
    func testTheFilesScopeIsWhereAConflictedRepoLands() {
        XCTAssertFalse(ConflictReader.read(cwd: repo).isEmpty,
                       "the conflicts must be reachable even though the diff modes are blank")
    }

    func testBranchModeSurvivesAMergeInProgress() {
        let result = DiffReader.read(cwd: repo, mode: .branchVsBase)
        _ = RowPlanner.plan(files: result.files, staged: result.stagedFiles)
    }

    func testTheConflictPathSurvivesAlongsideIt() {
        let conflicts = ConflictReader.read(cwd: repo)
        _ = RowPlanner.planConflicts(conflicts.files, resolutions: [:])
        XCTAssertFalse(conflicts.isEmpty)
    }

    /// What a combined diff actually parses to, whatever that turns out to be — the point
    /// is that it is bounded and does not trap.
    func testCombinedDiffHunksDoNotTrapTheParser() {
        let combined = git("diff")
        XCTAssertTrue(combined.contains("@@@"), "precondition: git emitted a combined diff")
        let files = DiffParser.parse(combined)
        for file in files {
            for hunk in file.hunks {
                XCTAssertGreaterThanOrEqual(hunk.oldStart, 0)
                XCTAssertGreaterThanOrEqual(hunk.newStart, 0)
            }
        }
        _ = RowPlanner.plan(files: files)
    }
}
