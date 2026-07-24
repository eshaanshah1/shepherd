import Foundation

/// On-disk tab: structure + userTitle only. Live state never persists (Pane.Codable
/// drops paneID/state/OSC title). Identical shape to the legacy `shepherd.tabs.v2`
/// element, so old installs still decode for migration.
struct PersistedTab: Codable {
    var userTitle: String?
    var root: SplitNode
}

struct PersistedWorkspace: Codable {
    var id: String?                // stable across launches so worktree archives can find their folder; optional ⇒ old blobs decode (nil = regenerate)
    var userTitle: String?
    var selectedTabIndex: Int      // selection by position — tab ids regenerate on restore
    var tabs: [PersistedTab]
    var collapsed: Bool?           // optional so pre-accordion blobs still decode (nil = expanded)
    var defaultPath: String?       // optional so pre-feature blobs still decode (nil = none)
    var worktreeHook: String?      // optional so pre-feature blobs still decode (nil = none)
}

/// On-disk ephemeral pane: cwd + sessionID + userTitle only (like a tab, live
/// state never persists). Restored all-collapsed, .shell state, fresh id.
struct PersistedEphemeral: Codable {
    var userTitle: String?
    var cwd: String?
    var sessionID: String?
}

struct PersistedState: Codable {
    var workspaces: [PersistedWorkspace]
    var selectedWorkspaceIndex: Int
    var ephemeral: [PersistedEphemeral]?   // optional ⇒ pre-feature blobs decode as nil
}

/// Snapshot live workspaces → on-disk form. Selection is captured by index because
/// tab/workspace ids are regenerated on the next launch.
func snapshotState(_ workspaces: [Workspace], selectedWorkspaceID: String?,
                   ephemeral: [EphemeralPane] = []) -> PersistedState {
    let selWs = workspaces.firstIndex { $0.id == selectedWorkspaceID } ?? 0
    let pws = workspaces.map { ws -> PersistedWorkspace in
        let selTab = ws.tabs.firstIndex { $0.tabID == ws.selectedTabID } ?? 0
        return PersistedWorkspace(
            id: ws.id,
            userTitle: ws.userTitle,
            selectedTabIndex: selTab,
            tabs: ws.tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) },
            collapsed: ws.collapsed,
            defaultPath: ws.defaultPath,
            worktreeHook: ws.worktreeHook)
    }
    return PersistedState(workspaces: pws, selectedWorkspaceIndex: selWs,
                          ephemeral: snapshotEphemerals(ephemeral))
}

/// Live ephemeral panes → on-disk form (cwd + sessionID + userTitle).
func snapshotEphemerals(_ panes: [EphemeralPane]) -> [PersistedEphemeral] {
    panes.map { PersistedEphemeral(userTitle: $0.pane.userTitle, cwd: $0.pane.cwd,
                                   sessionID: $0.pane.sessionID) }
}

/// Rebuild ephemeral panes from on-disk form: fresh pane ids, .shell state, all
/// collapsed (PiP). A restored sessionID resumes via `claudeResumeInput` on mount.
func buildEphemerals(from persisted: [PersistedEphemeral]?) -> [EphemeralPane] {
    (persisted ?? []).map { pe in
        var p = Pane()
        p.userTitle = pe.userTitle
        p.cwd = pe.cwd
        p.sessionID = pe.sessionID
        return EphemeralPane(pane: p, collapsed: true)
    }
}

/// Rebuild live workspaces from on-disk form. Panes decode with fresh ids + .shell
/// state (Pane.Codable); selection is restored by index against the fresh tab ids.
func buildWorkspaces(from state: PersistedState) -> [Workspace] {
    state.workspaces.compactMap { pw -> Workspace? in
        let tabs: [Tab] = pw.tabs.compactMap { pt in
            guard let first = pt.root.firstLeafID else { return nil }
            var tab = Tab(pane: Pane())
            tab.userTitle = pt.userTitle
            tab.root = pt.root
            tab.focusedPaneID = first
            return tab
        }
        let selID = tabs.indices.contains(pw.selectedTabIndex)
            ? tabs[pw.selectedTabIndex].tabID
            : tabs.first?.tabID
        return Workspace(id: pw.id ?? UUID().uuidString, userTitle: pw.userTitle,
                         tabs: tabs, selectedTabID: selID,
                         collapsed: pw.collapsed ?? false, defaultPath: pw.defaultPath,
                         worktreeHook: pw.worktreeHook)
    }
}

/// The shell input that resumes a Claude session by id — typed into a restored pane's PTY
/// so the agent picks up where it left off (Claude keys sessions by id within the cwd, which
/// is itself restored). Session ids are UUIDs, so no shell-quoting is needed.
func claudeResumeInput(sessionID: String) -> String { "claude --resume \(sessionID)\n" }

/// Wrap legacy v2 tabs data (`[PersistedTab]`) into a single default workspace.
/// nil if the data is absent/empty/undecodable.
func migrateLegacyTabs(_ data: Data) -> PersistedState? {
    guard let legacy = try? JSONDecoder().decode([PersistedTab].self, from: data),
          !legacy.isEmpty else { return nil }
    return PersistedState(
        workspaces: [PersistedWorkspace(userTitle: nil, selectedTabIndex: 0, tabs: legacy)],
        selectedWorkspaceIndex: 0)
}
