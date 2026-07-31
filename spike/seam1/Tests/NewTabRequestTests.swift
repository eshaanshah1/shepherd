import XCTest
@testable import Shepherd

private func localRepo() -> NewTabTarget {
    NewTabTarget(workspaceID: "w1", name: "shepherd", isRemote: false, isGitRepo: true)
}
private func localPlain() -> NewTabTarget {
    NewTabTarget(workspaceID: "w2", name: "notes", isRemote: false, isGitRepo: false)
}
private func mirror() -> NewTabTarget {
    NewTabTarget(workspaceID: "w3", name: "mac-mini", isRemote: true, isGitRepo: true)
}

final class NewTabRequestTests: XCTestCase {

    // MARK: slug

    func testSlugLowercasesAndHyphenatesSpaces() {
        XCTAssertEqual(NewTabRequest.slug("Fix Auth Bug"), "fix-auth-bug")
    }

    func testSlugDropsCharactersGitRefusesInARefName() {
        XCTAssertEqual(NewTabRequest.slug("wip: ~caret^ [x] q?"), "wip-caret-x-q")
    }

    func testSlugCollapsesRunsAndTrimsEdges() {
        XCTAssertEqual(NewTabRequest.slug("  --hello   world--  "), "hello-world")
    }

    func testSlugKeepsSlashesAndDotsGitAllows() {
        XCTAssertEqual(NewTabRequest.slug("feature/new.tab"), "feature/new.tab")
    }

    func testSlugRemovesDoubleDotsAndLockSuffix() {
        XCTAssertEqual(NewTabRequest.slug("a..b.lock"), "a-b")
    }

    func testSlugOfEmptyIsEmpty() {
        XCTAssertEqual(NewTabRequest.slug("   "), "")
    }

    // MARK: mirroring

    func testBranchMirrorsSluggedTitleUntilEdited() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        XCTAssertEqual(r.branch, "fix-auth")
    }

    func testEditingBranchDetachesItFromTheTitle() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        r.setBranch("auth-v2")
        r.title = "Something Else"
        XCTAssertEqual(r.branch, "auth-v2")
    }

    func testDetachIsOneWayEvenWhenClearedToEmpty() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        r.setBranch("")
        XCTAssertEqual(r.branch, "")
    }

    // MARK: availability

    func testWorktreeUnavailableWithoutAGitRepo() {
        var r = NewTabRequest(target: localPlain(), worktree: true)
        r.title = "x"
        XCTAssertFalse(r.worktreeAvailable)
        XCTAssertFalse(r.usesWorktree)          // the toggle cannot force it on
        XCTAssertNotNil(r.worktreeHint)
    }

    func testWorktreeAvailableOnAMirrorWithAWiredPath() {
        let r = NewTabRequest(target: mirror())
        XCTAssertTrue(r.worktreeAvailable)
        XCTAssertNil(r.worktreeHint)
    }

    func testPromptUnavailableOnAMirror() {
        var r = NewTabRequest(target: mirror())
        r.prompt = "do the thing"
        XCTAssertFalse(r.promptAvailable)
        XCTAssertEqual(r.effectivePrompt, "")   // never sent where it cannot run
        XCTAssertNotNil(r.promptHint)
    }

    func testRetargetRecomputesAvailability() {
        var r = NewTabRequest(target: localRepo(), worktree: true)
        r.title = "x"
        XCTAssertTrue(r.usesWorktree)
        r.retarget(localPlain())
        XCTAssertFalse(r.usesWorktree)
    }

    // MARK: canCreate

    func testCanCreateWithEverythingEmpty() {
        XCTAssertTrue(NewTabRequest(target: localPlain()).canCreate)
    }

    func testCannotCreateWithWorktreeOnAndNoBranch() {
        var r = NewTabRequest(target: localRepo(), worktree: true)
        XCTAssertFalse(r.canCreate)
        XCTAssertNotNil(r.createHint)
        r.title = "Fix Auth"
        XCTAssertTrue(r.canCreate)
        XCTAssertNil(r.createHint)
    }

    func testCanCreateWithWorktreeOnButUnavailable() {
        let r = NewTabRequest(target: localPlain(), worktree: true)
        XCTAssertTrue(r.canCreate)              // it degrades to a plain tab
    }

    func testTitleWhitespaceOnlyIsNoTitle() {
        var r = NewTabRequest(target: localPlain())
        r.title = "   "
        XCTAssertNil(r.effectiveTitle)
        r.title = "  Notes "
        XCTAssertEqual(r.effectiveTitle, "Notes")
    }

    func testEffectivePromptIsTrimmed() {
        var r = NewTabRequest(target: localPlain())
        r.prompt = "\n  ship it \n"
        XCTAssertEqual(r.effectivePrompt, "ship it")
    }
}
