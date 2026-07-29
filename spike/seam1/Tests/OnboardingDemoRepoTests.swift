import XCTest
import Foundation
@testable import Shepherd

/// Real git. The sandbox has to satisfy `WorktreeService`, which fetches origin and
/// reads `origin/HEAD` — a locally-init'd repo with no remote would abort worktree
/// creation, and only real git can prove it doesn't.
final class OnboardingDemoRepoTests: XCTestCase {

    private var paths: DemoRepoPaths!
    private var worktreeBase: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let tmp = NSTemporaryDirectory() + "shepherd-onboarding-" + UUID().uuidString
        paths = DemoRepoPaths(root: tmp,
                              origin: tmp + "/origin.git",
                              clone: tmp + "/tour-repo",
                              repoName: "tour-repo")
        worktreeBase = NSTemporaryDirectory() + "shepherd-onboarding-wt-" + UUID().uuidString
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: paths.root)
        try? FileManager.default.removeItem(atPath: worktreeBase)
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String..., in dir: String? = nil) -> String {
        Git.run(args, in: dir ?? paths.clone).out
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func build() throws {
        if case .failure(let e) = OnboardingDemoRepo.build(at: paths) {
            XCTFail("sandbox build failed at `\(e.command)`: \(e.message)")
            throw e
        }
    }

    func testBuildCreatesABareOriginWhoseHeadResolves() throws {
        try build()
        XCTAssertTrue(FileManager.default.fileExists(atPath: paths.origin + "/HEAD"))
        XCTAssertEqual(git("symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main")
    }

    // The actual gate: WorktreeService aborts the whole worktree add if this fails.
    func testFetchOriginSucceedsOffline() throws {
        try build()
        XCTAssertEqual(Git.run(["fetch", "origin"], in: paths.clone).code, 0)
    }

    func testMainHasThreeCommitsAndTheBranchIsTwoAhead() throws {
        try build()
        XCTAssertEqual(git("rev-list", "--count", "main"), "3")
        XCTAssertEqual(git("rev-list", "--count", "main..\(OnboardingDemoRepo.branch)"), "2")
    }

    func testTheCheckedOutBranchIsTheFeatureBranch() throws {
        try build()
        XCTAssertEqual(git("rev-parse", "--abbrev-ref", "HEAD"), OnboardingDemoRepo.branch)
    }

    // The workbench needs all three rail sections to have content on first open.
    //
    // Read untrimmed: porcelain tells staged from unstaged by COLUMN (`M ` vs ` M`), so
    // trimming the output silently promotes whichever file sorts first to "staged".
    func testWorkingTreeHasOneStagedOneUnstagedAndOneUntrackedChange() throws {
        try build()
        let status = Git.run(["status", "--porcelain"], in: paths.clone).out
        let lines = status.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 3, "unexpected status:\n\(status)")
        XCTAssertEqual(lines.filter { $0.hasPrefix("M ") }.count, 1, "expected one staged edit in:\n\(status)")
        XCTAssertEqual(lines.filter { $0.hasPrefix(" M") }.count, 1, "expected one unstaged edit in:\n\(status)")
        XCTAssertEqual(lines.filter { $0.hasPrefix("??") }.count, 1, "expected one untracked file in:\n\(status)")
    }

    // A single-hunk diff wouldn't exercise the workbench's gap expansion or its
    // deletion bands, which is half of what the tour is showing off.
    func testTheStagedDiffHasTwoHunksAndARemovedLine() throws {
        try build()
        let diff = git("diff", "--cached", "-U3")
        XCTAssertEqual(diff.components(separatedBy: "\n@@").count - 1, 2, "expected 2 hunks in:\n\(diff)")
        XCTAssertTrue(diff.split(separator: "\n").contains { $0.hasPrefix("-") && !$0.hasPrefix("---") },
                      "expected a removed line in:\n\(diff)")
    }

    func testTheConflictBranchIsOneCommitOffTheBase() throws {
        try build()
        XCTAssertEqual(git("rev-list", "--count", "main..\(OnboardingDemoRepo.conflictBranch)"), "1")
    }

    // The conflict demo runs in a *worktree*, because the main clone's tree is
    // deliberately dirty and git refuses to merge over a modified index. This proves
    // the merge really conflicts there rather than fast-forwarding.
    func testMergingTheConflictBranchInACleanWorktreeConflicts() throws {
        try build()
        let wt = worktreeBase + "/tour-repo/tour-branch"
        try FileManager.default.createDirectory(atPath: worktreeBase + "/tour-repo",
                                               withIntermediateDirectories: true)
        XCTAssertEqual(Git.run(["worktree", "add", "-b", "tour-branch", wt, "main"],
                               in: paths.clone).code, 0)

        try "# Shepherd Tour Sandbox\n".write(toFile: wt + "/README.md",
                                              atomically: true, encoding: .utf8)
        XCTAssertEqual(Git.run(["-c", "user.name=T", "-c", "user.email=t@t",
                                "commit", "-am", "Reword differently"], in: wt).code, 0)

        let merge = Git.run(["merge", OnboardingDemoRepo.conflictBranch], in: wt)
        XCTAssertNotEqual(merge.code, 0, "merge should have conflicted:\n\(merge.out)\(merge.err)")
        XCTAssertFalse(Git.run(["ls-files", "-u"], in: wt).out.isEmpty,
                       "expected an unmerged entry after the conflict")

        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
    }

    func testBuildIsIdempotentOverAnExistingSandbox() throws {
        try build()
        try build()
        XCTAssertEqual(git("rev-list", "--count", "main"), "3")
    }

    func testTeardownLeavesNothingBehind() throws {
        try build()
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root))
    }

    // The worktree lands outside the sandbox dir, so rm -rf on the sandbox alone
    // would leave both the directory and a stale registration behind.
    func testTeardownRemovesAWorktreeCreatedOutsideTheSandbox() throws {
        try build()
        let wt = worktreeBase + "/tour-repo/demo-branch"
        try FileManager.default.createDirectory(atPath: worktreeBase + "/tour-repo",
                                               withIntermediateDirectories: true)
        XCTAssertEqual(Git.run(["worktree", "add", "-b", "demo-branch", wt, "main"],
                                           in: paths.clone).code, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: wt))

        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: wt))
        XCTAssertFalse(FileManager.default.fileExists(atPath: worktreeBase + "/tour-repo"))
    }

    func testTeardownOnAnAbsentSandboxIsANoOp() {
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root))
    }
}
