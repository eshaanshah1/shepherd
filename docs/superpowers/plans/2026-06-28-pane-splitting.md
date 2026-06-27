# Pane Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add horizontal + vertical pane splitting where each pane is an independently-tracked agent, per [ADR 0012](../../../.claude/adr/0012-pane-splitting-panes-as-agents.md).

**Architecture:** A tab becomes a container of a recursive binary split tree (`SplitNode`) whose leaves are `Pane`s (the former `Agent` — one libghostty surface, one `SHEPHERD_TAB_ID`-valued pane id, one `AgentState`). The pure tree model is unit-tested; the AppKit/SwiftUI/libghostty layers (store, render, keybindings, sidebar, persistence) are verified by `xcodebuild` + manual run, which is this repo's ground truth (CLAUDE.md). The socket protocol and `report.sh` are unchanged — correlation is already per-surface.

**Tech Stack:** Swift 5 / SwiftUI / AppKit, libghostty (`GhosttyKit.xcframework`), xcodegen, XCTest (new model test target).

## Global Constraints

- **macOS deployment target 13.0**; build via the CLAUDE.md recipe (`xcodegen generate` after any file add/remove, then `xcodebuild … CODE_SIGNING_ALLOWED=NO`, ad-hoc codesign, `open`).
- **Run `xcodegen generate` after adding/removing any source file** (incl. the new test target/files) or it won't compile.
- **Do NOT rename the `SHEPHERD_TAB_ID` env var** — `claude-plugin/hooks/report.sh` reads it. Its *value* is a pane id; the name stays for plugin compat.
- **`report.sh` stays pure bash; the socket payload `{tab_id,event,detail}` is unchanged.** No plugin edits in this plan.
- **Keep all sidebar SwiftUI controls `.focusable(false)`** and hand first responder to the focused surface ([ADR 0009](../../../.claude/adr/0009-sidebar-custom-rows-not-list.md)). Splitting must not introduce a keyboard-focus sink.
- **UI colors come from `Theme.swift`**; reuse existing tokens, don't invent hexes ([ADR 0010](../../../.claude/adr/0010-terminal-theme-from-shepherd-config.md)).
- **SplitAxis vocabulary (avoid the iTerm confusion):** `.row` = panes side-by-side, **vertical** divider, SwiftUI `HStack`, bound to **⌘D**. `.column` = panes stacked, **horizontal** divider, `VStack`, bound to **⌘⇧D**.
- **Testing strategy:** TDD (XCTest) for the pure `SplitTree.swift` model only (Tasks 1–4). Every other task's "test" step is `xcodebuild` success + a scripted manual verification, because those layers depend on AppKit/Metal/libghostty and aren't meaningfully unit-testable here. This is deliberate, not a placeholder.

---

## File structure

| File | Responsibility |
|---|---|
| `Sources/SplitTree.swift` **(new)** | Pure model: `Pane`, `SplitAxis`, `SplitNode` (recursive tree + ops + Codable), `FocusDirection`. No AppKit/GhosttyKit. |
| `Sources/Tab.swift` **(new)** | `Tab` value type: tabID, userTitle, root tree, focusedPaneID, zoomedPaneID, collapsed; derived helpers (paneIDs, isSplit, focusedPane, collapsed-line title, attention rollup). |
| `Sources/AgentStore.swift` | Refactor `tabs: [Agent]` → `tabs: [Tab]`; pane-keyed socket `apply`; split/close/focus/zoom mutations; per-pane attention/badge/notifications; recursive persistence. `Agent` struct deleted (→ `Pane`). |
| `Sources/GhosttyTerminal.swift` | Rename `tabID`→`paneID`; surface keyed by pane. Otherwise unchanged. |
| `Sources/Ghostty.swift` | `close_surface_cb`/`SET_TITLE`/`PWD` call `…(paneID:)` store methods. |
| `Sources/SplitContainer.swift` **(new)** | Recursive SwiftUI view: renders a `SplitNode` as nested `HStack`/`VStack` with draggable dividers; leaves are `GhosttyTerminal`. Handles zoom (render only zoomed pane). |
| `Sources/ContentView.swift` | ZStack over tabs → each tab renders its `SplitContainer`; only selected tab visible/hit-testable. |
| `Sources/SidebarView.swift` | Tab row → for split tabs: leading bracket + expanded per-pane rows or collapsed `● 1 ▸ 2` strip; collapse toggle; zoom dimming. |
| `Sources/ShepherdApp.swift` | New menu commands: ⌘D, ⌘⇧D, ⌘W (pane-aware), ⌘⌥arrows, ⌘⇧↩. |
| `project.yml` | Add `ShepherdModelTests` unit-test target (sources: SplitTree.swift, Tab.swift, AgentState.swift, Theme.swift). |
| `Tests/SplitTreeTests.swift` **(new)** | XCTest for the model (sibling of `Sources/`). |
| `SPEC.md`, `CLAUDE.md` | Update §1/§6 and architecture notes (Task 11). |

