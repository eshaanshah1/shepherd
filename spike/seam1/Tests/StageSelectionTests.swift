import XCTest
@testable import Shepherd

/// The stitched-row → `(file, hunk, line)` mapping. Staging correctness rests on this
/// walk matching the one that builds the document, so it is exercised directly.
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

    // MARK: - rowOrigins

    func testRowOriginsFlattensEveryHunkLineInDocumentOrder() {
        let files = [
            file("a.swift", [hunk([.context, .added]), hunk([.removed])]),
            file("b.swift", [hunk([.added])]),
        ]
        let origins = StageSelection.rowOrigins(files: files)

        XCTAssertEqual(origins.count, 4)
        XCTAssertEqual(origins[0], RowOrigin(path: "a.swift", hunkIndex: 0, lineIndex: 0, kind: .context))
        XCTAssertEqual(origins[1], RowOrigin(path: "a.swift", hunkIndex: 0, lineIndex: 1, kind: .added))
        XCTAssertEqual(origins[2], RowOrigin(path: "a.swift", hunkIndex: 1, lineIndex: 0, kind: .removed))
        XCTAssertEqual(origins[3], RowOrigin(path: "b.swift", hunkIndex: 0, lineIndex: 0, kind: .added))
    }

    /// Binary files get a header block but no text rows, so they must not consume an
    /// index — otherwise every row after one is off by the wrong amount.
    func testRowOriginsSkipsBinaryFiles() {
        let files = [
            file("logo.png", [], binary: true),
            file("a.swift", [hunk([.added])]),
        ]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(origins.count, 1)
        XCTAssertEqual(origins[0].path, "a.swift")
    }

    func testContextRowsAreNotStageable() {
        let origins = StageSelection.rowOrigins(files: [file("a.swift", [hunk([.context, .added, .removed])])])
        XCTAssertEqual(origins.map(\.isStageable), [false, true, true])
    }

    // MARK: - selections

    func testSelectionsGroupsRowsByFileAndHunk() {
        let files = [
            file("a.swift", [hunk([.added, .added]), hunk([.removed])]),
            file("b.swift", [hunk([.added])]),
        ]
        let origins = StageSelection.rowOrigins(files: files)
        // rows: 0,1 = a#0; 2 = a#1; 3 = b#0
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
        let origins = StageSelection.rowOrigins(files: files)
        let groups = StageSelection.selections(forStitchedLines: [1, 0], origins: origins, files: files)
        XCTAssertEqual(groups.map(\.path), ["a.swift", "b.swift"])
    }

    func testSelectionsDropsContextRowsAndOutOfRangeRows() {
        let files = [file("a.swift", [hunk([.context, .added])])]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(StageSelection.selections(forStitchedLines: [0, 99],
                                                 origins: origins, files: files), [])
        let groups = StageSelection.selections(forStitchedLines: [0, 1, 99],
                                               origins: origins, files: files)
        XCTAssertEqual(groups.first?.selections, [HunkSelection(hunkIndex: 0, lineIndices: [1])])
    }

    func testSelectionsCarriesRenameOldPathThroughToPatchSynth() {
        let files = [file("new.swift", [hunk([.added])], oldPath: "old.swift")]
        let origins = StageSelection.rowOrigins(files: files)
        let groups = StageSelection.selections(forStitchedLines: [0], origins: origins, files: files)
        XCTAssertEqual(groups.first?.oldPath, "old.swift")
    }

    // MARK: - hunk boundaries

    func testHunkRowsCoversTheWholeHunkAndNothingElse() {
        let files = [file("a.swift", [hunk([.context, .added]), hunk([.removed])])]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 0..<2)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 2, origins: origins), 2..<3)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 9, origins: origins), 0..<0)
    }

    /// Two files can each have a hunk 0; the path must be part of the identity.
    func testHunkRowsDoesNotBleedAcrossFilesWithTheSameHunkIndex() {
        let files = [file("a.swift", [hunk([.added])]), file("b.swift", [hunk([.added])])]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 0, origins: origins), 0..<1)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 1..<2)
    }

    /// Found from the middle of a hunk, both edges must be walked — not just forward.
    func testHunkRowsWalksBackwardFromTheMiddle() {
        let files = [file("a.swift", [hunk([.added, .added, .added]), hunk([.removed])])]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 1, origins: origins), 0..<3)
        XCTAssertEqual(StageSelection.hunkRows(atStitchedLine: 2, origins: origins), 0..<3)
    }

    func testHunkStartsListsEveryHunkBoundary() {
        let files = [
            file("a.swift", [hunk([.context, .added]), hunk([.removed])]),
            file("b.swift", [hunk([.added, .added])]),
        ]
        let origins = StageSelection.rowOrigins(files: files)
        XCTAssertEqual(StageSelection.hunkStarts(origins: origins), [0, 2, 3])
    }

    func testHunkNavigationWraps() {
        let files = [file("a.swift", [hunk([.added]), hunk([.added]), hunk([.added])])]
        let origins = StageSelection.rowOrigins(files: files)   // starts 0, 1, 2

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
        let origins = StageSelection.rowOrigins(files: files)   // starts 0, 2
        XCTAssertEqual(StageSelection.hunkStart(before: 3, origins: origins), 0)
    }

    func testHunkNavigationOnAnEmptyDocument() {
        XCTAssertNil(StageSelection.hunkStart(after: nil, origins: []))
        XCTAssertNil(StageSelection.hunkStart(before: 0, origins: []))
    }

    // MARK: - end-to-end with PatchSynth

    /// The selection path's real output: rows in, a patch git could take out.
    func testSelectedRowsSynthesizeAPatchThatKeepsUnselectedRemovalsAsContext() {
        let hunkLines = [
            DiffLine(kind: .context, text: "keep", oldLineNo: 1, newLineNo: 1),
            DiffLine(kind: .removed, text: "gone", oldLineNo: 2, newLineNo: nil),
            DiffLine(kind: .removed, text: "stays", oldLineNo: 3, newLineNo: nil),
        ]
        let files = [file("a.swift", [DiffHunk(header: "@@ -1,3 +1,1 @@", oldStart: 1, oldCount: 3,
                                               newStart: 1, newCount: 1, lines: hunkLines)])]
        let origins = StageSelection.rowOrigins(files: files)
        let groups = StageSelection.selections(forStitchedLines: [1], origins: origins, files: files)
        let patch = PatchSynth.patch(path: "a.swift", oldPath: groups[0].oldPath,
                                     hunks: groups[0].hunks, selections: groups[0].selections)

        XCTAssertEqual(patch, """
        diff --git a/a.swift b/a.swift
        --- a/a.swift
        +++ b/a.swift
        @@ -1,3 +1,2 @@
         keep
        -gone
         stays

        """)
    }
}
