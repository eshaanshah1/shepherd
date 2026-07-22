import Foundation
import CoreGraphics

/// One terminal pane = one libghostty surface = the agent unit. The PTY env var
/// is still literally `SHEPHERD_TAB_ID` (plugin compat); its value is this paneID.
/// Marks a pane as a MIRROR of a pane living on another Mac ("host"). Its surface runs
/// `shepherdd attach <host> <remotePaneID>` instead of a local shell, and structural
/// actions on it route to the host as `cmd*`. `nil` = an ordinary local pane. Never
/// persisted — a restored mirror re-attaches (M3).
struct RemoteRef: Equatable {
    let hostID: String
    let remotePaneID: String
    var conn: RemoteConnState = .live
}

/// A tab whose worktree is being torn down: the row + its content pane show a dim,
/// non-interactive "stowing" state until the git op finishes. `.archiving` keeps the
/// work (neutral); `.discarding` destroys it (red). Transient, never persisted.
enum StowKind: Equatable { case archiving, discarding }

struct Pane: Identifiable, Equatable {
    let paneID: String
    var title: String = ""        // OSC title the program sets
    var userTitle: String? = nil  // user-set name; overrides the OSC title
    var cwd: String? = nil        // last-known working dir
    var state: AgentState = .shell
    var reason: String? = nil
    var sessionID: String? = nil  // live Claude session id — persisted to resume the agent on relaunch
    var provisioning: Bool = false // worktree being created: show a loading view, don't mount the PTY (transient, never persisted)
    var stowing: StowKind? = nil  // worktree being archived/discarded: dim + lock the pane while git runs (transient, never persisted)
    var remote: RemoteRef? = nil  // non-nil ⇒ this pane mirrors a host pane (M2); never persisted
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

    /// Navigate `path` (0 = first, 1 = second) to a `.split` node and set its
    /// ratio, clamped to [0.1, 0.9] so a pane can't collapse to nothing. Empty
    /// path targets the receiver. No-op if the path doesn't land on a split.
    mutating func setRatio(at path: [Int], to ratio: Double) {
        guard case .split(let axis, let r, var first, var second) = self else { return }
        if path.isEmpty {
            self = .split(axis: axis, ratio: min(0.9, max(0.1, ratio)), first: first, second: second)
            return
        }
        switch path[0] {
        case 0: first.setRatio(at: Array(path.dropFirst()), to: ratio)
        case 1: second.setRatio(at: Array(path.dropFirst()), to: ratio)
        default: return
        }
        self = .split(axis: axis, ratio: r, first: first, second: second)
    }

    func frames(in rect: CGRect) -> [String: CGRect] {
        switch self {
        case .leaf(let p):
            return [p.paneID: rect]
        case .split(let axis, let ratio, let first, let second):
            let (r1, r2): (CGRect, CGRect)
            switch axis {
            case .row:
                let w = rect.width * ratio
                r1 = CGRect(x: rect.minX, y: rect.minY, width: w, height: rect.height)
                r2 = CGRect(x: rect.minX + w, y: rect.minY, width: rect.width - w, height: rect.height)
            case .column:
                let h = rect.height * ratio
                r1 = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: h)
                r2 = CGRect(x: rect.minX, y: rect.minY + h, width: rect.width, height: rect.height - h)
            }
            return first.frames(in: r1).merging(second.frames(in: r2)) { a, _ in a }
        }
    }

    /// One draggable divider: the split's `path` from root, its `axis`/`ratio`,
    /// the boundary strip `rect` on the split line, and `span` (the split rect's
    /// extent along the axis — what PaneDivider's drag math divides by).
    struct SplitDivider {
        let path: [Int]
        let axis: SplitAxis
        let ratio: Double
        let rect: CGRect
        let span: CGFloat
        var key: String { path.map(String.init).joined(separator: ".") }
    }

    /// Flat list of every `.split` node's divider, geometry resolved against `rect`
    /// with the same split math as `frames`. Used to overlay dividers in the flat
    /// render. A leaf has none.
    func dividers(in rect: CGRect, path: [Int] = []) -> [SplitDivider] {
        guard case .split(let axis, let ratio, let first, let second) = self else { return [] }
        let (r1, r2): (CGRect, CGRect)
        let boundary: CGRect
        switch axis {
        case .row:
            let w = rect.width * ratio
            r1 = CGRect(x: rect.minX, y: rect.minY, width: w, height: rect.height)
            r2 = CGRect(x: rect.minX + w, y: rect.minY, width: rect.width - w, height: rect.height)
            boundary = CGRect(x: rect.minX + w, y: rect.minY, width: 0, height: rect.height)
        case .column:
            let h = rect.height * ratio
            r1 = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: h)
            r2 = CGRect(x: rect.minX, y: rect.minY + h, width: rect.width, height: rect.height - h)
            boundary = CGRect(x: rect.minX, y: rect.minY + h, width: rect.width, height: 0)
        }
        let span: CGFloat = axis == .row ? rect.width : rect.height
        let here = SplitDivider(path: path, axis: axis, ratio: ratio, rect: boundary, span: span)
        return [here]
            + first.dividers(in: r1, path: path + [0])
            + second.dividers(in: r2, path: path + [1])
    }

    func neighbor(of paneID: String, _ dir: FocusDirection, in rect: CGRect) -> String? {
        let f = frames(in: rect)
        guard let src = f[paneID] else { return nil }
        let from = CGPoint(x: src.midX, y: src.midY)
        var best: (id: String, dist: CGFloat)?
        for (id, r) in f where id != paneID {
            let to = CGPoint(x: r.midX, y: r.midY)
            let dx = to.x - from.x, dy = to.y - from.y
            let inDir: Bool
            switch dir {
            case .left:  inDir = dx < 0 && abs(dx) >= abs(dy)
            case .right: inDir = dx > 0 && abs(dx) >= abs(dy)
            case .up:    inDir = dy < 0 && abs(dy) >= abs(dx)
            case .down:  inDir = dy > 0 && abs(dy) >= abs(dx)
            }
            guard inDir else { continue }
            let d = dx*dx + dy*dy
            if best == nil || d < best!.dist { best = (id, d) }
        }
        return best?.id
    }

    /// The pane to focus after closing `paneID`: the first leaf of its sibling
    /// subtree (the immediate split it lives under collapses to that sibling).
    /// nil if `paneID` is the root leaf (no sibling) or isn't present.
    func siblingLeaf(of paneID: String) -> String? {
        guard case .split(_, _, let first, let second) = self else { return nil }
        if case .leaf(let p) = first,  p.paneID == paneID { return second.firstLeafID }
        if case .leaf(let p) = second, p.paneID == paneID { return first.firstLeafID }
        return first.siblingLeaf(of: paneID) ?? second.siblingLeaf(of: paneID)
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

// Persists structure + `userTitle`/`cwd` + `sessionID` (to resume the agent); live state
// (paneID, run state, OSC title) never survives a restart — a restored pane is a fresh shell,
// or, if it had a live Claude session, one that resumes that session on first input.
extension Pane: Codable {
    enum CodingKeys: String, CodingKey { case userTitle, cwd, sessionID }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(paneID: UUID().uuidString)
        userTitle = try c.decodeIfPresent(String.self, forKey: .userTitle)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(userTitle, forKey: .userTitle)
        try c.encodeIfPresent(cwd, forKey: .cwd)
        try c.encodeIfPresent(sessionID, forKey: .sessionID)
    }
}

