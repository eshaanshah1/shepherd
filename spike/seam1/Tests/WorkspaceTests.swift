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
}
