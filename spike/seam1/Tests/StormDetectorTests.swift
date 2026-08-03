import XCTest
@testable import Shepherd

final class StormDetectorTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testAHealthyClientIsNeverReported() {
        var d = StormDetector()   // production defaults
        // One reconnect every 2s for a minute: a lossy link, not a storm.
        for i in 0..<30 {
            XCTAssertNil(d.record(peer: "10.0.0.1", at: t0.addingTimeInterval(Double(i) * 2)))
        }
    }

    /// The measured shape of the real defect: ~1/second, sustained.
    func testOnePerSecondIsReported() {
        var d = StormDetector()   // production defaults — the real storm must trip them
        var reported: (count: Int, window: TimeInterval)?
        for i in 0..<12 {
            if let r = d.record(peer: "10.20.3.5", at: t0.addingTimeInterval(Double(i))) { reported = r }
        }
        XCTAssertNotNil(reported)
        XCTAssertGreaterThan(reported!.count, 6)
    }

    /// The warning must not become the storm.
    func testReportsAtMostOncePerCooldown() {
        var d = StormDetector(threshold: 5, window: 10, reportEvery: 30)
        var count = 0
        for i in 0..<60 where d.record(peer: "p", at: t0.addingTimeInterval(Double(i) * 0.5)) != nil {
            count += 1; _ = i
        }
        // 30s of hammering at 2/s ⇒ one report, maybe a second as the cooldown lapses.
        XCTAssertLessThanOrEqual(count, 2, "reported \(count) times")
        XCTAssertGreaterThanOrEqual(count, 1)
    }

    func testPeersAreCountedSeparately() {
        var d = StormDetector(threshold: 5, window: 10)
        for i in 0..<5 {
            XCTAssertNil(d.record(peer: "a", at: t0.addingTimeInterval(Double(i))))
            XCTAssertNil(d.record(peer: "b", at: t0.addingTimeInterval(Double(i))))
        }
    }

    /// The arithmetic that let the real storm through the first version: N per window can only
    /// EQUAL the threshold, never exceed it, so a threshold set to the observed rate detects
    /// nothing. Kept as a test so the defaults can never drift back onto that line.
    func testSteadyRateAtTheThresholdWouldNeverTrip() {
        var d = StormDetector(threshold: 10, window: 10)
        var reported = false
        for i in 0..<40 where d.record(peer: "p", at: t0.addingTimeInterval(Double(i))) != nil { reported = true; _ = i }
        XCTAssertFalse(reported, "1/s cannot exceed 10-in-10s — that is why the default is lower")
    }

    /// Old timestamps must leave the window, or any long-lived client eventually looks abusive.
    func testTheWindowSlides() {
        var d = StormDetector(threshold: 3, window: 10)
        for i in 0..<3 { _ = d.record(peer: "p", at: t0.addingTimeInterval(Double(i))) }
        XCTAssertNil(d.record(peer: "p", at: t0.addingTimeInterval(100)),
                     "connections older than the window must not count")
    }

    func testPruneDropsQuietPeers() {
        var d = StormDetector()
        _ = d.record(peer: "gone", at: t0)
        _ = d.record(peer: "here", at: t0.addingTimeInterval(200))
        d.prune(before: t0.addingTimeInterval(100))
        XCTAssertNil(d.recent["gone"])
        XCTAssertNotNil(d.recent["here"])
    }
}
