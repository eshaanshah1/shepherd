import XCTest
@testable import Shepherd

final class MarkdownDiffTests: XCTestCase {

    // MARK: SequenceAlign

    func testAlignIdentical() {
        XCTAssertEqual(SequenceAlign.lcs(["a", "b"], ["a", "b"]),
                       [.keep(old: 0, new: 0), .keep(old: 1, new: 1)])
    }

    func testAlignReplacement() {
        XCTAssertEqual(SequenceAlign.lcs(["a", "x", "c"], ["a", "y", "c"]),
                       [.keep(old: 0, new: 0), .remove(old: 1), .add(new: 1), .keep(old: 2, new: 2)])
    }

    func testAlignInsertAndDelete() {
        XCTAssertEqual(SequenceAlign.lcs(["a", "c"], ["a", "b", "c"]),
                       [.keep(old: 0, new: 0), .add(new: 1), .keep(old: 1, new: 2)])
        XCTAssertEqual(SequenceAlign.lcs(["a", "b", "c"], ["a", "c"]),
                       [.keep(old: 0, new: 0), .remove(old: 1), .keep(old: 2, new: 1)])
    }

    func testAlignEmptySides() {
        XCTAssertEqual(SequenceAlign.lcs([], ["a"]), [.add(new: 0)])
        XCTAssertEqual(SequenceAlign.lcs(["a"], []), [.remove(old: 0)])
        XCTAssertEqual(SequenceAlign.lcs([], []), [])
    }

    // MARK: MarkdownInlineDiff

    func testWordDiffSingleTokenChange() {
        XCTAssertEqual(MarkdownInlineDiff.diff(old: "27 agents", new: "26 agents"),
                       [.remove("27"), .add("26"), .keep("agents")])
    }

    func testWordDiffIdentical() {
        XCTAssertEqual(MarkdownInlineDiff.diff(old: "same text", new: "same text"),
                       [.keep("same"), .keep("text")])
    }

    func testWordDiffInsertionAtEnd() {
        XCTAssertEqual(MarkdownInlineDiff.diff(old: "hello", new: "hello world"),
                       [.keep("hello"), .add("world")])
    }

    func testWordDiffCollapsesWhitespace() {
        XCTAssertEqual(MarkdownInlineDiff.tokenize("a   b\n\nc"), ["a", "b", "c"])
    }

    // MARK: MarkdownFrontmatter

    func testFrontmatterSplitFieldsAndBody() {
        let src = "---\ntitle: Foo\nstatus: draft\n---\n\n# Heading\n\nBody."
        let (fields, body) = MarkdownFrontmatter.split(src)
        XCTAssertEqual(fields, [.init(key: "title", value: "Foo"), .init(key: "status", value: "draft")])
        XCTAssertEqual(body, "# Heading\n\nBody.")
    }

    func testFrontmatterValueKeepsInnerColons() {
        XCTAssertEqual(MarkdownFrontmatter.parse("url: https://x.com/a:b"),
                       [.init(key: "url", value: "https://x.com/a:b")])
    }

    func testFrontmatterValuelessKey() {
        XCTAssertEqual(MarkdownFrontmatter.parse("confluence_page_id:"),
                       [.init(key: "confluence_page_id", value: "")])
    }

    func testNoFrontmatterReturnsWholeBody() {
        let src = "# Just a heading\n\nText."
        let (fields, body) = MarkdownFrontmatter.split(src)
        XCTAssertNil(fields)
        XCTAssertEqual(body, src)
    }

    func testUnterminatedFrontmatterIsNotFrontmatter() {
        let src = "---\n# Heading"
        let (fields, _) = MarkdownFrontmatter.split(src)
        XCTAssertNil(fields)
    }

    func testLongerDashRunsAreFrontmatter() {
        let (fields, body) = MarkdownFrontmatter.split("------\ntitle: Foo\n-----\n\nBody.")
        XCTAssertEqual(fields, [.init(key: "title", value: "Foo")])
        XCTAssertEqual(body, "Body.")
    }

    // MARK: MarkdownTableDiff

    func testTableSingleCellChange() {
        let old = [["Field", "Value"], ["agents", "27"]]
        let new = [["Field", "Value"], ["agents", "26"]]
        let r = MarkdownTableDiff.diff(old: old, new: new)
        XCTAssertEqual(r.changed, [.init(row: 1, col: 1): "27"])
        XCTAssertTrue(r.addedRows.isEmpty)
        XCTAssertTrue(r.removedRows.isEmpty)
    }

    func testTableIdenticalNoChanges() {
        let g = [["a", "b"], ["c", "d"]]
        XCTAssertEqual(MarkdownTableDiff.diff(old: g, new: g), MarkdownTableDiff.Result())
    }

    func testTableAddedRow() {
        let old = [["h1", "h2"], ["a", "b"]]
        let new = [["h1", "h2"], ["a", "b"], ["c", "d"]]
        let r = MarkdownTableDiff.diff(old: old, new: new)
        XCTAssertEqual(r.addedRows, [2])
        XCTAssertTrue(r.changed.isEmpty)
    }

    func testTableRemovedRow() {
        let old = [["h1", "h2"], ["a", "b"], ["c", "d"]]
        let new = [["h1", "h2"], ["a", "b"]]
        let r = MarkdownTableDiff.diff(old: old, new: new)
        XCTAssertEqual(r.removedRows, [2])
        XCTAssertTrue(r.changed.isEmpty)
    }
}
