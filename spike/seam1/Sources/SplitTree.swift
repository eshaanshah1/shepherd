import Foundation
import CoreGraphics

/// One terminal pane = one libghostty surface = the agent unit. The PTY env var
/// is still literally `SHEPHERD_TAB_ID` (plugin compat); its value is this paneID.
struct Pane: Identifiable, Equatable {
    let paneID: String
    var title: String = ""        // OSC title the program sets
    var userTitle: String? = nil  // user-set name; overrides the OSC title
    var cwd: String? = nil        // last-known working dir
    var state: AgentState = .shell
    var reason: String? = nil
    var id: String { paneID }

    init(paneID: String = UUID().uuidString) { self.paneID = paneID }

    var displayTitle: String {
        if let u = userTitle, !u.isEmpty { return u }
        if state != .shell, !title.isEmpty { return title }
        return cwdName ?? "Terminal"
    }

    private var cwdName: String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        let home = NSHomeDirectory()
        if cwd == home { return "~" }
        let ns = cwd as NSString
        let last = ns.lastPathComponent
        let parent = ns.deletingLastPathComponent
        if parent == home { return "~/\(last)" }
        let parentName = (parent as NSString).lastPathComponent
        return (parentName.isEmpty || parentName == "/") ? last : "\(parentName)/\(last)"
    }
}

enum SplitAxis: String, Codable {
    case row     // ⌘D  — panes side-by-side, vertical divider, HStack
    case column  // ⌘⇧D — panes stacked, horizontal divider, VStack
}

enum FocusDirection { case left, right, up, down }

/// A tab's layout: a binary tree whose leaves are panes.
indirect enum SplitNode {
    case leaf(Pane)
    case split(axis: SplitAxis, ratio: Double, first: SplitNode, second: SplitNode)

    var leafIDs: [String] {
        switch self {
        case .leaf(let p): return [p.paneID]
        case .split(_, _, let a, let b): return a.leafIDs + b.leafIDs
        }
    }

    var panes: [Pane] {
        switch self {
        case .leaf(let p): return [p]
        case .split(_, _, let a, let b): return a.panes + b.panes
        }
    }

    var firstLeafID: String? { leafIDs.first }

    func pane(_ id: String) -> Pane? { panes.first { $0.paneID == id } }
}
