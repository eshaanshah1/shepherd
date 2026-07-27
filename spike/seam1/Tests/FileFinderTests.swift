import XCTest
@testable import Shepherd

/// `⌘P`'s ranking. Asserted as orderings rather than exact scores — the weights are a
/// judgement call, the orderings are what a file finder has to get right.
final class FileFinderTests: XCTestCase {

    private func ranked(_ paths: [String], _ query: String) -> [String] {
        FileFinder.rank(paths, query: query).map(\.path)
    }

    // MARK: - Matching

    func testMatchesASubsequenceAnywhereInThePath() {
        XCTAssertNotNil(FileFinder.match(path: "Sources/Workbench/RowPlan.swift", query: "rowplan"))
        XCTAssertNotNil(FileFinder.match(path: "Sources/Workbench/RowPlan.swift", query: "swrp"))
    }

    func testRejectsAQueryThatIsNotASubsequence() {
        XCTAssertNil(FileFinder.match(path: "Sources/RowPlan.swift", query: "zzz"))
        // Right characters, wrong order.
        XCTAssertNil(FileFinder.match(path: "Sources/RowPlan.swift", query: "nalpwor"))
    }

    func testMatchingIsCaseInsensitive() {
        XCTAssertNotNil(FileFinder.match(path: "Sources/RowPlan.swift", query: "ROWPLAN"))
    }

    func testReportsTheMatchedOffsetsForHighlighting() {
        let match = FileFinder.match(path: "abc/def", query: "ad")
        XCTAssertEqual(match?.matched, [0, 4])
    }

    func testAnEmptyQueryKeepsInputOrderAndIsCapped() {
        let paths = (1...80).map { "file\($0).swift" }
        let out = FileFinder.rank(paths, query: "  ", limit: 10)
        XCTAssertEqual(out.count, 10)
        XCTAssertEqual(out.first?.path, "file1.swift")
    }

    // MARK: - Ordering

    func testAMatchInTheBasenameBeatsOneInTheDirectory() {
        let out = ranked(["session/other.swift", "src/Session.swift"], "session")
        XCTAssertEqual(out.first, "src/Session.swift")
    }

    func testConsecutiveCharactersBeatScatteredOnes() {
        let out = ranked(["s_o_m_e_t_h_i_n_g.swift", "something.swift"], "something")
        XCTAssertEqual(out.first, "something.swift")
    }

    func testWordBoundariesAreFavoured() {
        // "rp" as the initials of Row/Plan beats the same letters mid-word.
        let out = ranked(["Sources/harpoon.swift", "Sources/RowPlan.swift"], "rp")
        XCTAssertEqual(out.first, "Sources/RowPlan.swift")
    }

    func testShorterPathsWinAllElseEqual() {
        let out = ranked(["a/very/deeply/nested/path/to/Row.swift", "Row.swift"], "row")
        XCTAssertEqual(out.first, "Row.swift")
    }

    func testNonMatchesAreDroppedEntirely() {
        XCTAssertEqual(ranked(["RowPlan.swift", "Theme.swift"], "rowplan"), ["RowPlan.swift"])
    }

    func testTiesBreakOnPathSoResultsDoNotReshuffle() {
        let out = ranked(["b.swift", "a.swift"], "swift")
        XCTAssertEqual(out, ["a.swift", "b.swift"])
    }

    func testRespectsTheLimit() {
        let paths = (1...40).map { "Row\($0).swift" }
        XCTAssertEqual(FileFinder.rank(paths, query: "row", limit: 5).count, 5)
    }
}
