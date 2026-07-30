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

    func testFreshNeedleSeeksOnceMatchesArrive() {
        var s = SearchState()
        s.beginQuery("error")
        XCTAssertFalse(s.takeSeek(), "no matches reported yet — nothing to seek to")
        s.applyTotal(0)
        XCTAssertFalse(s.takeSeek())
        s.applyTotal(12)
        XCTAssertTrue(s.takeSeek())
        XCTAssertFalse(s.takeSeek(), "one seek per needle, else the counter steps twice")
    }

    func testEmptyNeedleNeverSeeks() {
        var s = SearchState()
        s.beginQuery("")
        s.applyTotal(9)
        XCTAssertFalse(s.takeSeek())
    }

    func testEveryNeedleGetsItsOwnSeek() {
        var s = SearchState(query: "a", total: 3, selected: 2)
        s.beginQuery("ab")
        XCTAssertEqual(s.total, 0)
        XCTAssertEqual(s.selected, 0)
        s.applyTotal(1)
        XCTAssertTrue(s.takeSeek())
    }

    func testAnArrivingSelectionCancelsTheSeek() {
        var s = SearchState()
        s.beginQuery("a")
        s.applySelected(0)
        s.applyTotal(3)
        XCTAssertFalse(s.takeSeek())
    }

    func testSelectedArrivesZeroBasedAndDisplaysOneBased() {
        var s = SearchState()
        s.beginQuery("a")
        s.applyTotal(12)
        s.applySelected(0)
        XCTAssertEqual(s.counter, "1/12")
        s.applySelected(11)
        XCTAssertEqual(s.counter, "12/12")
        s.applySelected(-1)
        XCTAssertEqual(s.counter, "0/12")
    }
}
