import XCTest
@testable import Shepherd

/// The conflict document's layout. `RowPlanner` is the single authority on what a row index
/// means, so a disagreement between this walk and what the buffer actually contains is the
/// exact class of bug that mangled syntax highlighting on the first live run.
final class ConflictRowPlanTests: XCTestCase {

    private func file(_ regions: [MergeRegion], path: String = "App.swift",
                      kind: ConflictKind = .content) -> MergeFile {
        MergeFile(path: path, kind: kind, regions: regions,
                  oursLabel: "main", theirsLabel: "feature")
    }

    private let conflicted: [MergeRegion] = [
        .stable(["top"]),
        .conflict(base: ["was"], ours: ["mine"], theirs: ["yours"]),
        .stable(["bottom"]),
    ]

    private func bands(_ plan: RowPlan) -> [PlannedBand] { plan.blocks.map(\.band) }

    // MARK: - Rows are the preview

    /// The invariant everything else rests on: the rows the planner lays out and the text
    /// the session materializes come from the same place.
    func testRowsMatchTheMergePreviewExactly() {
        let subject = file(conflicted)
        for resolution in Resolution.allCases {
            let ids = [subject.conflicts[0].id: resolution]
            let plan = RowPlanner.planConflicts([subject], resolutions: ids)
            XCTAssertEqual(plan.origins.count,
                           MergeOutput.preview(subject, resolutions: ids).count,
                           "row count drifted from the preview for \(resolution)")
        }
    }

