import XCTest
@testable import Shepherd

/// Write-back's coordinate mapping: stitched rows → file lines, and keeping the row tables
/// in step afterwards. The one mapping in the workbench that can write wrong bytes to disk.
final class EditMapTests: XCTestCase {

    /// A row of `path` showing new-side line `line`.
    private func row(_ path: String, _ line: Int?, hunk: Int = 0) -> RowOrigin {
        RowOrigin(path: path, hunkIndex: hunk, lineIndex: 0, kind: .context,
                  oldLineNumber: nil, newLineNumber: line)
    }

    // MARK: - fileEdit

    func testASingleRowMapsToItsOwnLine() {
        let origins = [row("a.swift", 10), row("a.swift", 11), row("a.swift", 12)]
        XCTAssertEqual(EditMap.fileEdit(rows: 1..<2, origins: origins),
                       FileEdit(path: "a.swift", lines: 10..<11))
    }

    func testAContiguousRunMapsToTheWholeLineRange() {
        let origins = [row("a.swift", 10), row("a.swift", 11), row("a.swift", 12)]
        XCTAssertEqual(EditMap.fileEdit(rows: 0..<3, origins: origins),
                       FileEdit(path: "a.swift", lines: 9..<12))
    }

    /// The guard the whole design rests on. Rows 1 and 2 are adjacent on screen but 150
    /// lines apart in the file, so joining them would rewrite everything in the gap.
    func testAnEditSpanningAHunkGapIsRefused() {
        let origins = [row("a.swift", 10), row("a.swift", 11), row("a.swift", 160)]
        XCTAssertNil(EditMap.fileEdit(rows: 1..<3, origins: origins))
        // Either side of the gap on its own is still fine.
        XCTAssertEqual(EditMap.fileEdit(rows: 0..<2, origins: origins),
                       FileEdit(path: "a.swift", lines: 9..<11))
        XCTAssertEqual(EditMap.fileEdit(rows: 2..<3, origins: origins),
                       FileEdit(path: "a.swift", lines: 159..<160))
    }

    func testAnEditSpanningTwoFilesIsRefused() {
        let origins = [row("a.swift", 10), row("b.swift", 1)]
        XCTAssertNil(EditMap.fileEdit(rows: 0..<2, origins: origins))
    }

    /// A row with no new-side number is not a line on disk, so it cannot host an edit.
    func testARowWithoutANewSideNumberIsRefused() {
        XCTAssertNil(EditMap.fileEdit(rows: 0..<1, origins: [row("a.swift", nil)]))
    }

    func testAnEmptyOrOutOfRangeEditIsRefused() {
        let origins = [row("a.swift", 1)]
        XCTAssertNil(EditMap.fileEdit(rows: 0..<0, origins: origins))
        XCTAssertNil(EditMap.fileEdit(rows: 0..<5, origins: origins))
        XCTAssertNil(EditMap.fileEdit(rows: -1..<1, origins: origins))
    }

    // MARK: - rowDelta

    func testTypingWithinALineChangesNoRows() {
        XCTAssertEqual(EditMap.rowDelta(replacing: 3..<4, with: "hello"), 0)
    }

    func testTypingANewlineAddsARow() {
        XCTAssertEqual(EditMap.rowDelta(replacing: 3..<4, with: "a\nb"), 1)
    }

    func testDeletingAcrossRowsRemovesThem() {
        // Three rows collapse into one.
        XCTAssertEqual(EditMap.rowDelta(replacing: 3..<6, with: "joined"), -2)
    }

    func testPastingABlockAddsEveryLine() {
        XCTAssertEqual(EditMap.rowDelta(replacing: 3..<4, with: "1\n2\n3\n4"), 3)
    }

    // MARK: - rowsAfterEdit

