import XCTest
@testable import Shepherd

/// The three-way merge. Getting this wrong either asks the user about something both sides
/// agreed on, or — far worse — silently picks a side on something they didn't.
final class Diff3Tests: XCTestCase {

    // MARK: - Everything agrees

    func testIdenticalSidesAreOneStableRun() {
        let lines = ["a", "b", "c"]
        XCTAssertEqual(Diff3.merge(base: lines, ours: lines, theirs: lines),
                       [.stable(["a", "b", "c"])])
    }

    func testAllEmptyProducesNothing() {
        XCTAssertEqual(Diff3.merge(base: [], ours: [], theirs: []), [])
    }

    // MARK: - Auto-resolution (one side changed)

    func testOnlyOursChangedTakesOursSilently() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b"], ours: ["a", "X", "b"], theirs: ["a", "b"]),
            [.stable(["a", "X", "b"])])
    }

    func testOnlyTheirsChangedTakesTheirsSilently() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b"], ours: ["a", "b"], theirs: ["a", "Y", "b"]),
            [.stable(["a", "Y", "b"])])
    }

    func testBothSidesMadeTheSameChange() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b"], ours: ["a", "X", "b"], theirs: ["a", "X", "b"]),
            [.stable(["a", "X", "b"])])
    }

    func testALineDeletedByBothSidesIsNotAConflict() {
        XCTAssertEqual(Diff3.merge(base: ["a", "b", "c"], ours: ["a", "c"], theirs: ["a", "c"]),
                       [.stable(["a", "c"])])
    }

    func testOnlyOursDeletedALine() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b", "c"], ours: ["a", "c"], theirs: ["a", "b", "c"]),
            [.stable(["a", "c"])])
    }

    // MARK: - Genuine conflicts

    func testBothSidesChangedTheSameLineDifferently() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b", "c"], ours: ["a", "X", "c"], theirs: ["a", "Y", "c"]),
            [.stable(["a"]),
             .conflict(base: ["b"], ours: ["X"], theirs: ["Y"]),
             .stable(["c"])])
    }

    func testAConflictAtTheStartOfTheFile() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "z"], ours: ["X", "z"], theirs: ["Y", "z"]),
            [.conflict(base: ["a"], ours: ["X"], theirs: ["Y"]),
             .stable(["z"])])
    }

    func testAConflictAtTheEndOfTheFile() {
        XCTAssertEqual(
            Diff3.merge(base: ["z", "a"], ours: ["z", "X"], theirs: ["z", "Y"]),
            [.stable(["z"]),
             .conflict(base: ["a"], ours: ["X"], theirs: ["Y"])])
    }

    func testTwoSeparateConflictsInOneFile() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "m", "b"],
                        ours: ["X", "m", "P"],
                        theirs: ["Y", "m", "Q"]),
            [.conflict(base: ["a"], ours: ["X"], theirs: ["Y"]),
             .stable(["m"]),
             .conflict(base: ["b"], ours: ["P"], theirs: ["Q"])])
    }

    func testBothSidesInsertedDifferentTextAtTheSamePoint() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b"], ours: ["a", "X", "b"], theirs: ["a", "Y", "b"]),
            [.stable(["a"]),
             .conflict(base: [], ours: ["X"], theirs: ["Y"]),
             .stable(["b"])])
    }

    func testOneSideDeletedWhatTheOtherEdited() {
        XCTAssertEqual(
            Diff3.merge(base: ["a", "b", "c"], ours: ["a", "c"], theirs: ["a", "B", "c"]),
            [.stable(["a"]),
             .conflict(base: ["b"], ours: [], theirs: ["B"]),
             .stable(["c"])])
    }

    // MARK: - No common ancestor (add/add)

    func testAnEmptyBaseMakesTheWholeFileOneConflict() {
        XCTAssertEqual(
            Diff3.merge(base: [], ours: ["a"], theirs: ["b"]),
            [.conflict(base: [], ours: ["a"], theirs: ["b"])])
    }

    func testAnEmptyBaseWithIdenticalSidesIsNotAConflict() {
        XCTAssertEqual(Diff3.merge(base: [], ours: ["a"], theirs: ["a"]),
                       [.stable(["a"])])
    }

    func testAnEmptyOursSideAgainstAPopulatedTheirs() {
        XCTAssertEqual(
            Diff3.merge(base: ["a"], ours: [], theirs: ["b"]),
            [.conflict(base: ["a"], ours: [], theirs: ["b"])])
    }

    // MARK: - zdiff3-style trimming

    func testSharedLeadingLinesAreHoistedOutOfTheConflict() {
        // Both sides prepended "p"; only the second line actually disagrees.
        XCTAssertEqual(
            Diff3.merge(base: ["a"], ours: ["p", "q", "a"], theirs: ["p", "r", "a"]),
            [.stable(["p"]),
             .conflict(base: [], ours: ["q"], theirs: ["r"]),
             .stable(["a"])])
    }

    func testSharedTrailingLinesAreHoistedOutOfTheConflict() {
        XCTAssertEqual(
            Diff3.merge(base: ["a"], ours: ["q", "s", "a"], theirs: ["r", "s", "a"]),
            [.conflict(base: [], ours: ["q"], theirs: ["r"]),
             .stable(["s", "a"])])
    }

    func testTrimmingBothEndsLeavesOnlyTheDisagreement() {
        XCTAssertEqual(
            Diff3.merge(base: ["mid"],
                        ours: ["head", "ours", "tail"],
                        theirs: ["head", "theirs", "tail"]),
            [.stable(["head"]),
             .conflict(base: ["mid"], ours: ["ours"], theirs: ["theirs"]),
             .stable(["tail"])])
    }

    // MARK: - Robustness

    /// The bounds come from two independent alignment walks. An inverted `Range` traps and
    /// takes the process down, which is how the equivalent bug in `RowPlanner` was found —
    /// by crashing the test runner rather than the app.
    func testHeavilyReorderedInputDoesNotTrap() {
        let base = ["1", "2", "3", "4", "5", "6"]
        let ours = ["6", "5", "4", "3", "2", "1"]
        let theirs = ["3", "1", "6", "2", "5", "4"]
        let regions = Diff3.merge(base: base, ours: ours, theirs: theirs)
        XCTAssertFalse(regions.isEmpty)
    }

    /// Replay a merge, picking the same side at every conflict.
    private func replay(_ regions: [MergeRegion], taking side: MergeSide) -> [String] {
        regions.flatMap { region -> [String] in
            switch region {
            case .stable(let lines):
                return lines
            case .conflict(_, let ours, let theirs):
                return side == .ours ? ours : theirs
            }
        }
    }

    /// When every divergence is a genuine conflict, replaying one side must reproduce that
    /// side exactly — otherwise the merge is dropping or duplicating lines.
    func testReplayingOneSideReconstructsItWhenEveryChangeConflicts() {
        let base = ["a", "b", "c", "d", "e"]
        let ours = ["a", "X", "c", "P", "e"]
        let theirs = ["a", "Y", "c", "Q", "e"]
        let regions = Diff3.merge(base: base, ours: ours, theirs: theirs)
        XCTAssertEqual(replay(regions, taking: .ours), ours)
        XCTAssertEqual(replay(regions, taking: .theirs), theirs)
    }

    /// The point of a three-way merge: a change only one side made is **not** a decision,
    /// so it survives whichever side you pick at the conflicts. Asserting that replaying
    /// "theirs" reproduces theirs verbatim would be asserting the opposite — that picking
    /// theirs discards everything you did.
    func testOneSidedChangesSurviveWhicheverSideWinsTheConflicts() {
        let base = ["a", "b", "c", "d", "e"]
        let ours = ["a", "X", "c", "D", "e", "f"]   // D and f are ours alone
        let theirs = ["a", "Y", "c", "d", "e"]
        let regions = Diff3.merge(base: base, ours: ours, theirs: theirs)
        XCTAssertEqual(replay(regions, taking: .ours), ["a", "X", "c", "D", "e", "f"])
        XCTAssertEqual(replay(regions, taking: .theirs), ["a", "Y", "c", "D", "e", "f"])
    }

    // MARK: - MergeText

    func testATrailingNewlineDoesNotBecomeAPhantomLine() {
        XCTAssertEqual(MergeText.lines("a\nb\n"), ["a", "b"])
    }

    func testAFileWithoutATrailingNewlineKeepsItsLastLine() {
        XCTAssertEqual(MergeText.lines("a\nb"), ["a", "b"])
    }

    func testRejoiningRestoresTheTrailingNewline() {
        XCTAssertEqual(MergeText.blob(["a", "b"]), "a\nb\n")
    }

    func testAnEmptyLineListRejoinsToAnEmptyFile() {
        XCTAssertEqual(MergeText.blob([]), "")
    }

    func testABlankLineInTheMiddleSurvivesTheRoundTrip() {
        XCTAssertEqual(MergeText.blob(MergeText.lines("a\n\nb\n")), "a\n\nb\n")
    }
}
