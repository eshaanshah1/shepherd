import XCTest
@testable import Shepherd

/// The PR band's model. `gh`'s rollup mixes two shapes and `mergeStateStatus` has a
/// vocabulary that decides whether a merge button is live, so both are pinned here.
final class PRDetailTests: XCTestCase {

    private func detail(_ json: String) -> PRDetail? {
        PR.parseDetail(Data(json.utf8))
    }

    // MARK: - Parsing

    func testParsesTheFieldsTheBandShows() {
        let d = detail("""
        {"number": 42, "url": "https://github.com/o/r/pull/42", "title": "Add the thing",
         "state": "OPEN", "isDraft": false, "reviewDecision": "APPROVED",
         "mergeStateStatus": "CLEAN", "statusCheckRollup": []}
        """)
        XCTAssertEqual(d?.number, 42)
        XCTAssertEqual(d?.title, "Add the thing")
        XCTAssertEqual(d?.reviewDecision, "APPROVED")
        XCTAssertEqual(d?.mergeability, .ready)
        XCTAssertNil(d?.checksSummary)   // no checks at all, not "0/0"
    }

    func testNoPRParsesToNil() {
        XCTAssertNil(detail("{}"))
        XCTAssertNil(detail("not json"))
        // A payload with a number but no url is not usable either.
        XCTAssertNil(detail(#"{"number": 1, "url": ""}"#))
    }

    /// CheckRun uses name/conclusion/detailsUrl; StatusContext uses context/state/targetUrl.
    func testParsesBothRollupShapes() {
        let d = detail("""
        {"number": 1, "url": "u", "statusCheckRollup": [
          {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS",
           "detailsUrl": "https://ci/build"},
          {"context": "legacy/lint", "state": "FAILURE", "targetUrl": "https://ci/lint"}
        ]}
        """)
        XCTAssertEqual(d?.checks.count, 2)
        XCTAssertEqual(d?.checks.first?.name, "build")
        XCTAssertEqual(d?.checks.first?.verdict, .passing)
        XCTAssertEqual(d?.checks.first?.url, "https://ci/build")
        XCTAssertEqual(d?.checks.last?.name, "legacy/lint")
        XCTAssertEqual(d?.checks.last?.verdict, .failing)
    }

    func testAnInFlightCheckIsPendingNotPassing() {
        let d = detail("""
        {"number": 1, "url": "u", "statusCheckRollup": [
          {"name": "test", "status": "IN_PROGRESS"}
        ]}
        """)
        XCTAssertEqual(d?.checks.first?.verdict, .pending)
        XCTAssertEqual(d?.rollup, .pending)
    }

    func testAnEmptyDetailsUrlBecomesNilRatherThanABlankLink() {
        let d = detail(#"{"number":1,"url":"u","statusCheckRollup":[{"name":"a","detailsUrl":""}]}"#)
        XCTAssertNil(d?.checks.first?.url)
    }

    // MARK: - Rollup

    func testRollupIsFailingIfAnyFails() {
        let checks = [
            PRCheck(name: "a", verdict: .passing, url: nil),
            PRCheck(name: "b", verdict: .pending, url: nil),
            PRCheck(name: "c", verdict: .failing, url: nil),
        ]
        XCTAssertEqual(PR.checksVerdict(ofParsed: checks), .failing)
    }

    func testRollupIsPendingWhenNothingFailsButSomethingRuns() {
        let checks = [
            PRCheck(name: "a", verdict: .passing, url: nil),
            PRCheck(name: "b", verdict: .pending, url: nil),
        ]
        XCTAssertEqual(PR.checksVerdict(ofParsed: checks), .pending)
    }

    func testRollupOfNothingIsNoneNotPassing() {
        XCTAssertEqual(PR.checksVerdict(ofParsed: []), .none)
    }

    func testChecksSummaryCountsOnlyPassing() {
        let d = detail("""
        {"number": 1, "url": "u", "statusCheckRollup": [
          {"name": "a", "conclusion": "SUCCESS"},
          {"name": "b", "conclusion": "FAILURE"},
          {"name": "c", "status": "QUEUED"}
        ]}
        """)
        XCTAssertEqual(d?.checksSummary, "1/3 checks passing")
        XCTAssertEqual(d?.failingChecks.map(\.name), ["b"])
    }

    // MARK: - Mergeability

    func testCleanIsReady() {
        XCTAssertEqual(PR.mergeability(state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN"),
                       .ready)
    }

    /// Every blocked state must carry a reason — a disabled button with no explanation is
    /// the thing this type exists to prevent.
    func testEveryBlockedStateExplainsItself() {
        for status in ["BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT"] {
            let result = PR.mergeability(state: "OPEN", isDraft: false, mergeStateStatus: status)
            XCTAssertNotNil(result.reason, "\(status) gave no reason")
            XCTAssertFalse(result.isReady, "\(status) should not be mergeable")
        }
    }

    func testDraftAndClosedBeatTheMergeState() {
        XCTAssertEqual(PR.mergeability(state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN"),
                       .blocked("This PR is a draft."))
        XCTAssertEqual(PR.mergeability(state: "MERGED", isDraft: false, mergeStateStatus: "CLEAN"),
                       .blocked("This PR is merged."))
    }

    /// GitHub omits mergeStateStatus for some tokens/permissions; that is "don't know",
    /// which must not read as "ready".
    func testAMissingMergeStateIsUnknownNotReady() {
        let result = PR.mergeability(state: "OPEN", isDraft: false, mergeStateStatus: "")
        XCTAssertEqual(result, .unknown)
        XCTAssertFalse(result.isReady)
        XCTAssertNil(result.reason)
    }
}

/// A merged or closed PR is history — the band must say so rather than showing a stale
/// "Approved / checks passing", which reads as ready to merge.
extension PRDetailTests {
    func testMergedAndClosedAreHistory() {
        for state in ["MERGED", "CLOSED", "merged"] {
            let d = detailFor(state: state)
            XCTAssertTrue(d.isHistory, "\(state) should count as history")
        }
    }

    func testOpenAndDraftAreNotHistory() {
        XCTAssertFalse(detailFor(state: "OPEN").isHistory)
        XCTAssertFalse(detailFor(state: "OPEN", isDraft: true).isHistory)
    }

    private func detailFor(state: String, isDraft: Bool = false) -> PRDetail {
        PRDetail(number: 1, url: "u", title: "t", state: state, isDraft: isDraft,
                 reviewDecision: "APPROVED",
                 mergeability: .ready, checks: [])
    }
}
