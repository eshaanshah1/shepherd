import XCTest
@testable import Shepherd

/// The stitched-row → `(file, hunk, line)` mapping. Staging correctness rests on this
/// grouping matching the walk that built the document, so both run off the same
/// `RowPlanner` output the app uses. The forward walk itself is `RowPlanTests`.
final class StageSelectionTests: XCTestCase {

    // MARK: - Fixtures

    private func line(_ kind: DiffLineKind, _ text: String) -> DiffLine {
        switch kind {
        case .added:   return DiffLine(kind: .added, text: text, oldLineNo: nil, newLineNo: 1)
        case .removed: return DiffLine(kind: .removed, text: text, oldLineNo: 1, newLineNo: nil)
        case .context: return DiffLine(kind: .context, text: text, oldLineNo: 1, newLineNo: 1)
        }
    }

    private func hunk(_ kinds: [DiffLineKind]) -> DiffHunk {
        DiffHunk(header: "@@ -1,\(kinds.count) +1,\(kinds.count) @@",
                 oldStart: 1, oldCount: kinds.count, newStart: 1, newCount: kinds.count,
                 lines: kinds.enumerated().map { line($1, "l\($0)") })
    }

    private func file(_ path: String, _ hunks: [DiffHunk],
                     binary: Bool = false, oldPath: String? = nil) -> DiffFile {
        DiffFile(path: path, oldPath: oldPath, status: .modified, isBinary: binary,
                 hunks: hunks, addedCount: 0, removedCount: 0)
    }

    private func origins(_ files: [DiffFile]) -> [RowOrigin] {
        RowPlanner.plan(files: files).origins
    }

    // MARK: - selections

