import Foundation

/// One workspace owns an independent set of tabs (each a pane tree) plus which
/// tab is selected. A Workspace is to a Tab what a Tab is to its pane tree.
struct Workspace: Identifiable {
    let id: String
    var userTitle: String?
    var tabs: [Tab]
    var selectedTabID: String?

    init(id: String = UUID().uuidString, userTitle: String? = nil,
         tabs: [Tab], selectedTabID: String? = nil) {
        self.id = id
        self.userTitle = userTitle
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.tabID
    }

    /// Index-based default name; an explicit rename (userTitle) wins.
    func displayName(index: Int) -> String {
        userTitle?.isEmpty == false ? userTitle! : "Workspace \(index + 1)"
    }

    /// Rolled-up attention state across every pane — the switcher's dot.
    var aggregateState: AgentState {
        AgentState.rollUp(tabs.flatMap { $0.root.panes }.map(\.state))
    }

    /// Drop in a fresh tab if the workspace was emptied — a workspace is never empty.
    mutating func reseedIfEmpty() {
        guard tabs.isEmpty else { return }
        let t = Tab(pane: Pane())
        tabs = [t]
        selectedTabID = t.tabID
    }
}

/// Find the (workspace, tab) indices owning a pane, across ALL workspaces.
/// Correlation is by pane id — the socket knows nothing about workspaces.
func locatePane(_ paneID: String, in workspaces: [Workspace]) -> (ws: Int, tab: Int)? {
    for (w, ws) in workspaces.enumerated() {
        if let t = ws.tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }) {
            return (w, t)
        }
    }
    return nil
}

/// Remove the workspace with `id`; nil if it's the last one (caller must refuse).
func removingWorkspace(_ id: String, from workspaces: [Workspace]) -> [Workspace]? {
    guard workspaces.count > 1 else { return nil }
    return workspaces.filter { $0.id != id }
}

/// Count panes that want attention across every workspace (dock-badge source).
func totalAttentionCount(in workspaces: [Workspace]) -> Int {
    workspaces.flatMap { $0.tabs }.flatMap { $0.root.panes }
        .filter { $0.state.wantsAttention }.count
}

/// True if any pane in any workspace is busy (working/blocked/needsCheck/error) —
/// the "keep the Mac awake" trigger for `.whileAgents`.
func anyAgentBusy(in workspaces: [Workspace]) -> Bool {
    workspaces.flatMap { $0.tabs }.flatMap { $0.root.panes }.contains { $0.state.isBusy }
}
