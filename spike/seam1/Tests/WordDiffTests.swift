import XCTest
@testable import Shepherd

final class WordDiffTests: XCTestCase {
    /// Concatenate the changed spans' text, so assertions read as "what got tinted".
    private func changedText(_ line: String, _ spans: [WordSpan]) -> String {
        let chars = Array(line)
        return spans.filter(\.changed)
            .map { String(chars[$0.range]) }
            .joined(separator: "|")
    }

    func testIdenticalLinesHaveNoChangedSpans() {
        let (old, new) = WordDiff.spans(old: "let a = 1", new: "let a = 1")
        XCTAssertTrue(old.allSatisfy { !$0.changed })
        XCTAssertTrue(new.allSatisfy { !$0.changed })
    }

    func testASingleChangedWordIsIsolated() {
        let o = "let a = 1", n = "let a = 2"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "1")
        XCTAssertEqual(changedText(n, newSpans), "2")
    }

    func testUnchangedPrefixAndSuffixAreNotMarked() {
        let o = "diffPanelOpen = false", n = "diffPanelOpen = true"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "false")
        XCTAssertEqual(changedText(n, newSpans), "true")
    }

    func testInsertedWordAppearsOnlyOnTheNewSide() {
        let o = "func run()", n = "func run() async"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "")
        XCTAssertTrue(changedText(n, newSpans).contains("async"))
    }

    func testDeletedWordAppearsOnlyOnTheOldSide() {
        let o = "func run() async", n = "func run()"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertTrue(changedText(o, oldSpans).contains("async"))
        XCTAssertEqual(changedText(n, newSpans), "")
    }

    func testSpansTileTheLineWithoutGapsOrOverlap() {
        let line = "let value = compute(a, b)"
        let (_, newSpans) = WordDiff.spans(old: "let value = compute(a)", new: line)
        XCTAssertEqual(newSpans.first?.range.lowerBound, 0)
        XCTAssertEqual(newSpans.last?.range.upperBound, line.count)
        for (a, b) in zip(newSpans, newSpans.dropFirst()) {
            XCTAssertEqual(a.range.upperBound, b.range.lowerBound, "gap or overlap between spans")
        }
    }

    func testAdjacentSpansAlternateChangedness() {
        let (_, newSpans) = WordDiff.spans(old: "a = 1", new: "a = 2")
        for (x, y) in zip(newSpans, newSpans.dropFirst()) {
            XCTAssertNotEqual(x.changed, y.changed, "runs of equal changedness must be merged")
        }
    }

    func testPunctuationOnlyChangeDoesNotSmearTheWholeLine() {
        let o = "foo(a, b)", n = "foo(a; b)"
        let (_, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertFalse(changedText(n, newSpans).contains("foo"),
                       "an identifier that didn't change must not be tinted")
    }

    func testLinesOverTheCapAreMarkedWhollyChanged() {
        let o = String(repeating: "a", count: 20), n = String(repeating: "b", count: 20)
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n, maxLength: 10)
        XCTAssertEqual(oldSpans, [WordSpan(range: 0..<20, changed: true)])
        XCTAssertEqual(newSpans, [WordSpan(range: 0..<20, changed: true)])
    }

    func testEmptyLinesProduceNoSpans() {
        let (old, new) = WordDiff.spans(old: "", new: "")
        XCTAssertTrue(old.isEmpty)
        XCTAssertTrue(new.isEmpty)
    }

    func testAddingToAnEmptyLineMarksTheWholeNewSide() {
        let (old, new) = WordDiff.spans(old: "", new: "let x = 1")
        XCTAssertTrue(old.isEmpty)
        XCTAssertEqual(changedText("let x = 1", new), "let x = 1")
    }
}

/// Which lines a hunk pairs for the intra-line word diff. Getting this wrong doesn't
/// crash — it tints words that never changed, which is how it shipped broken.
final class HunkPairingTests: XCTestCase {

