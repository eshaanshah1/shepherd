import Foundation

/// One workspace owns an independent set of tabs (each a pane tree) plus which
/// tab is selected. A Workspace is to a Tab what a Tab is to its pane tree.
struct Workspace: Identifiable {
    let id: String
    var userTitle: String?
    var tabs: [Tab]
    var selectedTabID: String?
    var collapsed: Bool = false   // accordion folder state (persisted, default expanded)
    var defaultPath: String? = nil   // new tabs in this workspace open here (tilde allowed); nil = shell default
    var worktreeHook: String? = nil  // bash run right after this workspace's worktrees are created; nil = none
    // Non-nil ⇒ this is a MIRROR of a workspace on another Mac (M2). `remoteHostID` keys the
    // RemoteClient; `remoteWorkspaceID` is the host's workspace id sent back in cmd*.
    var remoteHostID: String? = nil
    var remoteWorkspaceID: String? = nil
    var isRemote: Bool { remoteHostID != nil }

    init(id: String = UUID().uuidString, userTitle: String? = nil,
         tabs: [Tab], selectedTabID: String? = nil, collapsed: Bool = false,
         defaultPath: String? = nil, worktreeHook: String? = nil,
         remoteHostID: String? = nil, remoteWorkspaceID: String? = nil) {
        self.id = id
        self.userTitle = userTitle
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.tabID
        self.collapsed = collapsed
        self.defaultPath = defaultPath
        self.worktreeHook = worktreeHook
        self.remoteHostID = remoteHostID
        self.remoteWorkspaceID = remoteWorkspaceID
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

/// Deterministic local id for a mirror workspace, so re-broadcasts upsert the same one.
func mirrorWorkspaceID(hostID: String, remoteWorkspaceID: String) -> String {
    "remote:\(hostID):\(remoteWorkspaceID)"
}

/// Build a mirror `Workspace` from a wire `WorkspaceTree` (M2 client side). Reuses the
/// host's tab/pane ids; the local workspace id is deterministic (`mirrorWorkspaceID`) so a
/// later re-broadcast replaces it in place. The name mirrors the host's (carried on the wire).
func buildMirrorWorkspace(_ tree: WorkspaceTree, hostID: String) -> Workspace {
    let tabs = tree.tabs.map { rt in
        Tab(tabID: rt.tabID,
            root: buildMirrorNode(rt.root, hostID: hostID),
            focusedPaneID: rt.focusedPaneID,
            zoomedPaneID: rt.zoomedPaneID)
    }
    return Workspace(id: mirrorWorkspaceID(hostID: hostID, remoteWorkspaceID: tree.workspaceID),
                     userTitle: tree.name,
                     tabs: tabs,
                     selectedTabID: tree.selectedTabID,
                     defaultPath: tree.defaultPath,
                     remoteHostID: hostID,
                     remoteWorkspaceID: tree.workspaceID)
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