extension SplitNode: Codable {
    enum CodingKeys: String, CodingKey { case kind, pane, axis, ratio, first, second }
    private enum Kind: String, Codable { case leaf, split }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .kind) {
        case .leaf:
            self = .leaf(try c.decode(Pane.self, forKey: .pane))
        case .split:
            self = .split(axis: try c.decode(SplitAxis.self, forKey: .axis),
                          ratio: try c.decode(Double.self, forKey: .ratio),
                          first: try c.decode(SplitNode.self, forKey: .first),
                          second: try c.decode(SplitNode.self, forKey: .second))
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .leaf(let p):
            try c.encode(Kind.leaf, forKey: .kind); try c.encode(p, forKey: .pane)
        case .split(let axis, let ratio, let first, let second):
            try c.encode(Kind.split, forKey: .kind)
            try c.encode(axis, forKey: .axis); try c.encode(ratio, forKey: .ratio)
            try c.encode(first, forKey: .first); try c.encode(second, forKey: .second)
        }
    }
}

/// Convert one tab's `SplitNode` tree into a wire `RemoteNode` (protocol v2). The
/// caller supplies a projection mapping each live `Pane` to its `RemotePane`, since
/// title/state/reason live on the store and `Pane.Codable` omits them. Bridges the
/// split-tree model to the wire; both types are pure, so this stays AppKit-free.
func buildRemoteNode(_ node: SplitNode, projection: (Pane) -> RemotePane) -> RemoteNode {
    switch node {
    case .leaf(let p): return .leaf(projection(p))
    case .split(let axis, let ratio, let first, let second):
        return .split(axis: axis.rawValue, ratio: ratio,
                      first: buildRemoteNode(first, projection: projection),
                      second: buildRemoteNode(second, projection: projection))
    }
}

/// Inverse of `buildRemoteNode` (M2 client side): rebuild a local `SplitNode` from a wire
/// `RemoteNode`, marking each leaf as a mirror. The mirror pane REUSES the host's paneID
/// (UUIDs are globally unique, so no local collision) — that keeps `state`/`focused`/`zoom`
/// routing by-id trivial and lets `RemoteRef.remotePaneID == paneID`.
func buildMirrorNode(_ node: RemoteNode, hostID: String) -> SplitNode {
    switch node {
    case .leaf(let rp):
        var p = Pane(paneID: rp.paneID)
        p.title = rp.title
        p.cwd = rp.cwd
        p.state = AgentState(rawValue: rp.state) ?? .shell
        p.reason = rp.reason
        p.remote = RemoteRef(hostID: hostID, remotePaneID: rp.paneID, conn: .live)
        return .leaf(p)
    case .split(let axis, let ratio, let first, let second):
        return .split(axis: SplitAxis(rawValue: axis) ?? .row, ratio: ratio,
                      first: buildMirrorNode(first, hostID: hostID),
                      second: buildMirrorNode(second, hostID: hostID))
    }
}
