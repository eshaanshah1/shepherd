import XCTest
@testable import Shepherd

final class RepoSignalsTests: XCTestCase {

    // MARK: unmergedCount

    /// `ls-files -u` prints one record PER STAGE, so a single conflicted file arrives as
    /// three records. Counting records instead of paths triples the number.
    func testUnmergedCountCollapsesStagesToPaths() {
        let z = "100644 aaa 1\tsrc/a.swift\0"
              + "100644 bbb 2\tsrc/a.swift\0"
              + "100644 ccc 3\tsrc/a.swift\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    func testUnmergedCountTwoPaths() {
        let z = "100644 aaa 1\tsrc/a.swift\0"
              + "100644 bbb 2\tsrc/a.swift\0"
              + "100644 ccc 2\tdocs/b.md\0"
              + "100644 ddd 3\tdocs/b.md\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 2)
    }

    /// A delete/modify conflict has only two stages. It is still one conflicted path.
    func testUnmergedCountTwoStageConflict() {
        let z = "100644 aaa 1\tgone.txt\0100644 bbb 2\tgone.txt\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    func testUnmergedCountEmpty() {
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: ""), 0)
    }

    /// A path containing a space or a tab must not be split further — the delimiter is the
    /// FIRST tab, and `-z` means the record ends at the NUL, not at a newline.
    func testUnmergedCountPathWithSpaceAndTab() {
        let z = "100644 aaa 2\tsrc/my file\twith tab.swift\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    // MARK: dirtyCount

    func testDirtyCountCountsPorcelainLines() {
        let p = " M src/a.swift\nA  src/b.swift\n?? untracked.txt\n"
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: p), 3)
    }

    /// A rename is one change, and git writes it on one line.
    func testDirtyCountRenameIsOneLine() {
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: "R  old.txt -> new.txt\n"), 1)
    }

    func testDirtyCountCleanTree() {
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: ""), 0)
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: "\n\n"), 0)
    }

    // MARK: parseStatusV2
    //
    // Every fixture below is literal `git status --porcelain=v2 --branch` output, captured
    // from git 2.55 — this parser replaced five separate git invocations, so it has to agree
    // with what they returned, not with what the format looks like it should say.

    func testStatusV2ReadsBranchUpstreamAndAhead() {
        let out = """
        # branch.oid e68969f14acf975abda30196d1cbbb156bd5f682
        # branch.head master
        # branch.upstream origin/master
        # branch.ab +1 -0
        1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 b77b4eb1d946f923f61785536da9ca5af6909f06 staged.txt
        1 .M N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 tracked.txt
        ? untracked.txt
        """
        let s = RepoSignals.parseStatusV2(out)
        XCTAssertEqual(s.branch, "master")
        XCTAssertTrue(s.hasUpstream)
        XCTAssertEqual(s.ahead, 1)
        XCTAssertEqual(s.dirty, 3)       // staged + modified + untracked, as `--porcelain` counted
        XCTAssertEqual(s.conflicts, 0)
    }

    /// The `u` record is one per **path**, where `ls-files -u` printed one per index stage —
    /// so this must agree with `unmergedCount` on the same conflict, which is 1, not 3.
    func testStatusV2CountsUnmergedPathsOnce() {
        let out = """
        # branch.oid bc7b95e3bbf68338ac8283613d961ca0c9bbf921
        # branch.head master
        1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 9de77c18733ab8009a956c25e28c85fe203a17d7 only-feature.txt
        u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 1f7391f92b6a3792204e07e99f71f643cc35e7e1 a7453f07505c42ea8d6fdda75fa91710c81c53d6 c.txt
        """
        let s = RepoSignals.parseStatusV2(out)
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.dirty, 2)       // a conflicted path is also a change
        XCTAssertFalse(s.hasUpstream)
        XCTAssertEqual(s.ahead, 0)       // no upstream ⇒ git prints no `branch.ab` to read

        let lsFilesZ = "100644 df96 1\tc.txt\0100644 1f73 2\tc.txt\0100644 a745 3\tc.txt\0"
        XCTAssertEqual(s.conflicts, RepoSignals.unmergedCount(lsFilesZ: lsFilesZ))
    }

    /// `currentBranch` returned nil off a branch; `(detached)` is how v2 says the same thing.
    func testStatusV2DetachedHeadHasNoBranch() {
        let out = """
        # branch.oid bc7b95e3bbf68338ac8283613d961ca0c9bbf921
        # branch.head (detached)
        """
        let s = RepoSignals.parseStatusV2(out)
        XCTAssertNil(s.branch)
        XCTAssertEqual(s.dirty, 0)
    }

    func testStatusV2CleanTreeIsHeaderOnly() {
        let out = """
        # branch.oid bc7b95e3bbf68338ac8283613d961ca0c9bbf921
        # branch.head master
        """
        let s = RepoSignals.parseStatusV2(out)
        XCTAssertEqual(s.branch, "master")
        XCTAssertEqual(s.dirty, 0)
        XCTAssertEqual(s.conflicts, 0)
    }

    /// A rename is one `2` record, as it was one `--porcelain` line.
    func testStatusV2RenameIsOneChange() {
        let out = """
        # branch.head main
        2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt
        """
        XCTAssertEqual(RepoSignals.parseStatusV2(out).dirty, 1)
    }

    func testStatusV2EmptyOutput() {
        let s = RepoSignals.parseStatusV2("")
        XCTAssertNil(s.branch)
        XCTAssertEqual(s.dirty, 0)
        XCTAssertFalse(s.hasUpstream)
    }

    // MARK: revCount

    func testRevCountParsesTrimmedInteger() {
        XCTAssertEqual(RepoSignals.revCount("3\n"), 3)
        XCTAssertEqual(RepoSignals.revCount("  12  "), 12)
    }

    /// A repo with no commits makes `rev-list` fail and print nothing. Zero, not a crash.
    func testRevCountGarbageIsZero() {
        XCTAssertEqual(RepoSignals.revCount(""), 0)
        XCTAssertEqual(RepoSignals.revCount("fatal: bad revision"), 0)
    }

    // MARK: the struct

    func testNoneIsIdleAndEmpty() {
        let s = RepoSignals.none
        XCTAssertEqual(s.state, .idle)
        XCTAssertEqual(s.conflicts, 0)
        XCTAssertEqual(s.dirty, 0)
        XCTAssertEqual(s.ahead, 0)
        XCTAssertFalse(s.hasUpstream)
        XCTAssertNil(s.branch)
    }
}
