import XCTest
@testable import Shepherd

/// The document layout: which diff lines become text rows, which become bands, and where
/// each band sits. Every W2 feature rests on "a text row is a real line of a real file",
/// so the walk that guarantees it is exercised directly.
final class RowPlanTests: XCTestCase {

    // MARK: - Fixtures

    /// A hunk with realistic line numbering, so the gutter numbers are testable.
    private func hunk(_ kinds: [DiffLineKind], oldStart: Int = 1, newStart: Int = 1) -> DiffHunk {
        var old = oldStart, new = newStart
        var lines: [DiffLine] = []
        for (index, kind) in kinds.enumerated() {
            switch kind {
            case .context:
                lines.append(DiffLine(kind: .context, text: "c\(index)",
                                      oldLineNo: old, newLineNo: new))
                old += 1; new += 1
            case .added:
                lines.append(DiffLine(kind: .added, text: "a\(index)",
                                      oldLineNo: nil, newLineNo: new))
                new += 1
            case .removed:
                lines.append(DiffLine(kind: .removed, text: "r\(index)",
                                      oldLineNo: old, newLineNo: nil))
                old += 1
            }
        }
        return DiffHunk(header: "@@ -\(oldStart),\(old - oldStart) +\(newStart),\(new - newStart) @@",
                        oldStart: oldStart, oldCount: old - oldStart,
                        newStart: newStart, newCount: new - newStart, lines: lines)
    }

    private func file(_ path: String, _ hunks: [DiffHunk], binary: Bool = false) -> DiffFile {
        DiffFile(path: path, oldPath: nil, status: .modified, isBinary: binary,
                 hunks: hunks, addedCount: 0, removedCount: 0)
    }

    private func deletions(_ plan: RowPlan) -> [PlannedBlock] {
        plan.blocks.filter { if case .deletedLines = $0.band { return true } else { return false } }
    }

    // MARK: - Rows are new-side only

