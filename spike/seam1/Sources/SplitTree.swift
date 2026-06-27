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

extension SplitNode {
    mutating func split(paneID: String, axis: SplitAxis, newPane: Pane) -> Bool {
        switch self {
        case .leaf(let p) where p.paneID == paneID:
            self = .split(axis: axis, ratio: 0.5, first: .leaf(p), second: .leaf(newPane))
            return true
        case .leaf:
            return false
        case .split(let a, let r, var first, var second):
            if first.split(paneID: paneID, axis: axis, newPane: newPane) {
                self = .split(axis: a, ratio: r, first: first, second: second); return true
            }
            if second.split(paneID: paneID, axis: axis, newPane: newPane) {
                self = .split(axis: a, ratio: r, first: first, second: second); return true
            }
            return false
        }
    }

    mutating func updatePane(_ id: String, _ transform: (inout Pane) -> Void) -> Bool {
        switch self {
        case .leaf(var p) where p.paneID == id:
            transform(&p); self = .leaf(p); return true
        case .leaf:
            return false
        case .split(let a, let r, var first, var second):
            if first.updatePane(id, transform) {
                self = .split(axis: a, ratio: r, first: first, second: second); return true
            }
            if second.updatePane(id, transform) {
                self = .split(axis: a, ratio: r, first: first, second: second); return true
            }
            return false
        }
    }

    /// Returns the tree with `paneID` removed; parent split collapses to its sibling.
    /// `nil` means `paneID` was the only leaf — caller should close the tab.
    func closing(paneID: String) -> SplitNode? {
        switch self {
        case .leaf(let p):
            return p.paneID == paneID ? nil : self
        case .split(let axis, let ratio, let first, let second):
            if first.leafIDs.contains(paneID) {
                guard let f = first.closing(paneID: paneID) else { return second }
                return .split(axis: axis, ratio: ratio, first: f, second: second)
            }
            if second.leafIDs.contains(paneID) {
                guard let s = second.closing(paneID: paneID) else { return first }
                return .split(axis: axis, ratio: ratio, first: first, second: s)
            }
            return self
        }
    }
}
