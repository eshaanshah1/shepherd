import XCTest

final class SplitTreeTests: XCTestCase {
    func testLeafIDsAndLookup() {
        let p = Pane(paneID: "a")
        let tree = SplitNode.leaf(p)
        XCTAssertEqual(tree.leafIDs, ["a"])
        XCTAssertEqual(tree.firstLeafID, "a")
        XCTAssertEqual(tree.pane("a")?.paneID, "a")
        XCTAssertNil(tree.pane("nope"))
    }

    func testNestedLeafOrder() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "b")),
                second: .leaf(Pane(paneID: "c"))))
        XCTAssertEqual(tree.leafIDs, ["a", "b", "c"])
    }
}
