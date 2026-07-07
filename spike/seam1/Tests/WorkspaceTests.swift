import XCTest

final class WorkspaceTests: XCTestCase {
    /// Build a one-tab workspace whose panes carry the given states (extra states
    /// add panes via splits).
    private func ws(_ paneStates: [AgentState] = [.shell], userTitle: String? = nil) -> Workspace {
        var first = Pane(paneID: UUID().uuidString)
        first.state = paneStates.first ?? .shell
        var tab = Tab(pane: first)
        for s in paneStates.dropFirst() {
            var np = Pane(paneID: UUID().uuidString); np.state = s
            _ = tab.root.split(paneID: tab.root.firstLeafID!, axis: .row, newPane: np)
        }
        return Workspace(userTitle: userTitle, tabs: [tab])
    }

    func testBuildMirrorWorkspaceFromTree() {
        let tree = WorkspaceTree(
            workspaceID: "hw1", name: "HostWS",
            tabs: [RemoteTab(tabID: "ht1",
                root: .split(axis: "column", ratio: 0.4,
                    first: .leaf(RemotePane(paneID: "hp1", title: "zsh", cwd: "/x", state: "shell", reason: nil)),
                    second: .leaf(RemotePane(paneID: "hp2", title: "claude", cwd: "/y", state: "need-to-check", reason: "done"))),
                focusedPaneID: "hp2", zoomedPaneID: nil)],
            selectedTabID: "ht1")
        let w = buildMirrorWorkspace(tree, hostID: "MacA")

        XCTAssertTrue(w.isRemote)
        XCTAssertEqual(w.remoteHostID, "MacA")
        XCTAssertEqual(w.remoteWorkspaceID, "hw1")
        XCTAssertEqual(w.id, "remote:MacA:hw1")
        XCTAssertEqual(w.displayName(index: 3), "HostWS")   // name mirrors the host's
        XCTAssertEqual(w.tabs.count, 1)
        let tab = w.tabs[0]
        XCTAssertEqual(tab.tabID, "ht1")
        XCTAssertEqual(tab.focusedPaneID, "hp2")
        guard case let .split(axis, ratio, first, second) = tab.root else { return XCTFail("expected split") }
        XCTAssertEqual(axis, .column); XCTAssertEqual(ratio, 0.4)
        guard case let .leaf(p1) = first, case let .leaf(p2) = second else { return XCTFail() }
        XCTAssertEqual(p1.paneID, "hp1")                    // reuses the host paneID
        XCTAssertEqual(p1.remote, RemoteRef(hostID: "MacA", remotePaneID: "hp1", conn: .live))
        XCTAssertEqual(p2.state, .needsCheck)               // "need-to-check" mapped
        XCTAssertEqual(p2.reason, "done")
        XCTAssertEqual(p2.cwd, "/y")
    }

    func testDisplayNameDefaultAndRename() {
        XCTAssertEqual(ws().displayName(index: 0), "Workspace 1")
        XCTAssertEqual(ws().displayName(index: 4), "Workspace 5")
        XCTAssertEqual(ws(userTitle: "Build").displayName(index: 0), "Build")
    }

    func testReseedIfEmpty() {
        var w = ws()
        w.tabs.removeAll()
        w.reseedIfEmpty()
        XCTAssertEqual(w.tabs.count, 1)
        XCTAssertEqual(w.selectedTabID, w.tabs.first?.tabID)
    }

    func testReseedNoopWhenNonEmpty() {
        var w = ws()
        let before = w.tabs.first?.tabID
        w.reseedIfEmpty()
        XCTAssertEqual(w.tabs.count, 1)
        XCTAssertEqual(w.tabs.first?.tabID, before)
    }

    func testLocatePaneAcrossWorkspaces() {
        let a = ws(); let b = ws()
        let target = b.tabs[0].root.firstLeafID!
        let found = locatePane(target, in: [a, b])
        XCTAssertEqual(found?.ws, 1)
        XCTAssertEqual(found?.tab, 0)
        XCTAssertNil(locatePane("nope", in: [a, b]))
    }

    func testRemovingWorkspaceGuardsLastOne() {
        let a = ws(), b = ws()
        XCTAssertNil(removingWorkspace(a.id, from: [a]))                 // last one — refuse
        XCTAssertEqual(removingWorkspace(a.id, from: [a, b])?.count, 1)  // ok with 2+
    }

    func testTotalAttentionCountAcrossWorkspaces() {
        let a = ws([.working, .blocked])   // 1 wants attention
        let b = ws([.needsCheck])          // 1 wants attention
        let c = ws([.idle, .shell])        // 0
        XCTAssertEqual(totalAttentionCount(in: [a, b, c]), 2)
    }

    func testRollUpPriority() {
        XCTAssertEqual(AgentState.rollUp([.idle, .working, .blocked]), .blocked)
        XCTAssertEqual(AgentState.rollUp([.idle, .working, .error]), .error)
        XCTAssertEqual(AgentState.rollUp([.idle, .working]), .working)
        XCTAssertEqual(AgentState.rollUp([.shell, .shell]), .shell)
        XCTAssertEqual(AgentState.rollUp([]), .shell)
    }

    func testAggregateState() {
        XCTAssertEqual(ws([.working, .needsCheck]).aggregateState, .needsCheck)
        XCTAssertEqual(ws([.shell]).aggregateState, .shell)
    }

    func testIsBusy() {
        XCTAssertFalse(AgentState.shell.isBusy)
        XCTAssertFalse(AgentState.idle.isBusy)
        XCTAssertTrue(AgentState.working.isBusy)
        XCTAssertTrue(AgentState.blocked.isBusy)
        XCTAssertTrue(AgentState.needsCheck.isBusy)
        XCTAssertTrue(AgentState.error.isBusy)
    }

    func testTabIsShowing() {
        var tab = ws([.shell, .shell]).tabs[0]   // 2-pane split
        let ids = tab.paneIDs
        XCTAssertTrue(tab.isShowing(ids[0]))          // no zoom → all panes shown
        XCTAssertTrue(tab.isShowing(ids[1]))
        XCTAssertFalse(tab.isShowing("not-a-pane"))
        tab.zoomedPaneID = ids[0]                     // zoom → only the zoomed pane is shown
        XCTAssertTrue(tab.isShowing(ids[0]))
        XCTAssertFalse(tab.isShowing(ids[1]))
    }

    func testAnyAgentBusyAcrossWorkspaces() {
        XCTAssertFalse(anyAgentBusy(in: [ws([.shell]), ws([.idle, .idle])]))
        XCTAssertTrue(anyAgentBusy(in: [ws([.idle]), ws([.shell, .working])]))   // busy in a hidden ws
        XCTAssertTrue(anyAgentBusy(in: [ws([.needsCheck])]))
    }
}