---

## Task 1: Model skeleton + test target (`Pane`, `SplitAxis`, `SplitNode`)

**Files:**
- Create: `spike/seam1/Sources/SplitTree.swift`
- Create: `spike/seam1/Tests/SplitTreeTests.swift`
- Modify: `spike/seam1/project.yml` (add test target)

**Interfaces — Produces:**
- `struct Pane: Identifiable, Equatable` — `let paneID: String`, `var title: String`, `var userTitle: String?`, `var cwd: String?`, `var state: AgentState`, `var reason: String?`, `var id: String { paneID }`, `init(paneID: String = UUID().uuidString)`, `var displayTitle: String`.
- `enum SplitAxis: String, Codable { case row; case column }`
- `indirect enum SplitNode { case leaf(Pane); case split(axis: SplitAxis, ratio: Double, first: SplitNode, second: SplitNode) }`
- `var SplitNode.leafIDs: [String]`, `var panes: [Pane]`, `var firstLeafID: String?`, `func pane(_ id: String) -> Pane?`

- [ ] **Step 1: Add the test target to `project.yml`**

Append under `targets:` (sibling of `Shepherd:`). The target is **standalone** — it compiles its own copies of the pure files and has **no dependency on `Shepherd`** (avoids GhosttyKit linkage and duplicate-symbol issues; the app target compiles the same files in its own separate module, which is fine). Tests live in `Tests/` — a **sibling of `Sources/`, NOT under it** — so the app target's `- path: Sources` glob never pulls XCTest into the app:

```yaml
  ShepherdModelTests:
    type: bundle.unit-test
    platform: macOS
    sources:
      - path: Sources/SplitTree.swift
      - path: Sources/Tab.swift
      - path: Sources/AgentState.swift
      - path: Sources/Theme.swift
      - path: Tests
```

> `Sources/Tab.swift` doesn't exist until Task 5. For Tasks 1–4 the model tests only need `SplitTree.swift`; create an empty `Sources/Tab.swift` now (`import Foundation`) so xcodegen resolves the path, and fill it in Task 5. Test files share the `ShepherdModelTests` module with the compiled sources, so they reference `Pane`/`SplitNode` directly — no `import Shepherd`.

- [ ] **Step 2: Write `SplitTree.swift` with the skeleton**

```swift
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
```

- [ ] **Step 3: Write failing tests**

`Tests/SplitTreeTests.swift`:

```swift
import XCTest

final class SplitTreeTests: XCTestCase {
    func testLeafIDsAndLookup() {
        let p = Pane(paneID: "a")
        let tree = SplitNode.leaf(p)
        XCTAssertEqual(tree.leafIDs, ["a"])
        XCTAssertEqual(tree.firstLeafID, "a")
        XCTAssertEqual(tree.pane("a")?.paneID, "a")
        XCTAssertNil(tree.pane("nope"))
    }

    func testNestedLeafOrder() {
        let tree = SplitNode.split(axis: .row, ratio: 0.5,
            first: .leaf(Pane(paneID: "a")),
            second: .split(axis: .column, ratio: 0.5,
                first: .leaf(Pane(paneID: "b")),
                second: .leaf(Pane(paneID: "c"))))
        XCTAssertEqual(tree.leafIDs, ["a", "b", "c"])
    }
}
```

- [ ] **Step 4: Generate, build the test target, verify it fails then passes**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath ./build CLANG_MODULE_CACHE_PATH=./build/ModuleCache
```
Expected: tests PASS (the skeleton already satisfies them). If the scheme `ShepherdModelTests` doesn't exist, run with `-scheme Shepherd` and the test target attached, or add a scheme in `project.yml` `schemes:`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/SplitTree.swift spike/seam1/Tests/SplitTreeTests.swift spike/seam1/Sources/Tab.swift spike/seam1/project.yml
git commit -m "feat(splits): pure SplitNode/Pane model + test target"
```

