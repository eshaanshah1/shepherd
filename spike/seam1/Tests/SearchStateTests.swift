import XCTest

final class SearchStateTests: XCTestCase {
    func testCounterEmptyWithoutQuery() {
        var s = SearchState()
        XCTAssertEqual(s.counter, "")
        s.total = 5; s.selected = 1        // stale counts, no query yet
        XCTAssertEqual(s.counter, "")
    }

    func testCounterShowsSelectedOverTotal() {
        let s = SearchState(query: "foo", total: 12, selected: 3)
        XCTAssertEqual(s.counter, "3/12")
    }

    func testCounterZeroSelectedWhileMatching() {
        let s = SearchState(query: "foo", total: 12, selected: 0)
        XCTAssertEqual(s.counter, "0/12")
    }

    func testNoMatches() {
        XCTAssertTrue(SearchState(query: "zzz", total: 0, selected: 0).noMatches)
        XCTAssertFalse(SearchState(query: "", total: 0, selected: 0).noMatches)   // no query ≠ no matches
        XCTAssertFalse(SearchState(query: "foo", total: 1, selected: 1).noMatches)
    }

    func testDirectionRawValuesMatchBindingParams() {
        XCTAssertEqual(SearchDirection.next.rawValue, "next")
        XCTAssertEqual(SearchDirection.previous.rawValue, "previous")
    }
}
