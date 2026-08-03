import XCTest

/// The pacing, which is a cost decision as much as a correctness one: `SHEPHERD_PTY_SOCK` is
/// injected into every pane whether or not the app serves, so a flat retry means every pane on the
/// machine dials into nothing forever.
final class TapRetryTests: XCTestCase {
    func testIntervalGrowsToTheCapAndStops() {
        var i = TapRetry.start
        var steps = 0
        while i < TapRetry.cap, steps < 20 { i = TapRetry.next(after: i); steps += 1 }
        XCTAssertEqual(i, TapRetry.cap)
        XCTAssertEqual(TapRetry.next(after: TapRetry.cap), TapRetry.cap, "must not exceed the cap")
        XCTAssertLessThan(steps, 6, "should reach the cap quickly, took \(steps)")
    }

    func testAHealthyTapCostsNoWakeups() {
        XCTAssertEqual(TapRetry.pollTimeoutMs(retrying: false, interval: TapRetry.start), -1,
                       "a connected tap must let the pump block indefinitely")
    }

    func testTimeoutTracksTheIntervalWhileRetrying() {
        XCTAssertEqual(TapRetry.pollTimeoutMs(retrying: true, interval: 2), 2_000)
        XCTAssertEqual(TapRetry.pollTimeoutMs(retrying: true, interval: TapRetry.cap),
                       Int32(TapRetry.cap * 1000))
        // Never faster than `start`, whatever it is handed.
        XCTAssertEqual(TapRetry.pollTimeoutMs(retrying: true, interval: 0.01),
                       Int32(TapRetry.start * 1000))
    }

    /// The half that keeps an unserved pane cheap: no socket file ⇒ no socket()/connect() at all.
    func testNoDialWhenNothingIsListening() {
        let now = Date()
        XCTAssertFalse(TapRetry.shouldDial(now: now, lastAttempt: .distantPast,
                                           interval: TapRetry.start, socketExists: false))
        XCTAssertTrue(TapRetry.shouldDial(now: now, lastAttempt: .distantPast,
                                          interval: TapRetry.start, socketExists: true))
    }

    func testIntervalIsRespected() {
        let now = Date()
        XCTAssertFalse(TapRetry.shouldDial(now: now, lastAttempt: now.addingTimeInterval(-1),
                                           interval: 2, socketExists: true), "too soon")
        XCTAssertTrue(TapRetry.shouldDial(now: now, lastAttempt: now.addingTimeInterval(-2.1),
                                          interval: 2, socketExists: true))
    }
}