---

## Task 2: Tree mutations — `split`, `close`, `updatePane`

**Files:**
- Modify: `spike/seam1/Sources/SplitTree.swift`
- Modify: `spike/seam1/Sources/Tests/SplitTreeTests.swift`

**Interfaces — Produces:**
- `mutating func SplitNode.split(paneID: String, axis: SplitAxis, newPane: Pane) -> Bool` — replaces `leaf(paneID)` with `split(axis, 0.5, leaf(existing), leaf(newPane))`. Returns `true` if the pane was found.
- `mutating func SplitNode.updatePane(_ id: String, _ transform: (inout Pane) -> Void) -> Bool`
- `func SplitNode.closing(paneID: String) -> SplitNode?` — returns the tree with that leaf removed and its parent split collapsed to the sibling; returns `nil` if `paneID` was the only leaf (caller closes the tab).

- [ ] **Step 1: Write failing tests**

```swift
func testSplitReplacesLeaf() {
    var tree = SplitNode.leaf(Pane(paneID: "a"))
    XCTAssertTrue(tree.split(paneID: "a", axis: .row, newPane: Pane(paneID: "b")))
    XCTAssertEqual(tree.leafIDs, ["a", "b"])
    if case .split(let axis, let ratio, _, _) = tree {
        XCTAssertEqual(axis, .row); XCTAssertEqual(ratio, 0.5)
    } else { XCTFail("expected split") }
}

func testSplitUnknownPaneReturnsFalse() {
    var tree = SplitNode.leaf(Pane(paneID: "a"))
    XCTAssertFalse(tree.split(paneID: "zzz", axis: .row, newPane: Pane(paneID: "b")))
    XCTAssertEqual(tree.leafIDs, ["a"])
}

func testCloseCollapsesParentToSibling() {
    var tree = SplitNode.split(axis: .row, ratio: 0.5,
        first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
    let after = tree.closing(paneID: "a")
    XCTAssertEqual(after?.leafIDs, ["b"])
    if case .leaf = after { } else { XCTFail("sibling should hoist to a leaf") }
}

func testCloseOnlyLeafReturnsNil() {
    let tree = SplitNode.leaf(Pane(paneID: "a"))
    XCTAssertNil(tree.closing(paneID: "a"))
}

func testUpdatePane() {
    var tree = SplitNode.split(axis: .column, ratio: 0.5,
        first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
    XCTAssertTrue(tree.updatePane("b") { $0.state = .working })
    XCTAssertEqual(tree.pane("b")?.state, .working)
}
```

- [ ] **Step 2: Run to verify failure** (`function not defined`). Same `xcodebuild test` command as Task 1 Step 4.

- [ ] **Step 3: Implement on `SplitNode`**

```swift
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

    /// Tree with `paneID` removed (parent split collapses to its sibling).
    /// `nil` means `paneID` was the only leaf → the tab is now empty.
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
```

- [ ] **Step 4: Run tests to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(splits): SplitNode split/close/updatePane"`

---

## Task 3: Geometry — `frames(in:)` + directional `neighbor`

**Files:** Modify `SplitTree.swift` + `SplitTreeTests.swift`

**Interfaces — Produces:**
- `func SplitNode.frames(in rect: CGRect) -> [String: CGRect]` — recursively lays out leaves: `.row` splits `rect` left/right by `ratio` (first gets `ratio*width`); `.column` splits top/bottom (first = top). Used by both rendering and nav.
- `func SplitNode.neighbor(of paneID: String, _ dir: FocusDirection, in rect: CGRect) -> String?` — nearest other pane whose center lies in `dir` from the source pane's center.

- [ ] **Step 1: Failing tests**

