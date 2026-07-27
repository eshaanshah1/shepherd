import XCTest
@testable import Shepherd

final class StitchMapTests: XCTestCase {
    private let fileA = SourceID("A.swift")
    private let fileB = SourceID("B.swift")

    /// A.swift lines 10..<13 then B.swift lines 0..<2 → 5 stitched lines.
    private func twoFileMap() -> StitchMap {
        StitchMap(excerpts: [
            Excerpt(id: "a1", source: fileA, lineRange: 10..<13, kind: .hunk),
            Excerpt(id: "b1", source: fileB, lineRange: 0..<2, kind: .hunk),
        ])
    }

    func testTotalLinesIsTheSumOfExcerptLengths() {
        XCTAssertEqual(twoFileMap().totalLines, 5)
    }

    func testStitchedLineMapsToSourceLocation() {
        let map = twoFileMap()
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 0)?.line, 10)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 2)?.line, 12)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 0)?.source, fileA)
        // Line 3 crosses into the second excerpt.
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 3)?.source, fileB)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 3)?.line, 0)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 4)?.line, 1)
    }

    func testOutOfRangeStitchedLineReturnsNil() {
        XCTAssertNil(twoFileMap().sourceLocation(atStitchedLine: 5))
        XCTAssertNil(twoFileMap().sourceLocation(atStitchedLine: -1))
    }

    func testMappingRoundTripsBothWays() {
        let map = twoFileMap()
        for stitched in 0..<map.totalLines {
            let loc = map.sourceLocation(atStitchedLine: stitched)
            XCTAssertNotNil(loc, "line \(stitched) did not map")
            guard let loc else { continue }
            XCTAssertEqual(map.stitchedLine(for: loc.source, line: loc.line), stitched)
        }
    }

    func testStitchedLineForSourceLineOutsideAnyExcerptIsNil() {
        // A.swift line 5 is not shown — only 10..<13 is.
        XCTAssertNil(twoFileMap().stitchedLine(for: fileA, line: 5))
    }

    func testExcerptLookupIdentifiesTheOwningExcerpt() {
        let map = twoFileMap()
        XCTAssertEqual(map.excerpt(atStitchedLine: 1)?.id, "a1")
        XCTAssertEqual(map.excerpt(atStitchedLine: 4)?.id, "b1")
        XCTAssertNil(map.excerpt(atStitchedLine: 5))
    }

    func testInsertingLinesGrowsTheEditedExcerpt() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: 2)
        XCTAssertEqual(map.totalLines, 7)
        XCTAssertEqual(map.excerpts[0].lineRange, 10..<15)
    }

    func testInsertingLinesShiftsLaterExcerptsInTheSameFile() {
        var map = StitchMap(excerpts: [
            Excerpt(id: "a1", source: fileA, lineRange: 0..<2, kind: .hunk),
            Excerpt(id: "a2", source: fileA, lineRange: 50..<52, kind: .hunk),
        ])
        map.applyEdit(in: fileA, atLine: 1, lineDelta: 3)
        XCTAssertEqual(map.excerpts[0].lineRange, 0..<5, "edited excerpt grows")
        XCTAssertEqual(map.excerpts[1].lineRange, 53..<55, "later excerpt slides down")
    }

    func testEditInOneFileLeavesOtherFilesAlone() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: 4)
        XCTAssertEqual(map.excerpts[1].lineRange, 0..<2, "B.swift must not move")
    }

    func testDeletingLinesShrinksTheExcerpt() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: -1)
        XCTAssertEqual(map.excerpts[0].lineRange, 10..<12)
        XCTAssertEqual(map.totalLines, 4)
    }

    func testDeletingMoreLinesThanTheExcerptHoldsCollapsesItRatherThanInverting() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: -99)
        XCTAssertEqual(map.excerpts[0].lineRange, 10..<10, "range must not invert")
        XCTAssertEqual(map.totalLines, 2)
    }

    func testAZeroDeltaEditChangesNothing() {
        var map = twoFileMap()
        let before = map
        map.applyEdit(in: fileA, atLine: 11, lineDelta: 0)
        XCTAssertEqual(map, before)
    }

    func testAnEmptyMapMapsNothing() {
        let map = StitchMap(excerpts: [])
        XCTAssertEqual(map.totalLines, 0)
        XCTAssertNil(map.sourceLocation(atStitchedLine: 0))
        XCTAssertNil(map.excerpt(atStitchedLine: 0))
    }
}
