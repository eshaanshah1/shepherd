import XCTest
@testable import Shepherd

/// Reading git's unmerged index. A misread stage set picks the wrong resolution strategy —
/// and for a delete/modify conflict that means offering to write content for a file one
/// side deleted.
final class ConflictParseTests: XCTestCase {

    private func record(_ mode: String, _ sha: String, _ stage: Int, _ path: String) -> String {
        "\(mode) \(sha) \(stage)\t\(path)\0"
    }

    // MARK: - entries

    func testAThreeStageConflictParsesToThreeEntries() {
        let output = record("100644", "aaa", 1, "App.swift")
            + record("100644", "bbb", 2, "App.swift")
            + record("100644", "ccc", 3, "App.swift")
        let entries = ConflictParse.entries(output)
        XCTAssertEqual(entries.count, 3)
        XCTAssertEqual(entries.map(\.stage), [1, 2, 3])
        XCTAssertEqual(entries.map(\.sha), ["aaa", "bbb", "ccc"])
        XCTAssertEqual(Set(entries.map(\.path)), ["App.swift"])
    }

    func testEmptyOutputParsesToNothing() {
        XCTAssertTrue(ConflictParse.entries("").isEmpty)
    }

    /// The reason for `-z`: git escapes these in its default output format.
    func testAPathContainingSpacesAndQuotesSurvivesIntact() {
        let path = "Sources/My \"Odd\" Dir/a b.swift"
        let entries = ConflictParse.entries(record("100644", "aaa", 2, path))
        XCTAssertEqual(entries.first?.path, path)
    }

    func testANonAsciiPathSurvivesIntact() {
        let entries = ConflictParse.entries(record("100644", "aaa", 2, "Sources/café/naïve.swift"))
        XCTAssertEqual(entries.first?.path, "Sources/café/naïve.swift")
    }

    func testMalformedRecordsAreSkippedRatherThanCrashing() {
        let output = "garbage\0"
            + "100644 aaa\tNoStage.swift\0"          // missing the stage field
            + "100644 aaa 9\tBadStage.swift\0"       // stage outside 1...3
            + "100644 aaa 2\t\0"                     // empty path
            + record("100644", "bbb", 2, "Good.swift")
        XCTAssertEqual(ConflictParse.entries(output).map(\.path), ["Good.swift"])
    }

    // MARK: - byPath

    func testEntriesGroupByPathInGitsOrder() {
        let output = record("100644", "a1", 1, "Zebra.swift")
            + record("100644", "a2", 2, "Zebra.swift")
            + record("100644", "b2", 2, "Alpha.swift")
            + record("100644", "b3", 3, "Alpha.swift")
        let grouped = ConflictParse.byPath(ConflictParse.entries(output))
        XCTAssertEqual(grouped.map(\.path), ["Zebra.swift", "Alpha.swift"])
        XCTAssertEqual(Set(grouped[0].stages.keys), [1, 2])
        XCTAssertEqual(grouped[1].stages[3]?.sha, "b3")
    }

    // MARK: - kind

    func testAllThreeStagesIsAContentConflict() {
        XCTAssertEqual(ConflictParse.kind(stages: [1, 2, 3]), .content)
    }

    func testNoAncestorIsAnAddAddConflict() {
        XCTAssertEqual(ConflictParse.kind(stages: [2, 3]), .addAdd)
    }

    func testAMissingTheirsStageMeansTheyDeletedIt() {
        XCTAssertEqual(ConflictParse.kind(stages: [1, 2]), .deletedByThem)
    }

    func testAMissingOursStageMeansWeDeletedIt() {
        XCTAssertEqual(ConflictParse.kind(stages: [1, 3]), .deletedByUs)
    }

    func testAnUnrecognisedStageSetIsUnknownRatherThanAssumed() {
        XCTAssertEqual(ConflictParse.kind(stages: [1]), .unknown)
        XCTAssertEqual(ConflictParse.kind(stages: [2]), .unknown)
        XCTAssertEqual(ConflictParse.kind(stages: []), .unknown)
    }

    // MARK: - markerCount

    func testMarkerCountCountsGitsConflictRegions() {
        let file = """
        a
        <<<<<<< HEAD
        mine
        =======
        yours
        >>>>>>> feature
        b
        <<<<<<< HEAD
        mine again
        =======
        yours again
        >>>>>>> feature
        c
        """
        XCTAssertEqual(ConflictParse.markerCount(file), 2)
    }

    func testACleanFileHasNoMarkers() {
        XCTAssertEqual(ConflictParse.markerCount("a\nb\nc\n"), 0)
    }

    /// The tripwire must not fire on a file that merely *discusses* conflict markers — this
    /// is a count of git's own region openers, which sit at the start of a line.
    func testAnIndentedMarkerLikeLineIsNotCounted() {
        XCTAssertEqual(ConflictParse.markerCount("  <<<<<<< not a marker\n"), 0)
    }
}
