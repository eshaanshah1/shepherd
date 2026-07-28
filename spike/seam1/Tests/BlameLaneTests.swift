import XCTest
@testable import Shepherd

/// The lane's shape. Age gives the heat, a separator at each run start gives the grouping —
/// two encodings that do not fight, so "this whole block is one change" reads at a glance.
final class BlameLaneTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let shaA = String(repeating: "a", count: 40)
    private let shaB = String(repeating: "b", count: 40)

    private func blame(_ pairs: [(Int, String)],
                       meta: [String: BlameCommitMeta] = [:]) -> BlameResult {
        BlameResult(shaByLine: Dictionary(uniqueKeysWithValues: pairs), meta: meta)
    }

    func testShadeBuckets() {
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-3600), now: now),
                       .fresh)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-4 * 86400), now: now),
                       .recent)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-40 * 86400), now: now),
                       .stale)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-400 * 86400), now: now),
                       .old)
    }

    /// A row is a run start when its commit differs from the row above it — that is what the
    /// separator is drawn from.
    func testConsecutiveRowsOfOneCommitFormOneRun() {
        let rows = BlameLane.rows(lineNumbers: [1, 2, 3],
                                  blame: blame([(1, shaA), (2, shaA), (3, shaA)]), now: now)
        XCTAssertEqual(rows.compactMap { $0?.isRunStart }, [true, false, false])
    }

    func testACommitChangeStartsANewRun() {
        let rows = BlameLane.rows(lineNumbers: [1, 2, 3],
                                  blame: blame([(1, shaA), (2, shaB), (3, shaB)]), now: now)
        XCTAssertEqual(rows.compactMap { $0?.isRunStart }, [true, true, false])
    }

    /// A band has no new-side line number, so it gets no lane cell at all — and it must not
    /// merge the runs either side of it into one.
    func testRowsWithNoLineNumberGetNoCellAndBreakTheRun() {
        let rows = BlameLane.rows(lineNumbers: [1, nil, 2],
                                  blame: blame([(1, shaA), (2, shaA)]), now: now)
        XCTAssertEqual(rows.count, 3)
        XCTAssertNil(rows[1])
        XCTAssertEqual(rows[0]?.isRunStart, true)
        XCTAssertEqual(rows[2]?.isRunStart, true)
    }

    /// A line the blame does not cover draws nothing rather than guessing.
    func testUnknownLineGetsNoCell() {
        let rows = BlameLane.rows(lineNumbers: [1, 99],
                                  blame: blame([(1, shaA)]), now: now)
        XCTAssertNotNil(rows[0])
        XCTAssertNil(rows[1])
    }

    func testUncommittedLinesGetTheUncommittedShade() {
        let rows = BlameLane.rows(lineNumbers: [1],
                                  blame: blame([(1, BlameResult.uncommittedSha)]), now: now)
        XCTAssertEqual(rows[0]?.shade, .uncommitted)
    }

    /// With no metadata for a sha there is no timestamp, so no age — it still gets a cell and
    /// a run boundary, just the oldest shade. Abstaining would read as "not committed", which
    /// is a different and wrong claim.
    func testMissingMetadataFallsBackToOldRatherThanNoCell() {
        let rows = BlameLane.rows(lineNumbers: [1], blame: blame([(1, shaA)]), now: now)
        XCTAssertEqual(rows[0]?.shade, .old)
        XCTAssertEqual(rows[0]?.sha, shaA)
    }

    /// With metadata, the shade comes from the commit's own timestamp.
    func testShadeComesFromTheCommitsTimestamp() {
        let meta = [shaA: BlameCommitMeta(author: "A",
                                          timestamp: now.addingTimeInterval(-3600),
                                          summary: "recent work")]
        let rows = BlameLane.rows(lineNumbers: [1], blame: blame([(1, shaA)], meta: meta),
                                  now: now)
        XCTAssertEqual(rows[0]?.shade, .fresh)
    }

    func testEmptyDocument() {
        XCTAssertTrue(BlameLane.rows(lineNumbers: [], blame: .empty, now: now).isEmpty)
    }
}
