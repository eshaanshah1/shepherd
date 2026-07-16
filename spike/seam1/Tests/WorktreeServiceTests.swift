import XCTest

final class WorktreeServiceTests: XCTestCase {
    func testWorktreePathLayout() {
        XCTAssertEqual(worktreePath(base: "/wt", repoDir: "/a/b/shepherd", name: "feat"),
                       "/wt/shepherd/feat")
    }
    func testWorktreePathTrailingSlashRepo() {
        XCTAssertEqual(worktreePath(base: "/wt", repoDir: "/a/b/shepherd/", name: "feat"),
                       "/wt/shepherd/feat")
    }
    func testWorktreePathTildeBasePreserved() {
        XCTAssertEqual(worktreePath(base: "~/code/wt", repoDir: "/x/repo", name: "b"),
                       "~/code/wt/repo/b")
    }
    func testWorktreeAddArgsNewBranch() {
        // A new branch is based on the freshly-fetched, auto-detected default branch.
        XCTAssertEqual(worktreeAddArgs(dest: "/d", name: "b", branchExists: false, baseRef: "origin/master"),
                       ["worktree", "add", "/d", "-b", "b", "origin/master"])
    }
    func testWorktreeAddArgsExistingBranch() {
        // Existing branch: reused as-is, so baseRef is ignored.
        XCTAssertEqual(worktreeAddArgs(dest: "/d", name: "b", branchExists: true, baseRef: "origin/main"),
                       ["worktree", "add", "/d", "b"])
    }
    func testParseConfigWorktreeBase() {
        let c = parseShepherdConfig("# shepherd: worktree-base = ~/code/wt\nbackground = 000")
        XCTAssertEqual(c.worktreeBase, "~/code/wt")
    }
    func testParseConfigExtraSpacing() {
        let c = parseShepherdConfig("#   shepherd:   worktree-base   =   /tmp/wt  ")
        XCTAssertEqual(c.worktreeBase, "/tmp/wt")
    }
    func testParseConfigAbsentKey() {
        let c = parseShepherdConfig("background = 000\n# a normal comment")
        XCTAssertNil(c.worktreeBase)
    }
    func testParseConfigIgnoresPlainGhosttyLine() {
        // A non-comment `worktree-base` line is a ghostty key, not ours — ignored.
        let c = parseShepherdConfig("worktree-base = /should/not/apply")
        XCTAssertNil(c.worktreeBase)
    }

    func testParseConfigThemeDefaultsDark() {
        XCTAssertEqual(parseShepherdConfig("background = 000").theme, .dark)
    }
    func testParseConfigThemeLight() {
        let c = parseShepherdConfig("# shepherd: theme = light")
        XCTAssertEqual(c.theme, .light)
    }
    func testParseConfigThemeDarkExplicit() {
        let c = parseShepherdConfig("# shepherd: theme = dark")
        XCTAssertEqual(c.theme, .dark)
    }
    func testParseConfigThemeWarm() {
        let c = parseShepherdConfig("# shepherd: theme = warm")
        XCTAssertEqual(c.theme, .warm)
    }
    func testParseConfigThemeGarbageFallsBackDark() {
        let c = parseShepherdConfig("# shepherd: theme = solarized")
        XCTAssertEqual(c.theme, .dark)
    }
    func testParseConfigThemeExtraSpacingCaseInsensitive() {
        let c = parseShepherdConfig("#   shepherd:   theme   =   LIGHT  ")
        XCTAssertEqual(c.theme, .light)
    }
}
