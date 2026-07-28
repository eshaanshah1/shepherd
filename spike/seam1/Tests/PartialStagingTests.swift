import XCTest
@testable import Shepherd

/// Partial staging against real git.
///
/// The bug this exists for: the workbench used to show one `git diff HEAD`, which is staged
/// ∪ unstaged, and synthesize its patches from it. The moment a file already had something
/// staged, the index no longer matched HEAD, so the patch's old side described a state
/// `git apply --cached` was not applying to, and git rejected it. Reading the two diffs
/// separately means a patch is always built from the diff its rows came from.
final class PartialStagingTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-staging-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "t@e.com")
        git("config", "user.name", "T")
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

    private func write(_ lines: [String]) {
        try? lines.joined(separator: "\n")
            .appending("\n")
            .write(toFile: (repo as NSString).appendingPathComponent("App.swift"),
                   atomically: true, encoding: .utf8)
    }

    private func base() -> [String] { (1...12).map { "line \($0)" } }

    /// Stage exactly one changed line out of the unstaged diff, the way ⌘⏎ does.
    private func stageLine(containing needle: String) throws {
        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        let plan = RowPlanner.plan(files: result.files, staged: result.stagedFiles)
        let document = plan.origins.enumerated()

        // Rows carry the side they came from; only an unstaged one can be staged.
        let rows = document.filter { _, origin in
            !origin.isStaged && origin.kind == .added
        }
        let target = try XCTUnwrap(rows.first { index, _ in
            lineText(plan, result, at: index)?.contains(needle) == true
        }, "no unstaged added row containing \(needle)")

        let groups = StageSelection.selections(forStitchedLines: [target.offset],
                                               origins: plan.origins,
                                               files: result.files, staged: false)
        let group = try XCTUnwrap(groups.first)
        let patch = try XCTUnwrap(PatchSynth.patch(path: group.path, oldPath: group.oldPath,
                                                   hunks: group.hunks,
                                                   selections: group.selections))
        let applied = GitStaging.applyToIndex(patch: patch, cwd: repo, reverse: false)
        XCTAssertNil(applied.errorText, "git rejected the synthesized patch")
    }

    private func lineText(_ plan: RowPlan, _ result: DiffReadResult, at row: Int) -> String? {
        guard plan.origins.indices.contains(row) else { return nil }
        let origin = plan.origins[row]
        let list = origin.isStaged ? result.stagedFiles : result.files
        guard let file = list.first(where: { $0.path == origin.path }),
              file.hunks.indices.contains(origin.hunkIndex),
              file.hunks[origin.hunkIndex].lines.indices.contains(origin.lineIndex)
        else { return nil }
        return file.hunks[origin.hunkIndex].lines[origin.lineIndex].text
    }

    // MARK: -

    func testStagingOneLineOfACleanFileWorks() throws {
        write(base())
        git("add", "-A")
        git("commit", "-m", "base")

        var lines = base()
        lines[3] = "FIRST change"
        lines[9] = "SECOND change"
        write(lines)

        try stageLine(containing: "FIRST")
        XCTAssertTrue(git("diff", "--cached").contains("FIRST change"))
        XCTAssertFalse(git("diff", "--cached").contains("SECOND change"),
                       "only the selected line should have moved")
    }

    /// The regression this whole change exists for.
    func testStagingOneLineOfAFileThatAlreadyHasStagedChanges() throws {
        write(base())
        git("add", "-A")
        git("commit", "-m", "base")

        // Stage one change, so the index no longer matches HEAD for this file.
        var lines = base()
        lines[1] = "ALREADY staged"
        write(lines)
        git("add", "App.swift")

        // Now make two more, and stage exactly one of them.
        lines[5] = "NEWLY staged"
        lines[9] = "STILL unstaged"
        write(lines)

        try stageLine(containing: "NEWLY")

        let staged = git("diff", "--cached")
        XCTAssertTrue(staged.contains("ALREADY staged"), "the earlier staged change survives")
        XCTAssertTrue(staged.contains("NEWLY staged"), "the new line reached the index")
        XCTAssertFalse(staged.contains("STILL unstaged"))
        XCTAssertTrue(git("diff").contains("STILL unstaged"),
                      "the unselected change stays in the worktree")
    }

    func testTheTwoDiffsSplitAPartiallyStagedFile() {
        write(base())
        git("add", "-A")
        git("commit", "-m", "base")

        var lines = base()
        lines[1] = "staged change"
        write(lines)
        git("add", "App.swift")
        lines[9] = "unstaged change"
        write(lines)

        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        XCTAssertEqual(result.files.map(\.path), ["App.swift"], "unstaged half")
        XCTAssertEqual(result.stagedFiles.map(\.path), ["App.swift"], "staged half")

        // Rows from each half are tagged, which is what routes a patch to the right diff.
        let plan = RowPlanner.plan(files: result.files, staged: result.stagedFiles)
        XCTAssertTrue(plan.origins.contains { $0.isStaged })
        XCTAssertTrue(plan.origins.contains { !$0.isStaged })
    }

    /// Staging everything empties the unstaged diff — the workbench must not read that as
    /// "no changes".
    func testStagingEverythingLeavesOnlyTheStagedHalf() {
        write(base())
        git("add", "-A")
        git("commit", "-m", "base")

        var lines = base()
        lines[1] = "all staged"
        write(lines)
        git("add", "-A")

        let result = DiffReader.read(cwd: repo, mode: .workingTree)
        XCTAssertTrue(result.files.isEmpty, "nothing left unstaged")
        XCTAssertEqual(result.stagedFiles.map(\.path), ["App.swift"])
    }
}