    func testAnUndecidedConflictLaysOutBothSides() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        XCTAssertEqual(plan.origins.count, 4)   // top, mine, yours, bottom
        XCTAssertEqual(plan.origins.map(\.conflictSide),
                       [nil, .ours, .theirs, nil])
    }

    /// The markers are bands, never rows. The document is what `Resolve` writes, so a
    /// marker that were a text row could reach a file; as a band it cannot.
    func testMarkersAreBandsAndNeverRows() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        let markers = bands(plan).filter {
            if case .conflictMarker = $0 { return true } else { return false }
        }
        XCTAssertEqual(markers.count, 2, "a separator and a closer")
        // Four rows: top, mine, yours, bottom. No marker text among them.
        XCTAssertEqual(plan.origins.count, 4)
    }

    func testDecidingAConflictDropsItsMarkers() {
        let subject = file(conflicted)
        let plan = RowPlanner.planConflicts(
            [subject], resolutions: [subject.conflicts[0].id: .ours])
        XCTAssertFalse(bands(plan).contains {
            if case .conflictMarker = $0 { return true } else { return false }
        })
        XCTAssertEqual(plan.origins.count, 3)   // top, mine, bottom
    }

    func testTakingBothSidesLaysOutBothAsRows() {
        let subject = file(conflicted)
        let plan = RowPlanner.planConflicts(
            [subject], resolutions: [subject.conflicts[0].id: .bothOursFirst])
        XCTAssertEqual(plan.origins.count, 4)   // top, mine, yours, bottom
        XCTAssertEqual(plan.origins.map(\.conflictSide), [nil, .ours, .theirs, nil])
    }

    // MARK: - Row identity

    func testPreviewNumbersRunConsecutivelyFromOne() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        XCTAssertEqual(plan.origins.map(\.newLineNumber), [1, 2, 3, 4])
    }

    func testOnlyConflictRowsCarryAConflictID() {
        let subject = file(conflicted)
        let plan = RowPlanner.planConflicts([subject], resolutions: [:])
        let id = subject.conflicts[0].id
        XCTAssertEqual(plan.origins.map(\.conflictID), [nil, id, id, nil])
    }

    /// A synthetic row must never reach `PatchSynth` — it describes a line that is in no
    /// file, so a patch built from it would apply somewhere arbitrary.
    func testNoConflictRowIsStageable() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        XCTAssertFalse(plan.origins.contains { $0.isStageable })
        XCTAssertTrue(plan.origins.allSatisfy { $0.lineIndex == -1 })
    }

    func testRowsCarryNoOldSideNumber() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        XCTAssertTrue(plan.origins.allSatisfy { $0.oldLineNumber == nil })
    }

    // MARK: - Bands

    func testEachFileGetsAHeaderAndEachConflictGetsControls() {
        let subject = file([
            .conflict(base: [], ours: ["a"], theirs: ["b"]),
            .stable(["m"]),
            .conflict(base: [], ours: ["c"], theirs: ["d"]),
        ])
        let plan = RowPlanner.planConflicts([subject], resolutions: [:])
        let controls = bands(plan).compactMap { band -> (String, Int, Int)? in
            guard case .conflictControls(_, let id, let index, let total) = band else {
                return nil
            }
            return (id, index, total)
        }
        XCTAssertEqual(controls.map(\.0), ["App.swift#1", "App.swift#2"])
        XCTAssertEqual(controls.map(\.1), [1, 2])
        XCTAssertEqual(controls.map(\.2), [2, 2], "each strip knows the file's total")
    }

    func testTheClosingMarkerNamesTheSideItCloses() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        let closers = bands(plan).compactMap { band -> (String, MergeSide?)? in
            guard case .conflictMarker(_, _, let label, let side, true) = band else { return nil }
            return (label, side)
        }
        XCTAssertEqual(closers.count, 1)
        XCTAssertEqual(closers.first?.0, "feature")
        XCTAssertEqual(closers.first?.1, .theirs)
    }

    func testTheSeparatorBelongsToNeitherSide() {
        let plan = RowPlanner.planConflicts([file(conflicted)], resolutions: [:])
        let separators = bands(plan).compactMap { band -> MergeSide?? in
            guard case .conflictMarker(_, _, _, let side, false) = band else { return nil }
            return side
        }
        XCTAssertEqual(separators.count, 1)
        XCTAssertEqual(separators.first ?? .some(.ours), MergeSide?.none)
    }

    func testTakingBothTheirsFirstPutsTheirsAbove() {
        let subject = file(conflicted)
        let plan = RowPlanner.planConflicts(
            [subject], resolutions: [subject.conflicts[0].id: .bothTheirsFirst])
        XCTAssertEqual(plan.origins.map(\.conflictSide),
                       [nil, .theirs, .ours, nil])
    }

    func testBandIdsAreStableAcrossAResolutionChange() {
        let subject = file(conflicted)
        let undecided = RowPlanner.planConflicts([subject], resolutions: [:])
        let decided = RowPlanner.planConflicts(
            [subject], resolutions: [subject.conflicts[0].id: .ours])
        let controlsID = { (plan: RowPlan) in
            plan.blocks.first { if case .conflictControls = $0.band { return true }
                                else { return false } }?.id
        }
        XCTAssertEqual(controlsID(undecided), controlsID(decided))
    }

    // MARK: - Whole-file conflicts

    func testAWholeFileConflictGetsControlsAndNoRows() {
        let subject = MergeFile.wholeFile(path: "logo.png", kind: .binary,
                                          oursLabel: "main", theirsLabel: "feature")
        let plan = RowPlanner.planConflicts([subject], resolutions: [:])
        XCTAssertTrue(plan.origins.isEmpty)
        XCTAssertTrue(plan.excerpts.isEmpty)
        XCTAssertEqual(bands(plan).count, 2)   // header + controls
        XCTAssertTrue(bands(plan).contains { if case .conflictControls = $0 { return true }
                                             else { return false } })
    }

    // MARK: - Multiple files

    func testExcerptsTileEveryRowAcrossFiles() {
        let plan = RowPlanner.planConflicts(
            [file(conflicted, path: "A.swift"), file(conflicted, path: "B.swift")],
            resolutions: [:])
        XCTAssertEqual(plan.origins.count, 8)
        XCTAssertEqual(plan.excerpts.map(\.rows), [0..<4, 4..<8])
        // Each excerpt's source span is as long as its rows, which is what makes a lookup
        // through it arithmetic rather than a guess.
        for excerpt in plan.excerpts {
            XCTAssertEqual(excerpt.rows.count, excerpt.sourceLines.count)
            XCTAssertEqual(excerpt.kind, .conflict)
        }
    }

    func testEachFileNumbersItsOwnPreviewFromOne() {
        let plan = RowPlanner.planConflicts(
            [file(conflicted, path: "A.swift"), file(conflicted, path: "B.swift")],
            resolutions: [:])
        XCTAssertEqual(plan.origins.map(\.newLineNumber), [1, 2, 3, 4, 1, 2, 3, 4])
        XCTAssertEqual(Set(plan.origins.map(\.path)), ["A.swift", "B.swift"])
    }

    func testConflictIDsFromDifferentFilesDoNotCollide() {
        let plan = RowPlanner.planConflicts(
            [file(conflicted, path: "A.swift"), file(conflicted, path: "B.swift")],
            resolutions: [:])
        XCTAssertEqual(Set(plan.origins.compactMap(\.conflictID)),
                       ["A.swift#1", "B.swift#1"])
    }

    // MARK: - Degenerate input

    func testAFileWithNothingToDecideIsJustItsRows() {
        let plan = RowPlanner.planConflicts([file([.stable(["a", "b"])])], resolutions: [:])
        XCTAssertEqual(plan.origins.count, 2)
        XCTAssertTrue(plan.origins.allSatisfy { $0.conflictID == nil })
    }

    func testAnEmptyFileListPlansNothing() {
        let plan = RowPlanner.planConflicts([], resolutions: [:])
        XCTAssertTrue(plan.origins.isEmpty)
        XCTAssertTrue(plan.blocks.isEmpty)
    }

    /// A side that deleted everything contributes no rows, and no band for the empty side.
    /// One side deleting everything is still a decision with two visible options — the
    /// empty side contributes no rows, but the markers still bound the region.
    func testAConflictWhereOneSideIsEmpty() {
        let subject = file([.conflict(base: ["was"], ours: [], theirs: ["yours"])])
        let plan = RowPlanner.planConflicts([subject], resolutions: [:])
        XCTAssertEqual(plan.origins.map(\.conflictSide), [.theirs])
        XCTAssertEqual(bands(plan).filter {
            if case .conflictMarker = $0 { return true } else { return false }
        }.count, 2)
    }
}