    private func pairing(_ spec: [(DiffLineKind, String)]) -> HunkPairing {
        HunkPairing(kinds: spec.map(\.0), texts: spec.map(\.1))
    }

    func testPairsAnAdjacentEqualLengthRun() {
        let p = pairing([(.context, "keep"), (.removed, "old"), (.added, "new")])
        XCTAssertNil(p.counterpart(atLineIndex: 0))
        XCTAssertEqual(p.counterpart(atLineIndex: 1), "new")
        XCTAssertEqual(p.counterpart(atLineIndex: 2), "old")
    }

    func testPairsByOrdinalWithinTheRun() {
        let p = pairing([(.removed, "a1"), (.removed, "a2"), (.added, "b1"), (.added, "b2")])
        XCTAssertEqual(p.counterpart(atLineIndex: 0), "b1")
        XCTAssertEqual(p.counterpart(atLineIndex: 1), "b2")
        XCTAssertEqual(p.counterpart(atLineIndex: 2), "a1")
        XCTAssertEqual(p.counterpart(atLineIndex: 3), "a2")
    }

    /// The bug this rule exists for: two unrelated edits in one hunk whose removal and
    /// addition totals happen to match. Ordinal-across-the-hunk paired them; runs don't.
    func testDoesNotPairAcrossSeparateEdits() {
        let p = pairing([
            (.removed, "old A"),
            (.context, "unchanged"),
            (.added, "new B"),
        ])
        XCTAssertNil(p.counterpart(atLineIndex: 0))
        XCTAssertNil(p.counterpart(atLineIndex: 2))
    }

    /// A block of pure additions with removals elsewhere in the hunk — the shape that
    /// painted word tints on a vendored all-added file.
    func testPureAdditionRunIsUnpairedEvenWhenTotalsMatch() {
        let p = pairing([
            (.removed, "gone 1"),
            (.added, "arrived 1"),
            (.context, "keep"),
            (.added, "arrived 2"),
            (.added, "arrived 3"),
            (.removed, "gone 2"),
            (.removed, "gone 3"),
        ])
        // The adjacent 1:1 run still pairs.
        XCTAssertEqual(p.counterpart(atLineIndex: 0), "arrived 1")
        XCTAssertEqual(p.counterpart(atLineIndex: 1), "gone 1")
        // The stranded additions and trailing removals do not.
        XCTAssertNil(p.counterpart(atLineIndex: 3))
        XCTAssertNil(p.counterpart(atLineIndex: 4))
        XCTAssertNil(p.counterpart(atLineIndex: 5))
        XCTAssertNil(p.counterpart(atLineIndex: 6))
    }

    func testUnequalAdjacentRunsAreUnpaired() {
        let p = pairing([(.removed, "old"), (.added, "new 1"), (.added, "new 2")])
        XCTAssertNil(p.counterpart(atLineIndex: 0))
        XCTAssertNil(p.counterpart(atLineIndex: 1))
        XCTAssertNil(p.counterpart(atLineIndex: 2))
    }

    func testAdditionsWithNoPrecedingRemovalsAreUnpaired() {
        let p = pairing([(.context, "keep"), (.added, "new 1"), (.added, "new 2")])
        XCTAssertNil(p.counterpart(atLineIndex: 1))
        XCTAssertNil(p.counterpart(atLineIndex: 2))
    }

    func testTwoSeparateAdjacentRunsBothPair() {
        let p = pairing([
            (.removed, "x1"), (.added, "y1"),
            (.context, "keep"),
            (.removed, "x2"), (.added, "y2"),
        ])
        XCTAssertEqual(p.counterpart(atLineIndex: 0), "y1")
        XCTAssertEqual(p.counterpart(atLineIndex: 3), "y2")
    }

    func testEmptyHunk() {
        XCTAssertNil(pairing([]).counterpart(atLineIndex: 0))
    }
}
