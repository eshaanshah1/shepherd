import Foundation

/// One tab owns a tree of panes (`root`). For an unsplit tab the tree is a
/// single leaf; the tab then behaves exactly like the old `Agent`.
struct Tab: Identifiable {
    let tabID: String
    var userTitle: String?
    var root: SplitNode
    var focusedPaneID: String
    var zoomedPaneID: String? = nil

    var id: String { tabID }
    var paneIDs: [String] { root.leafIDs }
    var isSplit: Bool { paneIDs.count > 1 }
    /// Is this tab currently rendering `paneID`? True when the pane is in the tab and
    /// either nothing is zoomed or it's the zoomed pane (a zoom starves its siblings to
    /// 0×0). Used to resolve the phone-vs-desktop size tie in the desktop's favor.
    func isShowing(_ paneID: String) -> Bool {
        guard paneIDs.contains(paneID) else { return false }
        return zoomedPaneID == nil || zoomedPaneID == paneID
    }
    func focusedPane() -> Pane? { root.pane(focusedPaneID) }

    init(tabID: String = UUID().uuidString, pane: Pane) {
        self.tabID = tabID
        self.root = .leaf(pane)
        self.focusedPaneID = pane.paneID
    }

    /// Build a tab from a full pane tree — used to reconstruct a mirror tab (M2) and by
    /// persistence restore. `focusedPaneID` falls back to the first leaf if none given.
    init(tabID: String, root: SplitNode, focusedPaneID: String? = nil,
         zoomedPaneID: String? = nil, userTitle: String? = nil) {
        self.tabID = tabID
        self.root = root
        self.focusedPaneID = focusedPaneID ?? root.firstLeafID ?? ""
        self.zoomedPaneID = zoomedPaneID
        self.userTitle = userTitle
    }

    /// Title for an unsplit tab (mirrors the old Agent.displayTitle): rename →
    /// focused pane's displayTitle.
    var displayTitle: String { userTitle?.isEmpty == false ? userTitle! : (focusedPane()?.displayTitle ?? "Terminal") }
}
