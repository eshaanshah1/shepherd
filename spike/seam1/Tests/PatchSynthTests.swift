import XCTest
@testable import Shepherd

final class PatchSynthTests: XCTestCase {

    /// `@@ -1,3 +1,4 @@` with one context, one removal, two additions.
    private func sampleHunk() -> DiffHunk {
        DiffHunk(
            header: "@@ -10,3 +10,4 @@",
            oldStart: 10, oldCount: 3, newStart: 10, newCount: 4,
            lines: [
                DiffLine(kind: .context, text: "let a = 1", oldLineNo: 10, newLineNo: 10),
                DiffLine(kind: .removed, text: "let b = 2", oldLineNo: 11, newLineNo: nil),
                DiffLine(kind: .added,   text: "let b = 9", oldLineNo: nil, newLineNo: 11),
                DiffLine(kind: .added,   text: "let c = 3", oldLineNo: nil, newLineNo: 12),
                DiffLine(kind: .context, text: "return a",  oldLineNo: 12, newLineNo: 13),
            ]
        )
    }

    private func lines(_ patch: String) -> [String] {
        patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    func testWholeHunkPatchHasGitHeadersAndTheOriginalBody() {
        let patch = PatchSynth.patch(path: "Sources/A.swift", oldPath: nil,
                                     hunks: [sampleHunk()],
                                     selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)])
        let out = lines(patch ?? "")
        XCTAssertEqual(out[0], "diff --git a/Sources/A.swift b/Sources/A.swift")
        XCTAssertEqual(out[1], "--- a/Sources/A.swift")
        XCTAssertEqual(out[2], "+++ b/Sources/A.swift")
        XCTAssertEqual(out[3], "@@ -10,3 +10,4 @@")
        XCTAssertEqual(out[4], " let a = 1")
        XCTAssertEqual(out[5], "-let b = 2")
        XCTAssertEqual(out[6], "+let b = 9")
        XCTAssertEqual(out[7], "+let c = 3")
        XCTAssertEqual(out[8], " return a")
    }

    func testPatchEndsWithANewline() {
        let patch = PatchSynth.patch(path: "a.swift", oldPath: nil, hunks: [sampleHunk()],
                                     selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)])
        XCTAssertTrue(patch?.hasSuffix("\n") == true, "git apply rejects a patch with no trailing newline")
    }

    func testUnselectedAdditionIsDroppedEntirely() {
        // Stage only the removal and the first addition — drop "let c = 3" (index 3).
        let sel = HunkSelection(hunkIndex: 0, lineIndices: [0, 1, 2, 4])
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                         hunks: [sampleHunk()], selections: [sel]) ?? "")
        XCTAssertFalse(out.contains("+let c = 3"), "an unstaged addition must not appear")
        XCTAssertTrue(out.contains("+let b = 9"))
    }

    func testUnselectedRemovalBecomesContext() {
        // Stage only the additions; the removal stays in the index, so it must appear
        // as context — dropping it would silently delete the line from the index.
        let sel = HunkSelection(hunkIndex: 0, lineIndices: [0, 2, 3, 4])
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                         hunks: [sampleHunk()], selections: [sel]) ?? "")
        XCTAssertFalse(out.contains("-let b = 2"))
        XCTAssertTrue(out.contains(" let b = 2"), "unstaged removal must survive as context")
    }

    func testCountsAreRecomputedForAPartialSelection() {
        // Only the removal staged: old side keeps 3 lines (2 context + 1 removed),
        // new side keeps 2 (the removal is gone, both additions dropped).
        let sel = HunkSelection(hunkIndex: 0, lineIndices: [0, 1, 4])
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                         hunks: [sampleHunk()], selections: [sel]) ?? "")
        XCTAssertEqual(out[3], "@@ -10,3 +10,2 @@")
    }

    func testCountsForTheWholeHunkMatchTheOriginal() {
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil, hunks: [sampleHunk()],
                                         selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)]) ?? "")
        XCTAssertEqual(out[3], "@@ -10,3 +10,4 @@")
    }

    func testSelectingNoRealChangeProducesNoPatch() {
        // Context-only selection changes nothing; emitting it would be a no-op patch
        // that git rejects.
        let sel = HunkSelection(hunkIndex: 0, lineIndices: [0, 4])
        XCTAssertNil(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                      hunks: [sampleHunk()], selections: [sel]))
    }

    func testNoSelectionsProducesNoPatch() {
        XCTAssertNil(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                      hunks: [sampleHunk()], selections: []))
    }

    func testSecondHunkNewStartAccountsForTheFirstHunksDelta() {
        // The sample hunk removes 1 and adds 2, so its net delta is +1 and the second
        // hunk's new-side start shifts from 40 to 41. Counts come from the emitted
        // lines, not from the fixture's declared header — one removal, one addition.
        let h2 = DiffHunk(header: "@@ -40,1 +41,1 @@", oldStart: 40, oldCount: 1,
                          newStart: 41, newCount: 1,
                          lines: [
                            DiffLine(kind: .removed, text: "old", oldLineNo: 40, newLineNo: nil),
                            DiffLine(kind: .added, text: "new", oldLineNo: nil, newLineNo: 41),
                          ])
        let out = lines(PatchSynth.patch(
            path: "a.swift", oldPath: nil, hunks: [sampleHunk(), h2],
            selections: [HunkSelection(hunkIndex: 0, lineIndices: nil),
                         HunkSelection(hunkIndex: 1, lineIndices: nil)]) ?? "")
        XCTAssertEqual(out[3], "@@ -10,3 +10,4 @@")
        XCTAssertTrue(out.contains("@@ -40,1 +41,1 @@"),
                      "expected the second hunk to shift by the first hunk's +1 delta; got \(out)")
    }

    func testHunkDeltaOnlyCountsSelectedLines() {
        // Staging just the removal makes hunk 1 net -1, so hunk 2 shifts to 39.
        let h2 = DiffHunk(header: "@@ -40,1 +39,1 @@", oldStart: 40, oldCount: 1,
                          newStart: 39, newCount: 1,
                          lines: [
                            DiffLine(kind: .removed, text: "old", oldLineNo: 40, newLineNo: nil),
                            DiffLine(kind: .added, text: "new", oldLineNo: nil, newLineNo: 39),
                          ])
        let out = lines(PatchSynth.patch(
            path: "a.swift", oldPath: nil, hunks: [sampleHunk(), h2],
            selections: [HunkSelection(hunkIndex: 0, lineIndices: [0, 1, 4]),
                         HunkSelection(hunkIndex: 1, lineIndices: nil)]) ?? "")
        XCTAssertTrue(out.contains("@@ -40,1 +39,1 @@"),
                      "partial selection must drive the downstream shift; got \(out)")
    }

    func testOnlySelectedHunksAppear() {
        let h2 = DiffHunk(header: "@@ -40,1 +40,1 @@", oldStart: 40, oldCount: 1,
                          newStart: 40, newCount: 1,
                          lines: [
                            DiffLine(kind: .removed, text: "gone", oldLineNo: 40, newLineNo: nil),
                            DiffLine(kind: .added, text: "kept", oldLineNo: nil, newLineNo: 40),
                          ])
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil,
                                         hunks: [sampleHunk(), h2],
                                         selections: [HunkSelection(hunkIndex: 1, lineIndices: nil)]) ?? "")
        XCTAssertFalse(out.contains("-let b = 2"), "unselected hunk must not appear")
        XCTAssertTrue(out.contains("-gone"))
    }

    func testRenameUsesTheOldPathOnTheOldSide() {
        let out = lines(PatchSynth.patch(path: "New.swift", oldPath: "Old.swift",
                                         hunks: [sampleHunk()],
                                         selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)]) ?? "")
        XCTAssertEqual(out[0], "diff --git a/Old.swift b/New.swift")
        XCTAssertEqual(out[1], "--- a/Old.swift")
        XCTAssertEqual(out[2], "+++ b/New.swift")
    }

    func testPathsWithSpacesAreEmittedVerbatim() {
        let out = lines(PatchSynth.patch(path: "My Dir/A B.swift", oldPath: nil,
                                         hunks: [sampleHunk()],
                                         selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)]) ?? "")
        XCTAssertEqual(out[1], "--- a/My Dir/A B.swift")
    }

    func testOutOfRangeHunkIndexIsIgnored() {
        XCTAssertNil(PatchSynth.patch(path: "a.swift", oldPath: nil, hunks: [sampleHunk()],
                                      selections: [HunkSelection(hunkIndex: 7, lineIndices: nil)]))
    }

    func testSingleLineCountsOmitTheCommaFormOnlyWhenGitDoes() {
        // git writes "@@ -5 +5 @@" for single-line ranges; emitting "-5,1" is also
        // valid and unambiguous, so we assert the count is present and correct.
        let h = DiffHunk(header: "@@ -5 +5 @@", oldStart: 5, oldCount: 1, newStart: 5, newCount: 1,
                         lines: [
                            DiffLine(kind: .removed, text: "x", oldLineNo: 5, newLineNo: nil),
                            DiffLine(kind: .added, text: "y", oldLineNo: nil, newLineNo: 5),
                         ])
        let out = lines(PatchSynth.patch(path: "a.swift", oldPath: nil, hunks: [h],
                                         selections: [HunkSelection(hunkIndex: 0, lineIndices: nil)]) ?? "")
        XCTAssertEqual(out[3], "@@ -5,1 +5,1 @@")
    }
}
