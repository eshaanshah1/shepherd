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

    func testSplitReplacesLeaf() {
        var tree = SplitNode.leaf(Pane(paneID: "a"))
        XCTAssertTrue(tree.split(paneID: "a", axis: .row, newPane: Pane(paneID: "b")))
        XCTAssertEqual(tree.leafIDs, ["a", "b"])
        if case .split(let axis, let ratio, _, _) = tree {
            XCTAssertEqual(axis, .row); XCTAssertEqual(ratio, 0.5)
        } else { XCTFail("expected split") }
    }

    func testSplitUnknownPaneReturnsFalse() {
        var tree = SplitNode.leaf(Pane(paneID: "a"))
        XCTAssertFalse(tree.split(paneID: "zzz", axis: .row, newPane: Pane(paneID: "b")))
        XCTAssertEqual(tree.leafIDs, ["a"])
    }

    func testFramesRowSplit() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let f = tree.frames(in: CGRect(x: 0, y: 0, width: 100, height: 40))
        XCTAssertEqual(f["a"], CGRect(x: 0, y: 0, width: 50, height: 40))
        XCTAssertEqual(f["b"], CGRect(x: 50, y: 0, width: 50, height: 40))
    }

    func testNeighborRight() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let rect = CGRect(x: 0, y: 0, width: 100, height: 40)
        XCTAssertEqual(tree.neighbor(of: "a", .right, in: rect), "b")
        XCTAssertNil(tree.neighbor(of: "a", .left, in: rect))
    }

    func testCloseCollapsesParentToSibling() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let after = tree.closing(paneID: "a")
        XCTAssertEqual(after?.leafIDs, ["b"])
        if case .leaf = after { } else { XCTFail("sibling should hoist to a leaf") }
    }

    func testCloseOnlyLeafReturnsNil() {
        let tree = SplitNode.leaf(Pane(paneID: "a"))
        XCTAssertNil(tree.closing(paneID: "a"))
    }

    func testUpdatePane() {
        var tree = SplitNode.split(axis: .column, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        XCTAssertTrue(tree.updatePane("b") { $0.state = .working })
        XCTAssertEqual(tree.pane("b")?.state, .working)
    }

    func testFramesColumnSplit() {
        let tree = SplitNode.split(axis: .column, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let f = tree.frames(in: CGRect(x: 0, y: 0, width: 40, height: 100))
        XCTAssertEqual(f["a"], CGRect(x: 0, y: 0, width: 40, height: 50))
        XCTAssertEqual(f["b"], CGRect(x: 0, y: 50, width: 40, height: 50))
    }

    func testNeighborUpDown() {
        let tree = SplitNode.split(axis: .column, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let rect = CGRect(x: 0, y: 0, width: 40, height: 100)
        XCTAssertEqual(tree.neighbor(of: "a", .down, in: rect), "b")
        XCTAssertNil(tree.neighbor(of: "a", .up, in: rect))
        XCTAssertEqual(tree.neighbor(of: "b", .up, in: rect), "a")
    }

    func testCodableRoundTripKeepsStructureDropsLiveState() throws {
        var tree = SplitNode.split(axis: .row, ratio: 0.3,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        _ = tree.updatePane("a") { $0.userTitle = "left"; $0.cwd = "/tmp"; $0.state = .working }
        let data = try JSONEncoder().encode(tree)
        let back = try JSONDecoder().decode(SplitNode.self, from: data)
        XCTAssertEqual(back.leafIDs.count, 2)                  // structure preserved
        let restored = back.panes.first { $0.userTitle == "left" }
        XCTAssertEqual(restored?.cwd, "/tmp")                  // persisted fields survive
        XCTAssertEqual(restored?.state, .shell)               // live state dropped
        XCTAssertNotEqual(restored?.paneID, "a")              // fresh id
        if case .split(_, let r, _, _) = back { XCTAssertEqual(r, 0.3) }
    }
}
