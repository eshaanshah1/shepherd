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
