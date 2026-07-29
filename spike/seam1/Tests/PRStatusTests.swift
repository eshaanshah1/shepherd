import XCTest
@testable import Shepherd

final class PRStatusTests: XCTestCase {

    // MARK: classifyPR priority

    func testMergedAndClosedWinOverEverything() {
        XCTAssertEqual(PR.classify(state: "MERGED", isDraft: true, reviewDecision: "CHANGES_REQUESTED",
                                  checks: .failing, mergeState: "DIRTY"), .merged)
        XCTAssertEqual(PR.classify(state: "CLOSED", isDraft: true, reviewDecision: "",
                                  checks: .failing, mergeState: ""), .closed)
    }

    func testDraftBeatsChecksAndReview() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED",
                                  checks: .failing, mergeState: ""), .draft)
    }

    func testChecksFailingBeatsReview() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED",
                                  checks: .failing, mergeState: ""), .checksFailing)
    }

    func testChangesRequestedBeatsPendingChecks() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: false, reviewDecision: "CHANGES_REQUESTED",
                                  checks: .pending, mergeState: ""), .changesRequested)
    }

    // MARK: unresolved review comments

    /// Unresolved inline review threads are the author's move, so they become their own state
    /// rather than decoration on top of `open`.
    func testUnresolvedCommentsBecomeTheirOwnState() {
        XCTAssertEqual(PR.withUnresolvedComments(.mergeReady, count: 3), .commentsToAddress)
        XCTAssertEqual(PR.withUnresolvedComments(.open, count: 1), .commentsToAddress)
    }

    /// Above pending checks and review-required: waiting on CI or a reviewer is not something
    /// you can act on, an unaddressed comment is.
    func testUnresolvedCommentsBeatTheSofterStates() {
        XCTAssertEqual(PR.withUnresolvedComments(.checksPending, count: 1), .commentsToAddress)
        XCTAssertEqual(PR.withUnresolvedComments(.reviewRequired, count: 1), .commentsToAddress)
    }

    /// Below the two hard blocks: a failing build and a formal changes-requested already say
    /// "your move", and both are worse news than an individual thread.
    func testFailingChecksAndChangesRequestedStillWin() {
        XCTAssertEqual(PR.withUnresolvedComments(.checksFailing, count: 5), .checksFailing)
        XCTAssertEqual(PR.withUnresolvedComments(.changesRequested, count: 5), .changesRequested)
    }

    /// On a merged, closed or draft PR the threads are stale trivia.
    func testUnresolvedCommentsIrrelevantOnDeadOrDraftPRs() {
        XCTAssertEqual(PR.withUnresolvedComments(.merged, count: 4), .merged)
        XCTAssertEqual(PR.withUnresolvedComments(.closed, count: 4), .closed)
        XCTAssertEqual(PR.withUnresolvedComments(.draft, count: 4), .draft)
    }

    /// Zero threads never changes a verdict.
    func testNoUnresolvedCommentsLeavesEveryKindAlone() {
        for kind in [PRKind.merged, .closed, .draft, .checksFailing, .changesRequested,
                     .commentsToAddress, .checksPending, .reviewRequired, .mergeReady, .open] {
            XCTAssertEqual(PR.withUnresolvedComments(kind, count: 0), kind)
        }
    }

    func testPendingChecksBeatReviewRequired() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED",
                                  checks: .pending, mergeState: ""), .checksPending)
    }

    func testMergeReadyWhenCleanAndClear() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
                                  checks: .passing, mergeState: "CLEAN"), .mergeReady)
    }

    func testOpenFallback() {
        XCTAssertEqual(PR.classify(state: "OPEN", isDraft: false, reviewDecision: "",
                                  checks: .passing, mergeState: "BEHIND"), .open)
    }

    // MARK: checksVerdict

    func testChecksVerdictReduction() {
        XCTAssertEqual(PR.checksVerdict(from: []), .none)
        XCTAssertEqual(PR.checksVerdict(from: [["conclusion": "SUCCESS"], ["state": "SUCCESS"]]), .passing)
        XCTAssertEqual(PR.checksVerdict(from: [["conclusion": "SUCCESS"], ["conclusion": "FAILURE"]]), .failing)
        XCTAssertEqual(PR.checksVerdict(from: [["status": "IN_PROGRESS", "conclusion": ""], ["conclusion": "SUCCESS"]]), .pending)
        XCTAssertEqual(PR.checksVerdict(from: [["state": "PENDING"]]), .pending)
    }

    // MARK: parsePRStatus

    private func json(_ s: String) -> Data { Data(s.utf8) }

    func testParseOpenPassing() {
        let pr = PR.parse(json("""
        {"number":42,"url":"https://github.com/o/r/pull/42","state":"OPEN","isDraft":false,
         "reviewDecision":"APPROVED","mergeStateStatus":"CLEAN",
         "statusCheckRollup":[{"conclusion":"SUCCESS"}]}
        """))
        XCTAssertEqual(pr, PRStatus(number: 42, url: "https://github.com/o/r/pull/42", kind: .mergeReady))
    }

    func testParseDraft() {
        let pr = PR.parse(json("""
        {"number":1,"url":"https://x/pull/1","state":"OPEN","isDraft":true,
         "statusCheckRollup":[]}
        """))
        XCTAssertEqual(pr?.kind, .draft)
    }

    func testParseChecksFailing() {
        let pr = PR.parse(json("""
        {"number":7,"url":"https://x/pull/7","state":"OPEN","isDraft":false,
         "reviewDecision":"","mergeStateStatus":"UNSTABLE",
         "statusCheckRollup":[{"conclusion":"FAILURE"}]}
        """))
        XCTAssertEqual(pr?.kind, .checksFailing)
    }

    func testParseMerged() {
        let pr = PR.parse(json(#"{"number":3,"url":"https://x/pull/3","state":"MERGED"}"#))
        XCTAssertEqual(pr?.kind, .merged)
    }

    func testNoPRReturnsNil() {
        XCTAssertNil(PR.parse(json("{}")))
        XCTAssertNil(PR.parse(json("not json")))
        XCTAssertNil(PR.parse(json(#"{"number":5}"#)))   // missing url
    }
}
