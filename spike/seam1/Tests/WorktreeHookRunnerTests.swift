import XCTest
@testable import Shepherd

final class WorktreeHookRunnerTests: XCTestCase {
    func testHookEnvironmentMapsAllVars() {
        let env = WorktreeHookRunner.hookEnvironment(
            worktreeDir: "/wt/repo/feature",
            src: "/src/repo",
            branch: "feature",
            name: "feature",
            repoName: "repo")
        XCTAssertEqual(env["WORKTREE_DIR"], "/wt/repo/feature")
        XCTAssertEqual(env["WORKTREE_SRC"], "/src/repo")
        XCTAssertEqual(env["WORKTREE_BRANCH"], "feature")
        XCTAssertEqual(env["WORKTREE_NAME"], "feature")
        XCTAssertEqual(env["REPO_NAME"], "repo")
        XCTAssertEqual(env.count, 5)
    }
}