    func testSelectionsGroupsRowsByFileAndHunk() {
        let files = [
            file("a.swift", [hunk([.added, .added]), hunk([.removed, .context])]),
            file("b.swift", [hunk([.added])]),
        ]
        let origins = origins(files)
        // rows: 0,1 = a#0; 2 = a#1's context row (owning a#1's removal); 3 = b#0
        let groups = StageSelection.selections(forStitchedLines: [1, 2, 3],
                                               origins: origins, files: files)

        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].path, "a.swift")
        XCTAssertEqual(groups[0].selections, [HunkSelection(hunkIndex: 0, lineIndices: [1]),
                                              HunkSelection(hunkIndex: 1, lineIndices: [0])])
        XCTAssertEqual(groups[1].path, "b.swift")
        XCTAssertEqual(groups[1].selections, [HunkSelection(hunkIndex: 0, lineIndices: [0])])
    }

    func testSelectionsPreservesFileOrderRegardlessOfRowOrder() {
        let files = [file("a.swift", [hunk([.added])]), file("b.swift", [hunk([.added])])]
        let groups = StageSelection.selections(forStitchedLines: [1, 0],
                                               origins: origins(files), files: files)
        XCTAssertEqual(groups.map(\.path), ["a.swift", "b.swift"])
    }

    func testSelectionsDropsContextRowsAndOutOfRangeRows() {
        let files = [file("a.swift", [hunk([.context, .added])])]
        let origins = origins(files)
        XCTAssertEqual(StageSelection.selections(forStitchedLines: [0, 99],
                                                 origins: origins, files: files), [])
        let groups = StageSelection.selections(forStitchedLines: [0, 1, 99],
                                               origins: origins, files: files)
        XCTAssertEqual(groups.first?.selections, [HunkSelection(hunkIndex: 0, lineIndices: [1])])
    }

    func testSelectionsCarriesRenameOldPathThroughToPatchSynth() {
        let files = [file("new.swift", [hunk([.added])], oldPath: "old.swift")]
        let groups = StageSelection.selections(forStitchedLines: [0],
                                               origins: origins(files), files: files)
        XCTAssertEqual(groups.first?.oldPath, "old.swift")
    }

    // MARK: - hunk boundaries

    func testHunkRowsCoversTheWholeHunkAndNothingElse() {
        let files = [file("a.swift", [hunk([.context, .added]), hunk([.removed, .context])])]
        let origins = origins(files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 0..<2)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 2, origins: origins), 2..<3)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 9, origins: origins), 0..<0)
    }

    /// Two files can each have a hunk 0; the path must be part of the identity.
    func testHunkRowsDoesNotBleedAcrossFilesWithTheSameHunkIndex() {
        let files = [file("a.swift", [hunk([.added])]), file("b.swift", [hunk([.added])])]
        let origins = origins(files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 0, origins: origins), 0..<1)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 1..<2)
    }

    /// Found from the middle of a hunk, both edges must be walked — not just forward.
    func testHunkRowsWalksBackwardFromTheMiddle() {
        let files = [file("a.swift", [hunk([.added, .added, .added]), hunk([.removed, .context])])]
        let origins = origins(files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 0..<3)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 2, origins: origins), 0..<3)
    }

    func testHunkStartsListsEveryHunkBoundary() {
        let files = [
            file("a.swift", [hunk([.context, .added]), hunk([.removed, .context])]),
            file("b.swift", [hunk([.added, .added])]),
        ]
        XCTAssertEqual(StageSelection.hunkStarts(origins: origins(files)), [0, 2, 3])
    }

    func testHunkNavigationWraps() {
        let files = [file("a.swift", [hunk([.added]), hunk([.added]), hunk([.added])])]
        let origins = origins(files)   // starts 0, 1, 2

        XCTAssertEqual(StageSelection.hunkStart(after: nil, origins: origins), 0)
        XCTAssertEqual(StageSelection.hunkStart(after: 0, origins: origins), 1)
        XCTAssertEqual(StageSelection.hunkStart(after: 2, origins: origins), 0)

        XCTAssertEqual(StageSelection.hunkStart(before: nil, origins: origins), 2)
        XCTAssertEqual(StageSelection.hunkStart(before: 2, origins: origins), 1)
        XCTAssertEqual(StageSelection.hunkStart(before: 0, origins: origins), 2)
    }

    /// From the middle of a hunk, "previous" means the hunk before this one — not this
    /// hunk's own start, which is where an off-by-one here would land.
    func testHunkStartBeforeFromMidHunkSkipsToThePreviousHunk() {
        let files = [file("a.swift", [hunk([.added, .added]), hunk([.added, .added])])]
        let origins = origins(files)   // starts 0, 2
        XCTAssertEqual(StageSelection.hunkStart(before: 3, origins: origins), 0)
    }

    func testHunkNavigationOnAnEmptyDocument() {
        XCTAssertNil(StageSelection.hunkStart(after: nil, origins: []))
        XCTAssertNil(StageSelection.hunkStart(before: 0, origins: []))
    }

    // MARK: - end-to-end with PatchSynth

    /// The selection path's real output: rows in, a patch git could take out.
    ///
    /// Removals have no rows of their own, so the whole run the row owns goes in together —
    /// staging one deleted line out of a run is deferred, not silently half-applied.
    func testSelectingABandsOwnerStagesEveryRemovalInTheBand() {
        let hunkLines = [
            DiffLine(kind: .context, text: "keep", oldLineNo: 1, newLineNo: 1),
            DiffLine(kind: .removed, text: "gone", oldLineNo: 2, newLineNo: nil),
            DiffLine(kind: .removed, text: "also gone", oldLineNo: 3, newLineNo: nil),
        ]
        let files = [file("a.swift", [DiffHunk(header: "@@ -1,3 +1,1 @@", oldStart: 1, oldCount: 3,
                                               newStart: 1, newCount: 1, lines: hunkLines)])]
        let origins = origins(files)
        XCTAssertEqual(origins.count, 1)   // the context line; both removals are a band
        let groups = StageSelection.selections(forStitchedLines: [0],
                                               origins: origins, files: files)
        let patch = PatchSynth.patch(path: "a.swift", oldPath: groups[0].oldPath,
                                     hunks: groups[0].hunks, selections: groups[0].selections)

        XCTAssertEqual(patch, """
        diff --git a/a.swift b/a.swift
        --- a/a.swift
        +++ b/a.swift
        @@ -1,3 +1,1 @@
         keep
        -gone
        -also gone

        """)
    }
}
