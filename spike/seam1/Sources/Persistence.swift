import Foundation

/// On-disk tab: structure + userTitle only. Live state never persists (Pane.Codable
/// drops paneID/state/OSC title). Identical shape to the legacy `shepherd.tabs.v2`
/// element, so old installs still decode for migration.
struct PersistedTab: Codable {
    var userTitle: String?
    var root: SplitNode
}

struct PersistedWorkspace: Codable {
    var userTitle: String?
    var selectedTabIndex: Int      // selection by position — tab ids regenerate on restore
    var tabs: [PersistedTab]
}

struct PersistedState: Codable {
    var workspaces: [PersistedWorkspace]
    var selectedWorkspaceIndex: Int
}

/// Snapshot live workspaces → on-disk form. Selection is captured by index because
/// tab/workspace ids are regenerated on the next launch.
func snapshotState(_ workspaces: [Workspace], selectedWorkspaceID: String?) -> PersistedState {
    let selWs = workspaces.firstIndex { $0.id == selectedWorkspaceID } ?? 0
    let pws = workspaces.map { ws -> PersistedWorkspace in
        let selTab = ws.tabs.firstIndex { $0.tabID == ws.selectedTabID } ?? 0
        return PersistedWorkspace(
            userTitle: ws.userTitle,
            selectedTabIndex: selTab,
            tabs: ws.tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) })
    }
    return PersistedState(workspaces: pws, selectedWorkspaceIndex: selWs)
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
        guard !tabs.isEmpty else { return nil }
        let selID = tabs.indices.contains(pw.selectedTabIndex)
            ? tabs[pw.selectedTabIndex].tabID
            : tabs.first?.tabID
        return Workspace(userTitle: pw.userTitle, tabs: tabs, selectedTabID: selID)
    }
}

/// Wrap legacy v2 tabs data (`[PersistedTab]`) into a single default workspace.
/// nil if the data is absent/empty/undecodable.
func migrateLegacyTabs(_ data: Data) -> PersistedState? {
    guard let legacy = try? JSONDecoder().decode([PersistedTab].self, from: data),
          !legacy.isEmpty else { return nil }
    return PersistedState(
        workspaces: [PersistedWorkspace(userTitle: nil, selectedTabIndex: 0, tabs: legacy)],
        selectedWorkspaceIndex: 0)
}