```swift
func testFramesRowSplit() {
    let tree = SplitNode.split(axis: .row, ratio: 0.5,
        first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
    let f = tree.frames(in: CGRect(x: 0, y: 0, width: 100, height: 40))
    XCTAssertEqual(f["a"], CGRect(x: 0, y: 0, width: 50, height: 40))
    XCTAssertEqual(f["b"], CGRect(x: 50, y: 0, width: 50, height: 40))
}

func testNeighborRight() {
    let tree = SplitNode.split(axis: .row, ratio: 0.5,
        first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
    let rect = CGRect(x: 0, y: 0, width: 100, height: 40)
    XCTAssertEqual(tree.neighbor(of: "a", .right, in: rect), "b")
    XCTAssertNil(tree.neighbor(of: "a", .left, in: rect))
}
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement**

```swift
extension SplitNode {
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
}
```

- [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `git commit -am "feat(splits): SplitNode frames + directional neighbor"`

---

## Task 4: Persistence codec (Codable, fresh ids + shell state on restore)

**Files:** Modify `SplitTree.swift` + `SplitTreeTests.swift`

**Interfaces — Produces:** `SplitNode: Codable` and `Pane: Codable`. Encoding writes only structure + `userTitle`/`cwd`; decoding mints a fresh `paneID` and `state = .shell` per leaf (live state never persists — matches today's restore).

- [ ] **Step 1: Failing test**

```swift
func testCodableRoundTripKeepsStructureDropsLiveState() throws {
    var tree = SplitNode.split(axis: .row, ratio: 0.3,
        first: .leaf(Pane(paneID: "a")), second: .leaf(Pane(paneID: "b")))
    _ = tree.updatePane("a") { $0.userTitle = "left"; $0.cwd = "/tmp"; $0.state = .working }
    let data = try JSONEncoder().encode(tree)
    let back = try JSONDecoder().decode(SplitNode.self, from: data)
    XCTAssertEqual(back.leafIDs.count, 2)                  // structure preserved
    let restored = back.panes.first { $0.userTitle == "left" }
    XCTAssertEqual(restored?.cwd, "/tmp")                  // persisted fields survive
    XCTAssertEqual(restored?.state, .shell)               // live state dropped
    XCTAssertNotEqual(restored?.paneID, "a")              // fresh id
    if case .split(_, let r, _, _) = back { XCTAssertEqual(r, 0.3) }
}
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement Codable**

```swift
extension Pane: Codable {
    enum CodingKeys: String, CodingKey { case userTitle, cwd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(paneID: UUID().uuidString)             // fresh id; state defaults to .shell
        userTitle = try c.decodeIfPresent(String.self, forKey: .userTitle)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(userTitle, forKey: .userTitle)
        try c.encodeIfPresent(cwd, forKey: .cwd)
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
```

