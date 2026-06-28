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
    func focusedPane() -> Pane? { root.pane(focusedPaneID) }

    init(tabID: String = UUID().uuidString, pane: Pane) {
        self.tabID = tabID
        self.root = .leaf(pane)
        self.focusedPaneID = pane.paneID
    }

    /// Title for an unsplit tab (mirrors the old Agent.displayTitle): rename →
    /// focused pane's displayTitle.
    var displayTitle: String { userTitle?.isEmpty == false ? userTitle! : (focusedPane()?.displayTitle ?? "Terminal") }
}