    /// The invariant the rest of W2 rests on: no row corresponds to a removed line.
    func testRemovalsProduceNoTextRows() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .removed, .removed, .added, .context])]),
        ])
        XCTAssertEqual(plan.origins.map(\.kind), [.context, .added, .context])
        XCTAssertEqual(plan.origins.compactMap(\.newLineNumber), [1, 2, 3])
    }

    func testRowsCarryTheirGutterNumbers() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .removed, .added], oldStart: 10, newStart: 20)]),
        ])
        XCTAssertEqual(plan.origins[0].oldLineNumber, 10)
        XCTAssertEqual(plan.origins[0].newLineNumber, 20)
        // An addition exists only on the new side.
        XCTAssertNil(plan.origins[1].oldLineNumber)
        XCTAssertEqual(plan.origins[1].newLineNumber, 21)
    }

    /// Binary files get a header band but no rows, so they must not consume a row index.
    func testBinaryFilesGetAHeaderAndNoRows() {
        let plan = RowPlanner.plan(files: [
            file("logo.png", [], binary: true),
            file("a.swift", [hunk([.added])]),
        ])
        XCTAssertEqual(plan.origins.count, 1)
        XCTAssertEqual(plan.origins[0].path, "a.swift")
        XCTAssertEqual(plan.blocks.map(\.band), [.fileHeader(path: "logo.png"),
                                                 .fileHeader(path: "a.swift")])
    }

    // MARK: - Deletion bands

    func testARunOfRemovalsBecomesOneBandAboveTheFollowingRow() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .removed, .removed, .added, .context])]),
        ])
        let bands = deletions(plan)
        XCTAssertEqual(bands.count, 1)
        XCTAssertEqual(bands[0].band, .deletedLines(path: "a.swift", hunkIndex: 0,
                                                    lineIndices: [1, 2], startingOldLine: 2))
        // Row 1 is the addition that followed the removals.
        XCTAssertEqual(bands[0].beforeRow, 1)
    }

    func testSeparateRunsBecomeSeparateBands() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.removed, .context, .removed, .context])]),
        ])
        XCTAssertEqual(deletions(plan).map(\.beforeRow), [0, 1])
        XCTAssertEqual(deletions(plan).map(\.id), ["del-a.swift-0-0", "del-a.swift-0-2"])
    }

    /// The row a band sits above owns it, so selecting that row stages the removals too.
    func testTheFollowingRowOwnsTheBandsRemovals() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .removed, .added])]),
        ])
        XCTAssertEqual(plan.origins[0].deletedRefs, [])
        XCTAssertEqual(plan.origins[1].deletedRefs,
                       [DeletedRef(hunkIndex: 0, lineIndex: 1, oldLineNumber: 2)])
    }

    /// A hunk ending in removals has no following row of its own, so the band draws after
    /// the hunk and is owned by its last row — the only row that can carry it to a patch.
    func testATrailingRunIsOwnedByTheHunksLastRow() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .added, .removed, .removed])]),
        ])
        let bands = deletions(plan)
        XCTAssertEqual(bands.count, 1)
        XCTAssertEqual(bands[0].beforeRow, 2)          // == origins.count: after everything
        XCTAssertEqual(plan.origins.count, 2)
        XCTAssertEqual(plan.origins[1].deletedRefs.map(\.lineIndex), [2, 3])
    }

    /// A whole-file deletion is all removals and no rows: the band still exists (the
    /// content must be visible) but no row can own it, so it is whole-file staging only.
    func testAnAllRemovalHunkYieldsABandWithNoOwningRow() {
        let plan = RowPlanner.plan(files: [
            file("gone.swift", [hunk([.removed, .removed])]),
            file("a.swift", [hunk([.added])]),
        ])
        let bands = deletions(plan)
        XCTAssertEqual(bands.count, 1)
        XCTAssertEqual(bands[0].beforeRow, 0)   // above a.swift's first (and only) row
        XCTAssertEqual(plan.origins.count, 1)
        XCTAssertEqual(plan.origins[0].path, "a.swift")
        XCTAssertEqual(plan.origins[0].deletedRefs, [])
    }

    /// Blocks at the same row are drawn in array order, so the order they are emitted in
    /// is load-bearing: the deleted file's content must not appear under the next file's
    /// header band.
    func testBlocksAtTheSameRowKeepHeaderThenContentOrder() {
        let plan = RowPlanner.plan(files: [
            file("gone.swift", [hunk([.removed])]),
            file("a.swift", [hunk([.added])]),
        ])
        XCTAssertEqual(plan.blocks.map(\.beforeRow), [0, 0, 0])
        XCTAssertEqual(plan.blocks.map(\.id), ["hdr-gone.swift", "del-gone.swift-0-0",
                                               "hdr-a.swift"])
    }

    func testBandStartingOldLineIsTheFirstRemovedLinesNumber() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .context, .removed, .removed],
                                  oldStart: 40, newStart: 40)]),
        ])
        guard case .deletedLines(_, _, let indices, let start) = deletions(plan)[0].band else {
            return XCTFail("expected a deletion band")
        }
        XCTAssertEqual(indices, [2, 3])
        XCTAssertEqual(start, 42)
    }

    // MARK: - Excerpts

    func testOneExcerptPerHunkOverTheRowsItProduced() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .added]), hunk([.added], oldStart: 50, newStart: 50)]),
        ])
        XCTAssertEqual(plan.excerpts.map(\.rows), [0..<2, 2..<3])
        XCTAssertEqual(plan.excerpts.map(\.hunkIndex), [0, 1])
    }

    /// An excerpt's `lineRange` is fed straight to `StitchMap`, which resolves a row by
    /// **summing excerpt lengths** — so it is only correct if excerpts are real source
    /// ranges of the same length as their rows. Feeding it row spans instead is what made
    /// every lookup on it drift, and it drifted silently.
    func testExcerptSourceRangesAreRealNewSideLinesOfTheSameLength() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context, .removed, .added], oldStart: 10, newStart: 20)]),
        ])
        XCTAssertEqual(plan.excerpts.count, 1)
        XCTAssertEqual(plan.excerpts[0].sourceLines, 19..<21)   // new lines 20 and 21, 0-based
        XCTAssertEqual(plan.excerpts[0].rows.count, plan.excerpts[0].sourceLines.count)
    }

    /// The invariant `StitchMap` rests on: excerpts are ordered, contiguous, and cover every
    /// row exactly once — including the rows revealed out of a gap, which belong to no hunk
    /// and so used to belong to no excerpt.
    func testExcerptsTileEveryRowIncludingRevealedGaps() {
        let plan = RowPlanner.plan(
            files: [
                file("a.swift", [hunk([.context, .removed, .added], oldStart: 1, newStart: 1),
                                 hunk([.added, .removed], oldStart: 30, newStart: 30)]),
                file("b.swift", [hunk([.context, .added])]),
            ],
            revealed: ["a.swift": [5, 6, 20]])

        var next = 0
        for excerpt in plan.excerpts {
            XCTAssertEqual(excerpt.rows.lowerBound, next, "excerpts must be contiguous")
            XCTAssertEqual(excerpt.rows.count, excerpt.sourceLines.count)
            next = excerpt.rows.upperBound
        }
        XCTAssertEqual(next, plan.origins.count, "excerpts must cover every row")
        // Each row's own number must agree with the excerpt claiming it.
        for excerpt in plan.excerpts {
            for (offset, row) in excerpt.rows.enumerated() {
                XCTAssertEqual(plan.origins[row].newLineNumber,
                               excerpt.sourceLines.lowerBound + offset + 1)
                XCTAssertEqual(plan.origins[row].path, excerpt.path)
            }
        }
    }

    func testARevealedStretchBecomesItsOwnContextExcerpt() {
        let plan = RowPlanner.plan(
            files: [file("a.swift", [hunk([.context], oldStart: 1, newStart: 1),
                                     hunk([.added], oldStart: 20, newStart: 20)])],
            revealed: ["a.swift": [5, 6]])
        XCTAssertEqual(plan.excerpts.map(\.kind), [.hunk, .context, .hunk])
        XCTAssertEqual(plan.excerpts[1].sourceLines, 5..<7)
        XCTAssertEqual(plan.excerpts[1].id, "a.swift#context-5")
    }

    /// A hunk that produced no rows must not produce an excerpt — an empty range would
    /// make every stitched-line lookup after it resolve to the wrong hunk.
    func testAHunkWithNoRowsProducesNoExcerpt() {
        let plan = RowPlanner.plan(files: [file("gone.swift", [hunk([.removed, .removed])])])
        XCTAssertEqual(plan.excerpts, [])
    }

    // MARK: - Hunk gaps

    func testACollapsedGapBecomesABandBetweenHunks() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.context], oldStart: 1, newStart: 1),
                             hunk([.added], oldStart: 20, newStart: 20)]),
        ])
        XCTAssertEqual(plan.blocks.map(\.band), [
            .fileHeader(path: "a.swift"),
            .hunkGap(path: "a.swift", collapsed: 1..<19),
        ])
        XCTAssertEqual(plan.blocks[1].beforeRow, 1)
    }

    func testRevealedGapLinesBecomeContextRowsNumberedOnBothSides() {
        // Two lines added above, so the old side trails the new by two.
        let plan = RowPlanner.plan(
            files: [file("a.swift", [hunk([.context], oldStart: 1, newStart: 1),
                                     hunk([.added], oldStart: 8, newStart: 10)])],
            revealed: ["a.swift": [5, 6]])
        let revealed = plan.origins.filter { $0.lineIndex == -1 }
        XCTAssertEqual(revealed.map(\.newLineNumber), [6, 7])
        XCTAssertEqual(revealed.map(\.oldLineNumber), [4, 5])
        XCTAssertEqual(revealed.map(\.kind), [.context, .context])
    }

    /// Hunks whose line numbers overlap or run backwards produce no gap rather than
    /// trapping on an inverted `Range`. Real `git diff` output is ascending, but nothing in
    /// the model enforces that, and the trap took the whole app down.
    func testOverlappingHunkNumbersProduceNoGapInsteadOfTrapping() {
        let plan = RowPlanner.plan(files: [
            file("a.swift", [hunk([.added, .added], oldStart: 1, newStart: 1),
                             hunk([.added], oldStart: 1, newStart: 1)]),
        ])
        XCTAssertEqual(plan.origins.count, 3)
        XCTAssertEqual(plan.blocks.map(\.band), [.fileHeader(path: "a.swift")])
    }

    /// The revealed rows get an excerpt of their own between the two hunks', so the second
    /// hunk's excerpt starts after them.
    func testRevealedRowsShiftTheFollowingExcerpt() {
        let plan = RowPlanner.plan(
            files: [file("a.swift", [hunk([.context], oldStart: 1, newStart: 1),
                                     hunk([.added], oldStart: 20, newStart: 20)])],
            revealed: ["a.swift": [5]])
        XCTAssertEqual(plan.excerpts.map(\.rows), [0..<1, 1..<2, 2..<3])
        XCTAssertEqual(plan.excerpts.map(\.hunkIndex), [0, nil, 1])
    }

    // MARK: - Opened files (⌘P)

    /// A file opened whole becomes every-line-a-row after the diff, with a context excerpt
    /// covering it — the first excerpt that describes no change at all.
    func testAnOpenedFileBecomesRowsAndAContextExcerpt() {
        let plan = RowPlanner.plan(files: [file("a.swift", [hunk([.added])])],
                                   opened: [OpenedFile(path: "notes.md", lineCount: 3)])

        XCTAssertEqual(plan.origins.count, 4)
        XCTAssertEqual(plan.origins[1...].map(\.path), ["notes.md", "notes.md", "notes.md"])
        XCTAssertEqual(plan.origins[1...].map(\.newLineNumber), [1, 2, 3])
        // In no hunk, so nothing about it can reach a patch.
        XCTAssertTrue(plan.origins[1...].allSatisfy { !$0.isStageable })
        XCTAssertEqual(plan.excerpts.last?.kind, .context)
        XCTAssertEqual(plan.excerpts.last?.sourceLines, 0..<3)
        XCTAssertEqual(plan.excerpts.last?.rows, 1..<4)
        XCTAssertEqual(plan.blocks.map(\.id), ["hdr-a.swift", "hdr-notes.md"])
    }

    /// Even opened whole, the tiling invariant has to hold — `StitchMap` still resolves rows
    /// by summing excerpt lengths.
    func testOpenedFilesKeepExcerptsTiling() {
        let plan = RowPlanner.plan(
            files: [file("a.swift", [hunk([.context, .removed, .added])])],
            opened: [OpenedFile(path: "one.md", lineCount: 2),
                     OpenedFile(path: "two.md", lineCount: 5)])
        var next = 0
        for excerpt in plan.excerpts {
            XCTAssertEqual(excerpt.rows.lowerBound, next)
            XCTAssertEqual(excerpt.rows.count, excerpt.sourceLines.count)
            next = excerpt.rows.upperBound
        }
        XCTAssertEqual(next, plan.origins.count)
    }

    func testAnEmptyOpenedFileContributesAHeaderAndNoRows() {
        let plan = RowPlanner.plan(files: [], opened: [OpenedFile(path: "empty", lineCount: 0)])
        XCTAssertEqual(plan.origins, [])
        XCTAssertEqual(plan.blocks.map(\.id), ["hdr-empty"])
        XCTAssertEqual(plan.excerpts, [])
    }

    // MARK: - Selection, over a real plan

    /// The knock-on that makes W2.0 safe: with removals off the rows, staging a hunk must
    /// still produce a patch containing them.
    func testStagingAHunkCoversItsRemovalsAsWellAsItsAdditions() {
        let files = [file("a.swift", [hunk([.context, .removed, .added, .context])])]
        let plan = RowPlanner.plan(files: files)
        let rows = StageSelection.hunkRows(atStitchedLine: 0, origins: plan.origins)
        let groups = StageSelection.selections(forStitchedLines: Set(rows),
                                               origins: plan.origins, files: files)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].selections, [HunkSelection(hunkIndex: 0, lineIndices: [1, 2])])
    }

    /// Selecting only a context row that owns a band stages the deletions and nothing
    /// else — the context line itself is not a change.
    func testSelectingABandsOwningContextRowStagesOnlyTheRemovals() {
        let files = [file("a.swift", [hunk([.removed, .context])])]
        let plan = RowPlanner.plan(files: files)
        let groups = StageSelection.selections(forStitchedLines: [0],
                                               origins: plan.origins, files: files)
        XCTAssertEqual(groups.first?.selections,
                       [HunkSelection(hunkIndex: 0, lineIndices: [0])])
    }

    /// A trailing band belongs to the previous hunk, not to the row it draws above.
    func testATrailingBandsRemovalsGoToTheirOwnHunk() {
        let files = [file("a.swift", [hunk([.added, .removed]),
                                      hunk([.added], oldStart: 40, newStart: 40)])]
        let plan = RowPlanner.plan(files: files)
        let groups = StageSelection.selections(forStitchedLines: [0],
                                               origins: plan.origins, files: files)
        XCTAssertEqual(groups.first?.selections,
                       [HunkSelection(hunkIndex: 0, lineIndices: [0, 1])])
    }

    /// End to end: rows in, a patch git could apply out.
    func testAHunkSelectionSynthesizesAPatchWithTheRemovalIncluded() {
        let files = [file("a.swift", [hunk([.context, .removed, .added])])]
        let plan = RowPlanner.plan(files: files)
        let rows = StageSelection.hunkRows(atStitchedLine: 1, origins: plan.origins)
        let groups = StageSelection.selections(forStitchedLines: Set(rows),
                                               origins: plan.origins, files: files)
        let patch = PatchSynth.patch(path: "a.swift", oldPath: nil,
                                     hunks: groups[0].hunks, selections: groups[0].selections)
        XCTAssertEqual(patch, """
        diff --git a/a.swift b/a.swift
        --- a/a.swift
        +++ b/a.swift
        @@ -1,2 +1,2 @@
         c0
        -r1
        +a2

        """)
    }
}
