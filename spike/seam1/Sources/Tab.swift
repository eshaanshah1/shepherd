import Foundation

/// One tab owns a tree of panes (`root`). For an unsplit tab the tree is a
/// single leaf; the tab then behaves exactly like the old `Agent`.
struct Tab: Identifiable {
    let tabID: String
    var userTitle: String?
    var root: SplitNode
    var focusedPaneID: String
    var zoomedPaneID: String? = nil
    var collapsed: Bool

    var id: String { tabID }
    var paneIDs: [String] { root.leafIDs }
    var isSplit: Bool { paneIDs.count > 1 }
    func focusedPane() -> Pane? { root.pane(focusedPaneID) }

    init(tabID: String = UUID().uuidString, pane: Pane, collapsedDefault: Bool) {
        self.tabID = tabID
        self.root = .leaf(pane)
        self.focusedPaneID = pane.paneID
        self.collapsed = collapsedDefault
    }

    /// Most-urgent pane state for the collapsed/aggregate dot (nil if nothing notable).
    func attentionState() -> AgentState? {
        let order: [AgentState] = [.blocked, .error, .needsCheck, .working]
        for s in order where root.panes.contains(where: { $0.state == s }) { return s }
        return nil
    }

    /// Title shown when the tab is unsplit (mirrors the old Agent.displayTitle):
    /// rename → focused pane's displayTitle.
    var displayTitle: String { userTitle?.isEmpty == false ? userTitle! : (focusedPane()?.displayTitle ?? "Terminal") }

    var collapsedStripPanes: [Pane] { root.panes }   // order = leaf order = pane numbers 1..n
}
