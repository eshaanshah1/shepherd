import XCTest
@testable import Shepherd

/// `ConflictReader` against real `git`, in a real repo, mid-real-merge.
///
/// The roadmap is emphatic that none of the eleven defects the first live run found were
/// catchable by unit tests — they were coordinate mappings and lifetimes, not logic. The
/// same applies here: `Diff3` can be perfect against hand-written arrays and still be fed
/// the wrong blob, the wrong stage, or the wrong side's label. Only git can say.
final class ConflictIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w3-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        // A merge must not be allowed to auto-resolve via rerere from the dev's own config.
        git("config", "rerere.enabled", "false")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    // MARK: - Harness

    @discardableResult
    private func git(_ args: String...) -> String { git(args) }

    @discardableResult
    private func git(_ args: [String]) -> String {
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
        let full = (repo as NSString).appendingPathComponent(path)
        try? FileManager.default.createDirectory(
            atPath: (full as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? contents.write(toFile: full, atomically: true, encoding: .utf8)
    }

    private func writeBinary(_ path: String, _ bytes: [UInt8]) {
        let full = (repo as NSString).appendingPathComponent(path)
        FileManager.default.createFile(atPath: full, contents: Data(bytes))
    }

    private func commit(_ message: String) {
        git("add", "-A")
        git("commit", "-m", message)
    }

    /// Branch off main, apply a change, come back.
    private func onBranch(_ name: String, _ body: () -> Void) {
        git("checkout", "-b", name, "main")
        body()
        git("checkout", "main")
    }

    private func file(_ result: ConflictReadResult, _ path: String) -> MergeFile? {
        result.files.first { $0.path == path }
    }

    // MARK: - Content conflicts

    func testAContentConflictComesBackAsAThreeWayMerge() {
        write("App.swift", "one\ntwo\nthree\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "one\nTHEIRS\nthree\n")
            commit("theirs")
        }
        write("App.swift", "one\nOURS\nthree\n")
        commit("ours")
        git("merge", "feature")

        let result = ConflictReader.read(cwd: repo)
        let app = file(result, "App.swift")
        XCTAssertEqual(app?.kind, .content)
        XCTAssertEqual(app?.conflicts.count, 1)
        XCTAssertEqual(app?.conflicts.first?.base, ["two"])
        XCTAssertEqual(app?.conflicts.first?.ours, ["OURS"])
        XCTAssertEqual(app?.conflicts.first?.theirs, ["THEIRS"])
        XCTAssertEqual(app?.regions.first, .stable(["one"]))
        XCTAssertEqual(app?.regions.last, .stable(["three"]))
    }

    /// The requirement the roadmap calls out by name: a region only one side touched must
    /// not become a decision.
    func testAOneSidedChangeInTheSameFileStaysSilent() {
        write("App.swift", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "one\nTHEIRS\nthree\nfour\nfive\nsix\nseven\neight\n")
            commit("theirs")
        }
        // Line 2 conflicts; line 8 is ours alone and must merge silently.
        write("App.swift", "one\nOURS\nthree\nfour\nfive\nsix\nseven\nEIGHT\n")
        commit("ours")
        git("merge", "feature")

        let app = file(ConflictReader.read(cwd: repo), "App.swift")
        XCTAssertEqual(app?.conflicts.count, 1, "the one-sided edit must not be a decision")
        let preview = MergeOutput.preview(app!, resolutions: [:])
        XCTAssertEqual(preview.last, "EIGHT", "our one-sided edit must survive")
    }

    /// The whole point of the feature: taking a side must produce a file git accepts as
    /// resolved, with no markers left in it.
    func testResolvingProducesAFileGitConsidersMerged() throws {
        write("App.swift", "one\ntwo\nthree\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "one\nTHEIRS\nthree\n")
            commit("theirs")
        }
        write("App.swift", "one\nOURS\nthree\n")
        commit("ours")
        git("merge", "feature")

        let app = try XCTUnwrap(file(ConflictReader.read(cwd: repo), "App.swift"))
        let resolved = try XCTUnwrap(
            MergeOutput.text(app, resolutions: [app.conflicts[0].id: .theirs]))
        XCTAssertEqual(resolved, "one\nTHEIRS\nthree\n")

        write("App.swift", resolved)
        git("add", "App.swift")
        XCTAssertTrue(ConflictReader.read(cwd: repo).isEmpty,
                      "git should no longer report the path as unmerged")
        XCTAssertFalse(git("status", "--porcelain").contains("UU"))
    }

    func testTakingBothSidesKeepsBothInOrder() throws {
        write("App.swift", "one\ntwo\nthree\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "one\nTHEIRS\nthree\n")
            commit("theirs")
        }
        write("App.swift", "one\nOURS\nthree\n")
        commit("ours")
        git("merge", "feature")

        let app = try XCTUnwrap(file(ConflictReader.read(cwd: repo), "App.swift"))
        let id = app.conflicts[0].id
        XCTAssertEqual(MergeOutput.text(app, resolutions: [id: .bothOursFirst]),
                       "one\nOURS\nTHEIRS\nthree\n")
        XCTAssertEqual(MergeOutput.text(app, resolutions: [id: .bothTheirsFirst]),
                       "one\nTHEIRS\nOURS\nthree\n")
    }

    func testOurDiff3AgreesWithGitAboutHowManyRegionsConflict() {
        write("App.swift", (1...40).map(String.init).joined(separator: "\n") + "\n")
        commit("base")
        onBranch("feature") {
            var lines = (1...40).map(String.init)
            lines[4] = "THEIRS-5"
            lines[30] = "THEIRS-31"
            write("App.swift", lines.joined(separator: "\n") + "\n")
            commit("theirs")
        }
        var lines = (1...40).map(String.init)
        lines[4] = "OURS-5"
        lines[30] = "OURS-31"
        write("App.swift", lines.joined(separator: "\n") + "\n")
        commit("ours")
        git("merge", "feature")

        let result = ConflictReader.read(cwd: repo)
        XCTAssertEqual(file(result, "App.swift")?.conflicts.count, 2)
        XCTAssertTrue(result.divergent.isEmpty,
                      "our region count disagreed with git's: \(result.divergent)")
    }

    // MARK: - Conflicts with no line-level answer

    func testAFileTheyDeletedAndWeModified() {
        write("App.swift", "one\n")
        commit("base")
        onBranch("feature") {
            git("rm", "App.swift")
            commit("theirs delete")
        }
        write("App.swift", "one\ntwo\n")
        commit("ours modify")
        git("merge", "feature")

        let app = file(ConflictReader.read(cwd: repo), "App.swift")
        XCTAssertEqual(app?.kind, .deletedByThem)
        XCTAssertTrue(app?.regions.isEmpty ?? false, "no rows — this is not a line decision")
        XCTAssertEqual(app?.conflicts.count, 1)
        XCTAssertNil(MergeOutput.text(app!, resolutions: [app!.conflicts[0].id: .ours]),
                     "we must never synthesize content for a delete/modify conflict")
    }

    func testAFileWeDeletedAndTheyModified() {
        write("App.swift", "one\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "one\ntwo\n")
            commit("theirs modify")
        }
        git("rm", "App.swift")
        commit("ours delete")
        git("merge", "feature")

        XCTAssertEqual(file(ConflictReader.read(cwd: repo), "App.swift")?.kind, .deletedByUs)
    }

    /// A delete/modify conflict is settled by handing the decision to git, and the commands
    /// `WholeFileResolve` picks must actually work.
    func testGitSettlesADeleteModifyConflictWithTheCommandsWeChose() throws {
        write("App.swift", "one\n")
        commit("base")
        onBranch("feature") {
            git("rm", "App.swift")
            commit("theirs delete")
        }
        write("App.swift", "one\ntwo\n")
        commit("ours modify")
        git("merge", "feature")

        for args in WholeFileResolve.commands(kind: .deletedByThem, side: .ours,
                                              path: "App.swift") {
            git(args)
        }
        XCTAssertTrue(ConflictReader.read(cwd: repo).isEmpty)
    }

    func testBothSidesAddedTheSamePathWithDifferentContent() {
        write("README.md", "base\n")
        commit("base")
        onBranch("feature") {
            write("New.swift", "theirs\n")
            commit("theirs add")
        }
        write("New.swift", "ours\n")
        commit("ours add")
        git("merge", "feature")

        let added = file(ConflictReader.read(cwd: repo), "New.swift")
        XCTAssertEqual(added?.kind, .addAdd)
        // No ancestor, so every line is a decision.
        XCTAssertEqual(added?.conflicts.first?.base, [])
        XCTAssertEqual(added?.conflicts.first?.ours, ["ours"])
        XCTAssertEqual(added?.conflicts.first?.theirs, ["theirs"])
    }

    func testABinaryConflictIsNeverGivenLinesToWrite() {
        writeBinary("logo.png", [0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02])
        commit("base")
        onBranch("feature") {
            writeBinary("logo.png", [0x89, 0x50, 0x4E, 0x47, 0x00, 0xAA, 0xBB])
            commit("theirs binary")
        }
        writeBinary("logo.png", [0x89, 0x50, 0x4E, 0x47, 0x00, 0xCC, 0xDD])
        commit("ours binary")
        git("merge", "feature")

        let logo = file(ConflictReader.read(cwd: repo), "logo.png")
        XCTAssertEqual(logo?.kind, .binary)
        XCTAssertTrue(logo?.regions.isEmpty ?? false)
        XCTAssertNil(MergeOutput.text(logo!, resolutions: [logo!.conflicts[0].id: .ours]))
    }

    // MARK: - Operation state

    func testAMergeNamesBothBranches() {
        write("App.swift", "one\n")
        commit("base")
        onBranch("feature") {
            write("App.swift", "theirs\n")
            commit("theirs")
        }
        write("App.swift", "ours\n")
        commit("ours")
        git("merge", "feature")

        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .merge)
        XCTAssertEqual(state.oursLabel, "main")
        XCTAssertEqual(state.theirsLabel, "feature")
    }

    /// The inversion. Mid-rebase, git's "ours" is the branch being rebased **onto** — so
    /// the side labelled `main` must be main's content, not the feature branch's. Getting
    /// this backwards puts the wrong name on the button that discards someone's work.
    func testARebaseLabelsTheUpstreamAsOursAndYourWorkAsTheirs() throws {
        write("App.swift", "one\n")
        commit("base")
        git("checkout", "-b", "feature")
        write("App.swift", "feature-side\n")
        commit("feature work")
        git("checkout", "main")
        write("App.swift", "main-side\n")
        commit("main work")
        git("checkout", "feature")
        git("rebase", "main")

        let result = ConflictReader.read(cwd: repo)
        XCTAssertEqual(result.state.operation, .rebase)
        XCTAssertEqual(result.state.oursLabel, "main")
        XCTAssertEqual(result.state.theirsLabel, "feature")

        let app = try XCTUnwrap(file(result, "App.swift"))
        let conflict = try XCTUnwrap(app.conflicts.first)
        XCTAssertEqual(conflict.ours, ["main-side"],
                       "the side labelled main must carry main's content")
        XCTAssertEqual(conflict.theirs, ["feature-side"],
                       "the side labelled feature must carry the replayed commit's content")
    }

    func testACleanRepoReportsNothing() {
        write("App.swift", "one\n")
        commit("base")
        XCTAssertTrue(ConflictReader.read(cwd: repo).isEmpty)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
    }

    func testAPathWithSpacesAndUnicodeSurvivesTheWholePipeline() throws {
        let path = "Sources/My Dir/café.swift"
        write(path, "one\ntwo\nthree\n")
        commit("base")
        onBranch("feature") {
            write(path, "one\nTHEIRS\nthree\n")
            commit("theirs")
        }
        write(path, "one\nOURS\nthree\n")
        commit("ours")
        git("merge", "feature")

        let subject = try XCTUnwrap(file(ConflictReader.read(cwd: repo), path))
        XCTAssertEqual(subject.conflicts.first?.ours, ["OURS"])
        XCTAssertEqual(subject.conflicts.first?.theirs, ["THEIRS"])
    }
}
