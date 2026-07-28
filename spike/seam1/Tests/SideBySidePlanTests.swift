import XCTest
@testable import Shepherd

/// Two-column alignment. Getting this wrong puts unrelated lines opposite each other, which
/// reads as a claim that one became the other.
final class SideBySidePlanTests: XCTestCase {

    private func hunk(_ spec: [(DiffLineKind, String)]) -> DiffHunk {
        var lines: [DiffLine] = []
        var oldNo = 1, newNo = 1
        for (kind, text) in spec {
            switch kind {
            case .context:
                lines.append(DiffLine(kind: .context, text: text,
                                      oldLineNo: oldNo, newLineNo: newNo))
                oldNo += 1; newNo += 1
            case .added:
                lines.append(DiffLine(kind: .added, text: text,
                                      oldLineNo: nil, newLineNo: newNo))
                newNo += 1
            case .removed:
                lines.append(DiffLine(kind: .removed, text: text,
                                      oldLineNo: oldNo, newLineNo: nil))
                oldNo += 1
            }
        }
        return DiffHunk(header: "@@ -1,1 +1,1 @@", oldStart: 1, oldCount: 1,
                        newStart: 1, newCount: 1, lines: lines)
    }

    // MARK: - Shapes

    func testContextPairsWithItself() {
        let pairs = SideBySidePlan.pairs(hunk([(.context, "a"), (.context, "b")]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: 0), SidePair(old: 1, new: 1)])
    }

    func testAPureInsertionLeavesTheLeftEmpty() {
        let pairs = SideBySidePlan.pairs(hunk([(.context, "a"), (.added, "new")]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: 0), SidePair(old: nil, new: 1)])
    }

    func testAPureDeletionLeavesTheRightEmpty() {
        let pairs = SideBySidePlan.pairs(hunk([(.context, "a"), (.removed, "gone")]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: 0), SidePair(old: 1, new: nil)])
    }

    func testEqualLengthRunsPairLineForLine() {
        let pairs = SideBySidePlan.pairs(hunk([
            (.removed, "old1"), (.removed, "old2"),
            (.added, "new1"), (.added, "new2"),
        ]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: 2), SidePair(old: 1, new: 3)])
    }

    /// The rule that matters: unequal runs stand alone rather than being paired by ordinal
    /// against a line they have nothing to do with.
    func testUnequalRunsDoNotPair() {
        let pairs = SideBySidePlan.pairs(hunk([
            (.removed, "old1"),
            (.added, "new1"), (.added, "new2"),
        ]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: nil),
                               SidePair(old: nil, new: 1),
                               SidePair(old: nil, new: 2)])
    }

    func testAHunkThatIsEntirelyRemovals() {
        let pairs = SideBySidePlan.pairs(hunk([(.removed, "a"), (.removed, "b")]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: nil), SidePair(old: 1, new: nil)])
    }

    func testAnEmptyHunkPairsNothing() {
        XCTAssertTrue(SideBySidePlan.pairs(hunk([])).isEmpty)
    }

    func testTwoSeparateReplacementsEachPairIndependently() {
        let pairs = SideBySidePlan.pairs(hunk([
            (.removed, "o1"), (.added, "n1"),
            (.context, "mid"),
            (.removed, "o2"), (.added, "n2"),
        ]))
        XCTAssertEqual(pairs, [SidePair(old: 0, new: 1),
                               SidePair(old: 2, new: 2),
                               SidePair(old: 3, new: 4)])
    }

    // MARK: - The tiling property

    /// The alignment equivalent of "excerpts tile the document": every line of the hunk shows
    /// up exactly once, on exactly one side. A line appearing twice would be shown twice; a
    /// line appearing never would silently vanish from the diff.
    func testEveryLineAppearsExactlyOnce() {
        let subject = hunk([
            (.context, "a"),
            (.removed, "o1"), (.removed, "o2"), (.added, "n1"),
            (.context, "b"),
            (.added, "n2"),
            (.removed, "o3"), (.added, "n3"),
            (.context, "c"),
        ])
        let pairs = SideBySidePlan.pairs(subject)
        var seen: [Int] = []
        for pair in pairs {
            if let old = pair.old { seen.append(old) }
            // A paired row references the same index twice only for context, where both
            // sides are the same line.
            if let new = pair.new, new != pair.old { seen.append(new) }
        }
        XCTAssertEqual(seen.sorted(), Array(0..<subject.lines.count),
                       "every hunk line must appear once and only once")
    }

    // MARK: - Right-column gaps

    func testALeftOnlyRunReservesSpaceOppositeTheNextRow() {
        let pairs = SideBySidePlan.pairs(hunk([
            (.removed, "o1"), (.removed, "o2"), (.removed, "o3"),
            (.context, "after"),
        ]))
        let gaps = SideBySidePlan.rightGaps(pairs)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(gaps[0].rows, 3)
        XCTAssertEqual(gaps[0].beforeNewIndex, 3)
    }

    /// A run at the end has no following row, so it trails the hunk — the same edge the
    /// deletion bands hit, where the document's trailing empty line hosts the band.
    func testALeftOnlyRunAtTheEndTrailsTheHunk() {
        let pairs = SideBySidePlan.pairs(hunk([(.context, "a"), (.removed, "gone")]))
        let gaps = SideBySidePlan.rightGaps(pairs)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertNil(gaps[0].beforeNewIndex)
        XCTAssertEqual(gaps[0].rows, 1)
    }

    func testNoLeftOnlyLinesMeansNoGaps() {
        let pairs = SideBySidePlan.pairs(hunk([(.context, "a"), (.added, "b")]))
        XCTAssertTrue(SideBySidePlan.rightGaps(pairs).isEmpty)
    }
}
