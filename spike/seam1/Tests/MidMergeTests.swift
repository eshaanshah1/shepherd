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

    /// The exact sequence ⌘G runs.
    ///
    /// `git diff` emits a `diff --cc` combined diff for an unmerged path, which the parser
    /// used to skip outright — so working-tree mode showed nothing at all during a merge.
    /// It reduces to the first parent's column now, giving an ordinary diff against HEAD.
    func testWorkingTreeModeShowsTheConflictedFileMidMerge() {
        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        XCTAssertEqual(result.files.map(\.path), ["App.swift"])
        let plan = RowPlanner.plan(files: result.files, staged: result.stagedFiles)
        XCTAssertFalse(plan.origins.isEmpty)
        // The staged half stays empty: `git diff --cached` emits only `* Unmerged path`.
        XCTAssertTrue(result.stagedFiles.isEmpty)
    }

    /// The markers git wrote into the worktree file are real lines of it, so they show as
    /// added — which is honest, and is what tells you the file is mid-merge.
    func testTheConflictMarkersAppearAsAddedLines() {
        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        let texts = result.files.flatMap { $0.hunks.flatMap { $0.lines } }
        XCTAssertTrue(texts.contains { $0.kind == .added && $0.text.hasPrefix("<<<<<<<") })
        XCTAssertTrue(texts.contains { $0.kind == .added && $0.text.hasPrefix(">>>>>>>") })
        XCTAssertTrue(texts.contains { $0.kind == .added && $0.text == "=======" })
    }

    /// Both sides' content survives the reduction, with our line kept as context (it is in
    /// HEAD) and theirs as an addition (it is not).
    func testBothSidesOfTheConflictSurviveTheReduction() {
        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        let texts = result.files.flatMap { $0.hunks.flatMap { $0.lines } }.map(\.text)
        XCTAssertTrue(texts.contains { $0.contains("OURS") })
        XCTAssertTrue(texts.contains { $0.contains("THEIRS") })
    }

    /// A combined header lists a `-` range per parent; the first is HEAD's. Taking the last
    /// reported another parent's numbers as HEAD's, which would misplace every row.
    func testTheHunkHeaderTakesTheFirstParentsRange() {
        let parsed = DiffParser.parse(git("diff"))
        for hunk in parsed.flatMap(\.hunks) {
            XCTAssertGreaterThan(hunk.oldStart, 0, "a zero start means the ranges misparsed")
            XCTAssertGreaterThan(hunk.newStart, 0)
        }
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