- [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `git commit -am "feat(splits): SplitNode/Pane Codable (fresh ids, drop live state)"`

---

## Task 5: `Tab` type + `AgentStore` refactor (behavior-preserving for unsplit tabs)

This is the riskiest task: it swaps the store's `[Agent]` for `[Tab]` while keeping the app behaving **exactly as today** (no split UI yet — every tab has one pane). Verify by running and confirming no regression.

**Files:**
- Create: `spike/seam1/Sources/Tab.swift` (fill the stub from Task 1)
- Modify: `spike/seam1/Sources/AgentStore.swift` (large), `GhosttyTerminal.swift`, `Ghostty.swift`, and the **compile-ripple** files that read the old `Agent` model: `SidebarView.swift`, `ContentView.swift`, `AppDelegate.swift`. Touch the ripple files only enough to compile + preserve identical behavior — the sidebar bracket/strip redesign is Task 9, the recursive render is Task 6.

**Interfaces — Produces:**
- `struct Tab: Identifiable { let tabID: String; var userTitle: String?; var root: SplitNode; var focusedPaneID: String; var zoomedPaneID: String?; var collapsed: Bool; var id: String { tabID }; var paneIDs: [String] { root.leafIDs }; var isSplit: Bool { paneIDs.count > 1 }; func focusedPane() -> Pane?; func attentionState() -> AgentState?; var collapsedStripPanes: [Pane] }`
- `AgentStore`: `@Published tabs: [Tab]`, `@Published selectedTab: String?`. Methods used by views/commands: `newTab()`, `select(tabID:)`, `focusPane(_ paneID:)`, `splitFocused(_ axis: SplitAxis)`, `closeFocusedPane()`, `focusNeighbor(_ dir: FocusDirection, in rect: CGRect)`, `toggleZoom()`, `setCollapsed(_ tabID:, _ value: Bool)`, `rename(tabID:, to:)`, plus the per-pane feeds `apply(event:detail:paneID:)`, `setTitle(_:paneID:)`, `setCwd(_:paneID:)`, `closePane(_ paneID:)`, `didFocus(paneID:)`, and `revealPane(_ paneID:)` (notification routing — select owning tab + focus the pane).
- `cwd(forPane:)` for surface creation.
- **Deferred — NOT added in Task 5** (no caller until Tasks 7–9; see Step 3): `splitFocused`, `closeFocusedPane`, `focusPane`, `focusNeighbor`, `toggleZoom`, `setCollapsed`.

**Implementation notes (verify by build+run, not unit test):**

- [ ] **Step 1: Write `Tab.swift`.**

```swift
import Foundation

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
```

- [ ] **Step 2: Rewrite `AgentStore` around `[Tab]`.** Delete the `Agent` struct (now `Pane`). Key changes, preserving today's semantics:
  - `newTab()` → make a `Pane` + `Tab(pane:collapsedDefault: defaultCollapsed)`, append, `selectedTab = tab.tabID`, save.
  - `select(tabID:)` → set `selectedTab`, then `didFocus(paneID: tab.focusedPaneID)` (clears need-to-check on the focused pane).
  - **Socket `apply(event:detail:paneID:)`**: find the tab whose `paneIDs` contains `paneID` (`tabs.first { $0.paneIDs.contains(paneID) }`), read that pane's current state via `root.pane(paneID)`, run the *identical* lifecycle switch from today, write back with `tabs[i].root.updatePane(paneID) { $0.state = …; $0.reason = … }`. The ordering guard (mid-turn) is unchanged. Log line unchanged.
  - `setTitle`/`setCwd`/`didFocus` → `updatePane(paneID)` on the owning tab. `setCwd` still calls `save()`.
  - `closePane(_ paneID:)`: find owning tab; `if let newRoot = tab.root.closing(paneID:)` → update root, fix `focusedPaneID` (if it was the closed pane, set to `newRoot.firstLeafID`), clear `zoomedPaneID` if it was that pane; `else` (was last pane) → remove the tab (today's `closeTab` logic: reselect `tabs.last`, async refocus). `save(); updateDockBadge()`.
  - **Attention everywhere becomes per-pane:** `attentionCount = tabs.flatMap { $0.root.panes }.filter { $0.state.wantsAttention }.count`. `selectNextAttention()` iterates panes across tabs in (tab, leaf) order, selecting the tab AND setting its `focusedPaneID`. Notifications fire per pane (title = pane.displayTitle).
  - `selectIndex/selectNext/selectPrevious` operate on **tabs** (unchanged meaning).
  - `rename(tabID:to:)` sets `tabs[i].userTitle`.
- [ ] **Step 3: Do NOT add the split/zoom/focus mutations here** (`splitFocused`, `closeFocusedPane`, `focusPane`, `focusNeighbor`, `toggleZoom`, `setCollapsed`). They have no caller until Tasks 7–9, and several need view-supplied geometry that doesn't exist yet — adding them now risks half-baked code. Each consuming task adds its own. Task 5 is *only* the behavior-preserving data-model / socket / persistence / rename refactor. (The `Tab.zoomedPaneID` and `Tab.collapsed` *fields* stay — they're data, just not yet mutated by UI.)
- [ ] **Step 4: `defaultCollapsed`** — `@AppStorage("shepherd.panes.defaultCollapsed")`-backed via a small helper read in `AgentStore` (UserDefaults.standard.bool(forKey:)). *(ADR 0012 envisions a `~/.config/shepherd` value; sourcing it from that file is a deferred follow-up — note it in the commit.)*
- [ ] **Step 5: Persistence** — replace `[Persisted]` with `struct PersistedTab: Codable { var userTitle: String?; var root: SplitNode; var collapsed: Bool }`. `save()` maps `tabs` → `[PersistedTab]`; `restore()` decodes and rebuilds `Tab`s (root decodes with fresh pane ids + shell state via Task 4; `focusedPaneID = root.firstLeafID!`). Old persisted blobs under `shepherd.tabs.v1` won't decode → bump the key to `shepherd.tabs.v2` so a stale v1 blob is ignored (first launch falls back to `newTab()`).
- [ ] **Step 6: Rename `GhosttyTerminal.tabID` → `paneID`** and `GhosttyTerminal(tabID:…)` → `(paneID:…)`; update env injection to inject `paneID` as the value of `SHEPHERD_TAB_ID` (name unchanged). In `Ghostty.swift`, the three callbacks now read `view(ud).paneID` and call `setTitle(_:paneID:)`, `setCwd(_:paneID:)`, `closePane(_:)`. `cwd(forTab:)` → `cwd(forPane:)`.
- [ ] **Step 7: Compile-ripple views (behavior-preserving).**
  - `ContentView` — keep rendering one surface per tab for now, keyed by the tab's single pane: `GhosttyTerminal(paneID: tab.focusedPaneID, …)`. (Real recursive render lands in Task 6.) Keeps the app runnable.
  - `SidebarView`'s `TabRow` reads the old `Agent` fields (`.state`, `.reason`); rebind to the tab's focused pane: state = `tab.focusedPane()?.state ?? .shell`, reason = `tab.focusedPane()?.reason`, name = `tab.displayTitle` (already on `Tab`). The row must look identical to today for a 1-pane tab. **Do NOT** build the bracket / numbered-strip / zoom-dimming — that's Task 9.
  - `AppDelegate` routes notification clicks. Notifications now fire per pane, so put the **paneID** in the notification `userInfo` (in `AgentStore.notifyAttention`) and reveal it via the new `AgentStore.revealPane(_ paneID:)` (select owning tab, set `focusedPaneID`, clear need-to-check). For a 1-pane tab this is identical to today's `select(tabID:)`.
- [ ] **Step 8: Build, run, verify NO regression.**

```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build && \
codesign --force --deep --sign - ./build/Build/Products/Debug/Shepherd.app && \
open ./build/Build/Products/Debug/Shepherd.app
```
Manual checks (must all still work): new tab (⌘T), close tab (⌘W), switch tabs (⌘1–9, ⌘⇧[/]), rename, drag-reorder, run `claude` and watch sidebar state + dock badge + ⌘⇧A, quit & relaunch restores tabs + cwd. Also run `xcodebuild test … ShepherdModelTests` (model tests still green).

- [ ] **Step 9: Commit** — `git commit -am "refactor(splits): tabs own a pane tree; Agent→Pane; per-pane socket/attention/persistence (v2)"`

---

## Task 6: Recursive render — `SplitContainer`

**Files:** Create `Sources/SplitContainer.swift`; modify `ContentView.swift`. (`project.yml` regen.)

**Interfaces — Produces:** `struct SplitContainer: View { let node: SplitNode; let tabID: String; let isTabSelected: Bool; let focusTick: Int }` — renders `node` recursively; a `.leaf` → `GhosttyTerminal(paneID:isSelected:focusTick:)` (selected = `isTabSelected && pane is the tab's focusedPane`, used for first-responder); a `.split` → `HStack`(`.row`)/`VStack`(`.column`) of the two children sized by `ratio` (via `GeometryReader`), divider between.

- [ ] **Step 1:** Implement `SplitContainer` (dividers come in Task 7; here use fixed `ratio` via `GeometryReader` + `.frame`). Each leaf wraps `GhosttyTerminal` and a 1px `Theme.hairline` border when it's the focused pane of the selected tab (the focus ring). Tapping a leaf calls `store.focusPane(paneID)`.
- [ ] **Step 2:** `ContentView` ZStack: `ForEach(store.tabs) { tab in SplitContainer(node: tab.root, tabID: tab.tabID, isTabSelected: tab.tabID == store.selectedTab, focusTick: store.focusTick).opacity(selected ? 1 : 0).allowsHitTesting(selected) }`. Surfaces of all tabs stay mounted (shells alive), as today.
- [ ] **Step 3: Build + run.** Verify single-pane tabs look/behave identical. (No way to split yet — proves the recursive renderer degenerates correctly to the 1-pane case.) Temporarily seed a split in code (a debug `splitFocused(.row)` on launch) to eyeball two surfaces side-by-side, then remove the seed.
- [ ] **Step 4: Commit** — `git commit -am "feat(splits): recursive SplitContainer render"`

---

## Task 7: Draggable dividers (resize `ratio`)

**Files:** `SplitContainer.swift`; add `AgentStore.setRatio(tabID:path:ratio:)` or address the split node by identity.

**Approach:** Each `.split` renders a 6px draggable divider (reuse the sidebar's pattern: `Theme.hairline` hairline, `NSCursor.resize{LeftRight|UpDown}`). Dragging updates that split's `ratio`. Because `SplitNode` is a value tree, address the split by a **path** (`[Int]` of first/second choices from the root) so the store can mutate the exact node: `mutating func SplitNode.setRatio(at path: [Int], to ratio: Double)`. Clamp ratio to `[0.1, 0.9]`.

- [ ] **Step 1:** Add `SplitNode.setRatio(at:to:)` + a unit test (back in the model test file — TDD this one). Run model tests.
- [ ] **Step 2:** Render dividers in `SplitContainer`, threading the node's path; on drag change call `store.setRatio(tabID:path:ratio:)`.
- [ ] **Step 3: Build + run; verify drag resizes both axes,** clamps, and the terminal grid reflows (libghostty `set_size` already fires on `setFrameSize`).
- [ ] **Step 4: Commit** — `git commit -am "feat(splits): draggable split dividers"`

---

## Task 8: Split / close / focus / zoom commands + keybindings

**Files:** `ShepherdApp.swift` (menu commands), `AgentStore.swift` (mutations if not added in Task 5), `SplitContainer.swift` (zoom render), `GhosttyTerminal` focus routing.

**Mutations (add to AgentStore if stubbed):**
- `splitFocused(_ axis: SplitAxis)`: on `selectedTab`, make a new `Pane` (seed cwd from focused pane's cwd), `root.split(paneID: focusedPaneID, axis:, newPane:)`, set `focusedPaneID = newPane.paneID`, clear zoom, save.
- `closeFocusedPane()`: `closePane(selectedTab.focusedPaneID)` (Task 5 logic).
- `focusNeighbor(_ dir:in rect:)`: `root.neighbor(of: focusedPaneID, dir, in: rect)` → set focusedPaneID + refocus surface. (Pass the content rect via a stored `@Published lastContentSize` set from `ContentView`'s `GeometryReader`.)
- `toggleZoom()`: `zoomedPaneID = (zoomedPaneID == nil ? focusedPaneID : nil)`.

- [ ] **Step 1: Menu commands** in `ShepherdApp.commands` (after existing group):

```swift
Divider()
Button("Split Right") { AgentStore.shared.splitFocused(.row) }
    .keyboardShortcut("d", modifiers: .command)
Button("Split Down") { AgentStore.shared.splitFocused(.column) }
    .keyboardShortcut("d", modifiers: [.command, .shift])
Button("Zoom Pane") { AgentStore.shared.toggleZoom() }
    .keyboardShortcut(.return, modifiers: [.command, .shift])
Button("Focus Left")  { AgentStore.shared.focusNeighbor(.left) }
    .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
Button("Focus Right") { AgentStore.shared.focusNeighbor(.right) }
    .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
Button("Focus Up")    { AgentStore.shared.focusNeighbor(.up) }
    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
Button("Focus Down")  { AgentStore.shared.focusNeighbor(.down) }
    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
```
And change the existing **Close Tab** ⌘W button to **Close Pane**: `if focused tab has >1 pane → closeFocusedPane(); else if tabs.count > 1 → closeSelected(); else performClose`. (`focusNeighbor(_:)` reads `store.lastContentSize` internally so the command needs no rect arg.)

- [ ] **Step 2: Zoom render** in `SplitContainer`: when `tab.zoomedPaneID != nil`, render only that leaf filling the area (ignore the tree layout). Other panes stay mounted but hidden (`opacity 0`), so their shells/agents keep running.
- [ ] **Step 3: Focus routing** — `GhosttyTerminal.updateNSView` already claims first responder when `isSelected`; ensure `isSelected` = `isTabSelected && paneID == tab.focusedPaneID`, and bump `focusTick` from `splitFocused`/`focusNeighbor`/`toggleZoom` so the new focused surface grabs the keyboard.
- [ ] **Step 4: Build + run; verify:** ⌘D → left/right; ⌘⇧D → top/bottom; nesting; ⌘⌥arrows move focus (with focus ring following); ⌘W closes the focused pane and collapses the sibling, last-pane closes the tab; ⌘⇧↩ zooms and un-zooms; run two `claude`s in two panes and confirm both states track independently in the sidebar and badge.
- [ ] **Step 5: Commit** — `git commit -am "feat(splits): ⌘D/⌘⇧D/⌘W/⌘⌥arrows/⌘⇧↩ commands + zoom render"`

---

## Task 9: Sidebar — bracket grouping, collapse, numbered strip, zoom dimming

**Files:** `SidebarView.swift`.

**Design (ADR 0012):**
- Unsplit tab → today's `TabRow` exactly.
- Split tab, **expanded** → a leading rounded **bracket/rail** (a thin `Path`/`Shape` along the group's left edge, `Theme.hairline`) spanning the pane rows; each pane is a row with its state dot + `displayTitle` + status word; clicking a pane row → `store.focusPane(paneID)` (and selects the tab). The bracket region is the tab's click target (select tab) + context menu (rename/close-tab).
- Split tab, **collapsed** → one row: a strip of `<state-dot> <n>` pips (n = 1-based leaf index), **no brackets, no titles**; hovering a pip reveals that pane's title in place (overlay). Clicking a pip → focus that pane (+ select tab). Clicking elsewhere on the row toggles collapse, or use a small disclosure affordance on hover.
- **Zoom dimming:** when `tab.zoomedPaneID != nil`, the zoomed pane's dot/pip is full-opacity and siblings are dimmed (`.opacity(0.4)`), in both expanded rows and the collapsed strip.
- Collapse state persists (it's on `Tab`, saved). Default from `defaultCollapsed`.

- [ ] **Step 1:** Add a `Bracket` `Shape` (left rail with small top/bottom ticks) in `SidebarView.swift`.
- [ ] **Step 2:** Refactor the `ForEach(store.tabs)` body: `if tab.isSplit { SplitTabGroup(tab:) } else { TabRow(tab:) }`. Implement `SplitTabGroup` with expanded/collapsed branches per the design; reuse `LeadingIcon`/`BreathingDot` for dots.
- [ ] **Step 3:** Keep all controls `.focusable(false)`; pip/row taps call store methods that route first responder to the focused surface (ADR 0009).
- [ ] **Step 4: Build + run; verify** the four cases above: unsplit unchanged; expanded bracket group with per-pane rows; collapsed `● 1 ▸ 2 ○ 3` strip with hover-title; collapse toggle persists across relaunch; zoom dims siblings; a blocked pane inside a collapsed group still shows its red dot (attention not hidden) and the dock badge still counts it.
- [ ] **Step 5: Commit** — `git commit -am "feat(splits): bracket-grouped collapsible sidebar with numbered strip + zoom dimming"`

---

## Task 10: Persistence end-to-end + edge cases

- [ ] **Step 1:** Run, create a nested split layout with custom ratios + a rename + a collapsed group, quit (⌘Q), relaunch. **Verify** tree shape, ratios, per-pane cwd, tab rename, and collapse state all restore (live agent state correctly resets to shell). Model round-trip is already unit-tested (Task 4); this verifies the store wiring.
- [ ] **Step 2:** Edge cases to exercise manually: close panes down to one (tab becomes unsplit row), close the last pane (tab closes), close the last tab (window closes), `claude` child-exit in one pane closes only that pane (`close_surface_cb`), zoom then split (zoom clears).
- [ ] **Step 3: Commit** any fixes — `git commit -am "fix(splits): persistence + close/zoom edge cases"`

---

## Task 11: Docs — SPEC, CLAUDE.md, ADR status

**Files:** `SPEC.md`, `CLAUDE.md` (root project one is `dev/tools/shepherd/CLAUDE.md`).

- [ ] **Step 1:** `SPEC.md` §1: change "≤1 agent per tab. No splits in v1" → tabs hold a pane tree, each pane an agent. §6: remove "splits" from Deferred.
- [ ] **Step 2:** `CLAUDE.md`: update the "Architecture" + "Agent state lifecycle" + repo-layout notes from per-tab to per-pane (tab = container of a pane tree); add `SplitTree.swift`, `Tab.swift`, `SplitContainer.swift` to the source-files list; add the split/zoom/focus keybindings to the menu-commands line; note the `shepherd.tabs.v2` persistence key. Add the "Done" line for splits.
- [ ] **Step 3:** Confirm ADR 0012 status stays `Accepted`. Commit — `git commit -am "docs: splits land — update SPEC + CLAUDE.md"`

---

## Self-review (completed during planning)

- **Spec coverage:** panes-as-agents (Tasks 1,5) · recursive H/V tree (1–3,6) · ⌘D/⌘⇧D/⌘W/⌘⌥arrows/⌘⇧↩ (8) · draggable dividers (7) · zoom + sidebar dimming (8,9) · bracket sidebar + collapsed numbered strip + attention rollup via per-pane dots (9) · persist full tree+ratios+cwd (4,5,10) · collapse default config (5) · socket/plugin unchanged (5, constraints) · docs (11). ✅
- **Placeholders:** model tasks carry full code; UI tasks carry interfaces + key code + explicit build/manual-verify (justified in Global Constraints, not a placeholder). ✅
- **Type consistency:** `SplitNode`/`Pane`/`SplitAxis`/`FocusDirection`/`Tab` names and the `splitFocused/closeFocusedPane/focusNeighbor/toggleZoom/setCollapsed/apply(…paneID:)` signatures are used consistently across tasks. ✅
