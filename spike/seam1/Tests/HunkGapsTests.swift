import XCTest
@testable import Shepherd

/// Splitting the skipped lines between hunks into what to draw. Getting this wrong shows
/// the wrong line count, or reveals lines from the wrong end of the gap.
final class HunkGapsTests: XCTestCase {

    func testAnUntouchedGapIsOneCollapsedRun() {
        XCTAssertEqual(HunkGaps.segments(gap: 10..<50, revealed: []), [.collapsed(10..<50)])
    }

    func testAnEmptyGapProducesNothing() {
        XCTAssertEqual(HunkGaps.segments(gap: 10..<10, revealed: []), [])
    }

    func testAFullyRevealedGapIsOneRevealedRun() {
        XCTAssertEqual(HunkGaps.segments(gap: 10..<15, revealed: Set(10..<15)),
                       [.revealed(10..<15)])
    }

    func testRevealingFromTheTopLeavesACollapsedTail() {
        let revealed = HunkGaps.expandingDown(10..<50)
        XCTAssertEqual(HunkGaps.segments(gap: 10..<50, revealed: revealed),
                       [.revealed(10..<20), .collapsed(20..<50)])
    }

    func testRevealingFromTheBottomLeavesACollapsedHead() {
        let revealed = HunkGaps.expandingUp(10..<50)
        XCTAssertEqual(HunkGaps.segments(gap: 10..<50, revealed: revealed),
                       [.collapsed(10..<40), .revealed(40..<50)])
    }

    func testRevealingBothEndsLeavesACollapsedMiddle() {
        var revealed = HunkGaps.expandingDown(10..<50)
        revealed.formUnion(HunkGaps.expandingUp(10..<50))
        XCTAssertEqual(HunkGaps.segments(gap: 10..<50, revealed: revealed),
                       [.revealed(10..<20), .collapsed(20..<40), .revealed(40..<50)])
    }

    /// Two expansions meeting in the middle must become one run, not two abutting ones —
    /// which is the reason revealed lines are a set rather than a list of ranges.
    func testExpansionsMeetingInTheMiddleMerge() {
        var revealed = HunkGaps.expandingDown(10..<30)
        revealed.formUnion(HunkGaps.expandingUp(10..<30))
        XCTAssertEqual(HunkGaps.segments(gap: 10..<30, revealed: revealed), [.revealed(10..<30)])
    }

    func testExpandingTakesAtMostAStepAndNeverOverruns() {
        XCTAssertEqual(HunkGaps.expandingDown(10..<50), Set(10..<20))
        XCTAssertEqual(HunkGaps.expandingUp(10..<50), Set(40..<50))
        // A gap shorter than the step yields the whole gap, not a range past its end.
        XCTAssertEqual(HunkGaps.expandingDown(10..<13), Set(10..<13))
        XCTAssertEqual(HunkGaps.expandingUp(10..<13), Set(10..<13))
    }

    func testSmallGapsOfferASingleShowAll() {
        XCTAssertTrue(HunkGaps.isFullyExpandable(10..<20))   // exactly one step
        XCTAssertTrue(HunkGaps.isFullyExpandable(10..<13))
        XCTAssertFalse(HunkGaps.isFullyExpandable(10..<21))
    }

    /// Repeated clicks walk the gap down ten at a time until it closes.
    func testRepeatedExpansionEventuallyClosesTheGap() {
        let gap = 0..<25
        var revealed: Set<Int> = []
        var rounds = 0
        while let collapsed = HunkGaps.segments(gap: gap, revealed: revealed)
            .compactMap({ if case .collapsed(let r) = $0 { return r } else { return nil } })
            .first {
            revealed.formUnion(HunkGaps.expandingDown(collapsed))
            rounds += 1
            XCTAssertLessThan(rounds, 10, "expansion is not making progress")
        }
        XCTAssertEqual(rounds, 3)   // 10 + 10 + 5
        XCTAssertEqual(HunkGaps.segments(gap: gap, revealed: revealed), [.revealed(gap)])
    }
}
