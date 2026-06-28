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

    func testSiblingLeaf() {
        let t = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "1")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "2")),
                second: .leaf(Pane(paneID: "3"))))
        XCTAssertEqual(t.siblingLeaf(of: "3"), "2")        // immediate sibling leaf
        XCTAssertEqual(t.siblingLeaf(of: "2"), "3")        // immediate sibling leaf
        XCTAssertEqual(t.siblingLeaf(of: "1"), "2")        // sibling subtree's firstLeafID
        XCTAssertNil(SplitNode.leaf(Pane(paneID: "x")).siblingLeaf(of: "x"))  // root leaf, no sibling
        XCTAssertNil(t.siblingLeaf(of: "nope"))            // absent
    }

    func testUpdatePane() {
        var tree = SplitNode.split(axis: .column, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        XCTAssertTrue(tree.updatePane("b") { $0.state = .working })
        XCTAssertEqual(tree.pane("b")?.state, .working)
    }

    func testDividersSingleRowSplit() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let ds = tree.dividers(in: CGRect(x: 0, y: 0, width: 100, height: 40))
        XCTAssertEqual(ds.count, 1)
        let d = ds[0]
        XCTAssertEqual(d.path, [])
        XCTAssertEqual(d.axis, .row)
        XCTAssertEqual(d.ratio, 0.5)
        XCTAssertEqual(d.span, 100)
        XCTAssertEqual(d.rect.midX, 50, accuracy: 0.001)   // boundary at x=50
        XCTAssertEqual(d.rect.height, 40, accuracy: 0.001) // full split height
    }

    func testDividersLeafHasNone() {
        let tree = SplitNode.leaf(Pane(paneID: "a"))
        XCTAssertTrue(tree.dividers(in: CGRect(x: 0, y: 0, width: 100, height: 40)).isEmpty)
    }

    func testDividersNested() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "b")),
                second: .leaf(Pane(paneID: "c"))))
        let ds = tree.dividers(in: CGRect(x: 0, y: 0, width: 100, height: 40))
        XCTAssertEqual(ds.count, 2)
        let outer = ds.first { $0.path == [] }
        let inner = ds.first { $0.path == [1] }
        XCTAssertNotNil(outer); XCTAssertNotNil(inner)
        XCTAssertEqual(outer!.axis, .row)
        XCTAssertEqual(outer!.span, 100)
        XCTAssertEqual(outer!.rect.midX, 50, accuracy: 0.001)
        // Inner column split lives in the right half (x 50..100, full height 40).
        XCTAssertEqual(inner!.axis, .column)
        XCTAssertEqual(inner!.span, 40)               // splitRect.height of the inner sub-rect
        XCTAssertEqual(inner!.rect.midY, 20, accuracy: 0.001) // boundary at y=20
        XCTAssertEqual(inner!.rect.width, 50, accuracy: 0.001) // spans the right half
    }

    func testDividersAsymmetricRatio() {
        let tree = SplitNode.split(axis: .row, ratio: 0.3,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        let ds = tree.dividers(in: CGRect(x: 0, y: 0, width: 100, height: 40))
        XCTAssertEqual(ds[0].rect.midX, 30, accuracy: 0.001) // boundary at 30%
        XCTAssertEqual(ds[0].ratio, 0.3)
    }

    func testDividerKeysAreStableAndUnique() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "b")),
                second: .leaf(Pane(paneID: "c"))))
        let rect = CGRect(x: 0, y: 0, width: 100, height: 40)
        let keys = tree.dividers(in: rect).map { $0.key }
        XCTAssertEqual(Set(keys).count, keys.count)      // unique
        XCTAssertEqual(keys, tree.dividers(in: rect).map { $0.key }) // stable across calls
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

    func testSetRatioEmptyPathTargetsReceiver() {
        var tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        tree.setRatio(at: [], to: 0.7)
        if case .split(_, let r, _, _) = tree { XCTAssertEqual(r, 0.7) }
        else { XCTFail("expected split") }
    }

    func testSetRatioNavigatesToNestedSplit() {
        var tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "b")),
                second: .leaf(Pane(paneID: "c"))))
        tree.setRatio(at: [1], to: 0.25)
        guard case .split(_, let outer, _, let second) = tree else { return XCTFail("expected outer split") }
        XCTAssertEqual(outer, 0.5)   // outer unchanged
        if case .split(_, let inner, _, _) = second { XCTAssertEqual(inner, 0.25) }
        else { XCTFail("expected nested split") }
    }

    func testSetRatioClamps() {
        var low = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        low.setRatio(at: [], to: 0.02)
        if case .split(_, let r, _, _) = low { XCTAssertEqual(r, 0.1) } else { XCTFail() }

        var high = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
        high.setRatio(at: [], to: 0.98)
        if case .split(_, let r, _, _) = high { XCTAssertEqual(r, 0.9) } else { XCTFail() }
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