    func testNewRowsCarryTheFileButNoDiffLine() {
        let origins = [row("a.swift", 5), row("a.swift", 6)]
        let after = EditMap.rowsAfterEdit(origins, replacing: 0..<1, withRowCount: 2)

        XCTAssertEqual(after.count, 3)
        XCTAssertEqual(after[0].path, "a.swift")
        XCTAssertEqual(after[0].newLineNumber, 5)
        XCTAssertEqual(after[1].newLineNumber, 6)
        // -1 means "in no hunk" — a typed line must not be addressable as a diff line.
        XCTAssertEqual(after[0].lineIndex, -1)
        XCTAssertEqual(after[1].lineIndex, -1)
        XCTAssertFalse(after[0].isStageable)
    }

    func testRowsBelowTheEditAreRenumberedInTheSameFileOnly() {
        let origins = [row("a.swift", 5), row("a.swift", 6), row("b.swift", 1)]
        let after = EditMap.rowsAfterEdit(origins, replacing: 0..<1, withRowCount: 3)

        XCTAssertEqual(after.count, 5)
        // a.swift's remaining row was line 6, and two lines were inserted above it.
        XCTAssertEqual(after[3].path, "a.swift")
        XCTAssertEqual(after[3].newLineNumber, 8)
        // b.swift moved index but not line number.
        XCTAssertEqual(after[4].path, "b.swift")
        XCTAssertEqual(after[4].newLineNumber, 1)
    }

    func testDeletingRowsRenumbersDownward() {
        let origins = [row("a.swift", 5), row("a.swift", 6), row("a.swift", 7)]
        let after = EditMap.rowsAfterEdit(origins, replacing: 0..<2, withRowCount: 1)
        XCTAssertEqual(after.map(\.newLineNumber), [5, 6])
    }

    func testDeletedRefsSurviveOnRowsBelowTheEdit() {
        var owner = row("a.swift", 9)
        owner.deletedRefs = [DeletedRef(hunkIndex: 0, lineIndex: 4, oldLineNumber: 12)]
        let after = EditMap.rowsAfterEdit([row("a.swift", 8), owner],
                                          replacing: 0..<1, withRowCount: 1)
        XCTAssertEqual(after[1].deletedRefs,
                       [DeletedRef(hunkIndex: 0, lineIndex: 4, oldLineNumber: 12)])
    }

    // MARK: - lineStartsAfterEdit

    /// The incremental result must equal a full rescan, or the row→offset lookups drift.
    private func assertMatchesRescan(_ text: String, editStart: Int, removedLength: Int,
                                     replacement: String, rows: Range<Int>) {
        let before = EditMap.lineStartOffsets(text)
        let ns = NSMutableString(string: text)
        ns.replaceCharacters(in: NSRange(location: editStart, length: removedLength),
                             with: replacement)
        let expected = EditMap.lineStartOffsets(ns as String)
        let actual = EditMap.lineStartsAfterEdit(before, replacing: rows, editStart: editStart,
                                                 removedLength: removedLength,
                                                 replacement: replacement)
        XCTAssertEqual(actual, expected, "incremental line starts drifted from a rescan")
    }

    func testTypingInPlaceShiftsLaterLineStarts() {
        // "one\ntwo\nthree\n" — insert "XY" at offset 5 (inside "two").
        assertMatchesRescan("one\ntwo\nthree\n", editStart: 5, removedLength: 0,
                            replacement: "XY", rows: 1..<2)
    }

    func testInsertingANewlineSplicesInALineStart() {
        assertMatchesRescan("one\ntwo\nthree\n", editStart: 5, removedLength: 0,
                            replacement: "\n", rows: 1..<2)
    }

    func testPastingSeveralLinesSplicesEachOne() {
        assertMatchesRescan("one\ntwo\nthree\n", editStart: 4, removedLength: 0,
                            replacement: "a\nb\nc\n", rows: 1..<2)
    }

    func testDeletingAcrossLinesRemovesTheirStarts() {
        // Replace "two\nthree" (offsets 4..<13) with "x", collapsing rows 1 and 2.
        assertMatchesRescan("one\ntwo\nthree\n", editStart: 4, removedLength: 9,
                            replacement: "x", rows: 1..<3)
    }

    func testReplacingALineWithTheSameLineCountIsStable() {
        assertMatchesRescan("one\ntwo\nthree\n", editStart: 4, removedLength: 3,
                            replacement: "TWO", rows: 1..<2)
    }
}
