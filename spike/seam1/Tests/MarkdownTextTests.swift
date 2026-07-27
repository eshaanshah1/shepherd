import XCTest
@testable import Shepherd

/// Block flattening for rendered comment bodies. The renderer is a view, but *what
/// blocks a document becomes* is the part that can silently drop someone's words.
final class MarkdownTextTests: XCTestCase {

    private func blocks(_ source: String) -> [MarkdownBlock] { MarkdownBlock.parse(source) }

    private func plain(_ block: MarkdownBlock?) -> String {
        switch block {
        case .paragraph(let t), .heading(_, let t), .quote(let t): return String(t.characters)
        case .listItem(_, _, let t): return String(t.characters)
        case .code(let t): return t
        case .rule, nil: return ""
        }
    }

    func testAPlainParagraph() {
        let result = blocks("Just a sentence.")
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(plain(result.first), "Just a sentence.")
    }

    func testEmptySourceProducesNothing() {
        XCTAssertTrue(blocks("").isEmpty)
    }

    /// The case that made raw display worst — a fenced block in a review comment.
    func testFencedCodeKeepsItsContentVerbatim() {
        let result = blocks("""
        Try this:

        ```swift
        let x = 1
        print(x)
        ```
        """)
        XCTAssertEqual(result.count, 2)
        guard case .code(let code) = result[1] else { return XCTFail("expected a code block") }
        XCTAssertEqual(code, "let x = 1\nprint(x)")
    }

    func testInlineCodeSurvivesInsideAParagraph() {
        XCTAssertEqual(plain(blocks("call `foo()` first").first), "call foo() first")
    }

    func testHeadingsKeepTheirLevel() {
        let result = blocks("# Big\n\n### Small")
        guard case .heading(let first, _) = result[0],
              case .heading(let second, _) = result[1] else { return XCTFail("expected headings") }
        XCTAssertEqual(first, 1)
        XCTAssertEqual(second, 3)
    }

    func testBulletsBecomeListItemsWithMarkers() {
        let result = blocks("- one\n- two")
        XCTAssertEqual(result.count, 2)
        guard case .listItem(_, let marker, _) = result[0] else { return XCTFail("expected items") }
        XCTAssertEqual(marker, "•")
        XCTAssertEqual(plain(result[1]), "two")
    }

    func testOrderedListsNumberFromOne() {
        let result = blocks("1. first\n1. second")
        guard case .listItem(_, let a, _) = result[0],
              case .listItem(_, let b, _) = result[1] else { return XCTFail("expected items") }
        XCTAssertEqual([a, b], ["1.", "2."])
    }

    func testNestedListsAreIndented() {
        let result = blocks("- outer\n    - inner")
        let depths: [Int] = result.compactMap {
            if case .listItem(let depth, _, _) = $0 { return depth } else { return nil }
        }
        XCTAssertEqual(depths.count, 2)
        XCTAssertLessThan(depths[0], depths[1])
    }

    func testQuotesAndRules() {
        let result = blocks("> quoted\n\n---")
        guard case .quote = result[0] else { return XCTFail("expected a quote") }
        guard case .rule = result[1] else { return XCTFail("expected a rule") }
    }

    /// Nothing a reviewer writes may disappear, including constructs this renderer has no
    /// case for.
    func testUnhandledMarkupDegradesToTextRatherThanVanishing() {
        let result = blocks("| a | b |\n| - | - |\n| 1 | 2 |")
        XCTAssertFalse(result.isEmpty, "a table produced no blocks at all")
        XCTAssertTrue(result.contains { plain($0).contains("a") })
    }

    func testLinkTextIsKept() {
        XCTAssertEqual(plain(blocks("see [the docs](https://example.com)").first),
                       "see the docs")
    }
}
