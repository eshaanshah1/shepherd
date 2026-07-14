import XCTest
@testable import Shepherd

final class WorktreeArchiveTests: XCTestCase {
    private func sample(id: String = "abc", archivedAt: Date) -> ArchivedWorktree {
        ArchivedWorktree(id: id, workspaceID: "ws1", repoDir: "/repo", branch: "feat/x",
                         name: "feat/x", dest: "/wt/feat-x", headCommit: "deadbeef",
                         archivedAt: archivedAt, sessionID: "sess-1")
    }

    func testProtectionRefName() {
        XCTAssertEqual(sample(id: "xyz", archivedAt: Date()).protectionRef,
                       "refs/shepherd/archived-worktrees/xyz")
    }

    func testCodableRoundTrip() throws {
        let a = sample(archivedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let data = try JSONEncoder().encode([a])
        let back = try JSONDecoder().decode([ArchivedWorktree].self, from: data)
        XCTAssertEqual(back, [a])
    }

    func testExpiryIsLiteralNotCalendarRounded() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let day = 86_400.0
        // 89d23h ago → kept; 90d1s ago → expired. Literal elapsed time, no day rounding.
        let justUnder = sample(id: "keep", archivedAt: now.addingTimeInterval(-(90 * day - 3_600)))
        let justOver  = sample(id: "gone", archivedAt: now.addingTimeInterval(-(90 * day + 1)))
        let (keep, expired) = WorktreeArchive.expireArchives([justUnder, justOver], now: now)
        XCTAssertEqual(keep.map(\.id), ["keep"])
        XCTAssertEqual(expired.map(\.id), ["gone"])
    }

    func testExpiryBoundaryIsInclusive() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let exactly90 = sample(id: "edge", archivedAt: now.addingTimeInterval(-(90 * 86_400)))
        let (keep, expired) = WorktreeArchive.expireArchives([exactly90], now: now)
        XCTAssertTrue(keep.isEmpty)
        XCTAssertEqual(expired.map(\.id), ["edge"])
    }

    func testAgeStringUsesLiteralDays() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(WorktreeArchive.archiveAgeString(now.addingTimeInterval(-30), now: now), "just now")
        XCTAssertEqual(WorktreeArchive.archiveAgeString(now.addingTimeInterval(-3 * 3_600), now: now), "3h")
        XCTAssertEqual(WorktreeArchive.archiveAgeString(now.addingTimeInterval(-7 * 86_400), now: now), "7d")
        XCTAssertEqual(WorktreeArchive.archiveAgeString(now.addingTimeInterval(-30 * 86_400), now: now), "30d")
        // 7d + 23h is still "7d" — literal floor, never rounded up to 8d.
        XCTAssertEqual(WorktreeArchive.archiveAgeString(now.addingTimeInterval(-(7 * 86_400 + 23 * 3_600)), now: now), "7d")
    }
}
