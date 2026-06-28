# Workspaces (Arc-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Arc-style workspaces to Shepherd — each workspace owns an independent set of tabs/panes; switch via sidebar dropdown, two-finger swipe, or keyboard; agents in hidden workspaces still pull you back.

**Architecture:** A new `Workspace` level nests above tabs (`AgentStore → [Workspace] → [Tab] → SplitNode → Pane`). `store.tabs`/`store.selectedTab` become computed views of the *current* workspace so existing UI is untouched. The socket→state machinery is preserved verbatim — only pane *lookup* changes to a `locatePane` helper that walks every workspace, which also makes attention global by construction.

**Tech Stack:** Swift 5, SwiftUI + AppKit, libghostty (`GhosttyKit.xcframework`), XcodeGen, XCTest. macOS app, single window.

## Global Constraints

- **Working dir for all build/test commands:** `spike/seam1` (the real app; "spike" is historical).
- **Run `xcodegen generate` after adding/removing ANY source file** — else the new file isn't compiled (`cannot find X in scope` at *build* time).
- **The `ShepherdModelTests` target is AppKit-free.** Files added to it (`Workspace.swift`, `Persistence.swift`) MUST `import Foundation` only — no SwiftUI/AppKit. They may use `Tab`, `SplitNode`, `Pane`, `AgentState` (all already in the target).
- **Do NOT change the `apply` decision logic or the ordering guard** ([ADR 0004](../../../.claude/adr/0004-plugin-protocol-and-ordering.md)). Only the pane *lookup* (`tabs.firstIndex{…}` → `locatePane(…)`) changes. The plugin protocol / `report.sh` are untouched.
- **Keep all sidebar SwiftUI controls `.focusable(false)`** ([ADR 0009](../../../.claude/adr/0009-sidebar-custom-rows-not-list.md)) so focus stays on the terminal; the only legitimate keyboard-focus taker is an active rename `TextField`.
- **libghostty C-API calls happen on the main thread** (everything here is `@MainActor`/main-thread already).
- **SourceKit lies in this repo** — ignore editor "cannot find type" noise; `xcodebuild` is ground truth.
- **Commit message footer** (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### Build / test commands (copy verbatim)

Model tests (Tasks 1–2):
```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests \
  -destination 'platform=macOS' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache 2>&1 | tail -8
```

App build (Tasks 3–8):
```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -8
```

Run the app (manual verification):
```bash
cd spike/seam1
APP=./build/Build/Products/Debug/Shepherd.app
codesign --force --deep --sign - "$APP"
killall Shepherd 2>/dev/null; until ! pgrep -x Shepherd; do sleep 0.2; done
open "$APP"
tail -f /tmp/shepherd-events.log    # watch state transitions in another shell
```

---

## Task 1: Workspace model + roll-up + pure helpers

**Files:**
- Create: `spike/seam1/Sources/Workspace.swift`
- Modify: `spike/seam1/Sources/AgentState.swift` (add `rollUp`)
- Modify: `spike/seam1/project.yml` (add `Workspace.swift` to test target)
- Test: `spike/seam1/Tests/WorkspaceTests.swift`

**Interfaces:**
- Consumes: `Tab`, `Pane`, `SplitNode`, `AgentState` (existing).
- Produces:
  - `struct Workspace: Identifiable` — `id: String`, `userTitle: String?`, `tabs: [Tab]`, `selectedTabID: String?`; `init(id:userTitle:tabs:selectedTabID:)`; `func displayName(index: Int) -> String`; `var aggregateState: AgentState`; `mutating func reseedIfEmpty()`.
  - `func locatePane(_ paneID: String, in workspaces: [Workspace]) -> (ws: Int, tab: Int)?`
  - `func removingWorkspace(_ id: String, from workspaces: [Workspace]) -> [Workspace]?`
  - `func totalAttentionCount(in workspaces: [Workspace]) -> Int`
  - `static func AgentState.rollUp<S: Sequence>(_ states: S) -> AgentState where S.Element == AgentState`

- [ ] **Step 1: Add the roll-up helper to `AgentState.swift`**

Append this extension at the end of `spike/seam1/Sources/AgentState.swift`:

```swift
extension AgentState {
    /// The most attention-worthy state across a set — the tab/workspace rollup dot.
    /// Priority: blocked > error > need-to-check > working > idle > shell.
    static func rollUp<S: Sequence>(_ states: S) -> AgentState where S.Element == AgentState {
        let set = Set(states)
        for s: AgentState in [.blocked, .error, .needsCheck, .working, .idle] where set.contains(s) {
            return s
        }
        return .shell
    }
}
```

- [ ] **Step 2: Create `Workspace.swift`**

Create `spike/seam1/Sources/Workspace.swift`:

```swift
import Foundation

/// One workspace owns an independent set of tabs (each a pane tree) plus which
/// tab is selected. A Workspace is to a Tab what a Tab is to its pane tree.
struct Workspace: Identifiable {
    let id: String
    var userTitle: String?
    var tabs: [Tab]
    var selectedTabID: String?

    init(id: String = UUID().uuidString, userTitle: String? = nil,
         tabs: [Tab], selectedTabID: String? = nil) {
        self.id = id
        self.userTitle = userTitle
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.tabID
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
```

- [ ] **Step 3: Add `Workspace.swift` to the test target**

In `spike/seam1/project.yml`, under `ShepherdModelTests:` → `sources:`, add the line so it reads:

```yaml
  ShepherdModelTests:
    type: bundle.unit-test
    platform: macOS
    sources:
      - path: Sources/SplitTree.swift
      - path: Sources/Tab.swift
      - path: Sources/AgentState.swift
      - path: Sources/Theme.swift
      - path: Sources/Workspace.swift
      - path: Tests
```

- [ ] **Step 4: Write the failing tests**

Create `spike/seam1/Tests/WorkspaceTests.swift`:

```swift
import XCTest

final class WorkspaceTests: XCTestCase {
    /// Build a one-tab workspace whose panes carry the given states (extra states
    /// add panes via splits).
    private func ws(_ paneStates: [AgentState] = [.shell], userTitle: String? = nil) -> Workspace {
        var first = Pane(paneID: UUID().uuidString)
        first.state = paneStates.first ?? .shell
        var tab = Tab(pane: first)
        for s in paneStates.dropFirst() {
            var np = Pane(paneID: UUID().uuidString); np.state = s
            _ = tab.root.split(paneID: tab.root.firstLeafID!, axis: .row, newPane: np)
        }
        return Workspace(userTitle: userTitle, tabs: [tab])
    }

    func testDisplayNameDefaultAndRename() {
        XCTAssertEqual(ws().displayName(index: 0), "Workspace 1")
        XCTAssertEqual(ws().displayName(index: 4), "Workspace 5")
        XCTAssertEqual(ws(userTitle: "Build").displayName(index: 0), "Build")
    }

    func testReseedIfEmpty() {
        var w = ws()
        w.tabs.removeAll()
        w.reseedIfEmpty()
        XCTAssertEqual(w.tabs.count, 1)
        XCTAssertEqual(w.selectedTabID, w.tabs.first?.tabID)
    }

    func testReseedNoopWhenNonEmpty() {
        var w = ws()
        let before = w.tabs.first?.tabID
        w.reseedIfEmpty()
        XCTAssertEqual(w.tabs.count, 1)
        XCTAssertEqual(w.tabs.first?.tabID, before)
    }

    func testLocatePaneAcrossWorkspaces() {
        let a = ws(); let b = ws()
        let target = b.tabs[0].root.firstLeafID!
        let found = locatePane(target, in: [a, b])
        XCTAssertEqual(found?.ws, 1)
        XCTAssertEqual(found?.tab, 0)
        XCTAssertNil(locatePane("nope", in: [a, b]))
    }

    func testRemovingWorkspaceGuardsLastOne() {
        let a = ws(), b = ws()
        XCTAssertNil(removingWorkspace(a.id, from: [a]))                 // last one — refuse
        XCTAssertEqual(removingWorkspace(a.id, from: [a, b])?.count, 1)  // ok with 2+
    }

    func testTotalAttentionCountAcrossWorkspaces() {
        let a = ws([.working, .blocked])   // 1 wants attention
        let b = ws([.needsCheck])          // 1 wants attention
        let c = ws([.idle, .shell])        // 0
        XCTAssertEqual(totalAttentionCount(in: [a, b, c]), 2)
    }

    func testRollUpPriority() {
        XCTAssertEqual(AgentState.rollUp([.idle, .working, .blocked]), .blocked)
        XCTAssertEqual(AgentState.rollUp([.idle, .working, .error]), .error)
        XCTAssertEqual(AgentState.rollUp([.idle, .working]), .working)
        XCTAssertEqual(AgentState.rollUp([.shell, .shell]), .shell)
        XCTAssertEqual(AgentState.rollUp([]), .shell)
    }

    func testAggregateState() {
        XCTAssertEqual(ws([.working, .needsCheck]).aggregateState, .needsCheck)
        XCTAssertEqual(ws([.shell]).aggregateState, .shell)
    }
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run the model-tests command (Global Constraints). Expected: `** TEST SUCCEEDED **`, executed count grows by 8 (was 21 → now 29), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workspace.swift spike/seam1/Sources/AgentState.swift \
        spike/seam1/project.yml spike/seam1/Tests/WorkspaceTests.swift
git commit -m "feat(workspaces): Workspace model + roll-up + pure locator/guard helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Persistence types + migration (pure)

**Files:**
- Create: `spike/seam1/Sources/Persistence.swift`
- Modify: `spike/seam1/project.yml` (add `Persistence.swift` to test target)
- Test: `spike/seam1/Tests/PersistenceTests.swift`

**Interfaces:**
- Consumes: `Workspace`, `Tab`, `Pane`, `SplitNode` (Codable).
- Produces:
  - `struct PersistedTab: Codable` — `userTitle: String?`, `root: SplitNode` (identical shape to the legacy v2 element, so old data still decodes).
  - `struct PersistedWorkspace: Codable` — `userTitle: String?`, `selectedTabIndex: Int`, `tabs: [PersistedTab]`.
  - `struct PersistedState: Codable` — `workspaces: [PersistedWorkspace]`, `selectedWorkspaceIndex: Int`.
  - `func snapshotState(_ workspaces: [Workspace], selectedWorkspaceID: String?) -> PersistedState`
  - `func buildWorkspaces(from state: PersistedState) -> [Workspace]`
  - `func migrateLegacyTabs(_ data: Data) -> PersistedState?`

- [ ] **Step 1: Create `Persistence.swift`**

Create `spike/seam1/Sources/Persistence.swift`:

```swift
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
```

- [ ] **Step 2: Add `Persistence.swift` to the test target**

In `spike/seam1/project.yml`, under `ShepherdModelTests:` → `sources:`, add `- path: Sources/Persistence.swift` after the `Workspace.swift` line.

- [ ] **Step 3: Write the failing tests**

Create `spike/seam1/Tests/PersistenceTests.swift`:

```swift
import XCTest

final class PersistenceTests: XCTestCase {
    private func tab(_ title: String?, cwd: String? = nil) -> Tab {
        var p = Pane(paneID: UUID().uuidString)
        p.userTitle = title; p.cwd = cwd
        return Tab(pane: p)
    }

    func testSnapshotRoundTripPreservesStructureAndSelection() throws {
        let t1 = tab("one", cwd: "/tmp/a")
        let t2 = tab("two", cwd: "/tmp/b")
        let ws1 = Workspace(userTitle: "WS", tabs: [t1, t2], selectedTabID: t2.tabID)

        let state = snapshotState([ws1], selectedWorkspaceID: ws1.id)
        XCTAssertEqual(state.workspaces.count, 1)
        XCTAssertEqual(state.workspaces[0].selectedTabIndex, 1)   // t2 selected
        XCTAssertEqual(state.selectedWorkspaceIndex, 0)

        let data = try JSONEncoder().encode(state)
        let back = try JSONDecoder().decode(PersistedState.self, from: data)
        let rebuilt = buildWorkspaces(from: back)

        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertEqual(rebuilt[0].userTitle, "WS")
        XCTAssertEqual(rebuilt[0].tabs.count, 2)
        // selection restored by index (tab ids are regenerated)
        XCTAssertEqual(rebuilt[0].selectedTabID, rebuilt[0].tabs[1].tabID)
        // persisted pane fields survive
        XCTAssertEqual(rebuilt[0].tabs[0].root.panes.first?.userTitle, "one")
        XCTAssertEqual(rebuilt[0].tabs[1].root.panes.first?.cwd, "/tmp/b")
    }

    func testMigrationWrapsLegacyTabsIntoOneWorkspace() throws {
        let legacy = [PersistedTab(userTitle: "a", root: .leaf(Pane(paneID: "x"))),
                      PersistedTab(userTitle: "b", root: .leaf(Pane(paneID: "y")))]
        let data = try JSONEncoder().encode(legacy)

        let migrated = migrateLegacyTabs(data)
        XCTAssertEqual(migrated?.workspaces.count, 1)
        XCTAssertEqual(migrated?.workspaces.first?.tabs.count, 2)
        XCTAssertNil(migrated?.workspaces.first?.userTitle)        // default name
        XCTAssertEqual(migrated?.selectedWorkspaceIndex, 0)

        let rebuilt = buildWorkspaces(from: migrated!)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertEqual(rebuilt[0].tabs.count, 2)
    }

    func testMigrationReturnsNilForEmptyOrGarbage() {
        XCTAssertNil(migrateLegacyTabs(Data()))
        XCTAssertNil(migrateLegacyTabs("not json".data(using: .utf8)!))
        let empty = try! JSONEncoder().encode([PersistedTab]())
        XCTAssertNil(migrateLegacyTabs(empty))
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run the model-tests command. Expected: `** TEST SUCCEEDED **`, count grows by 3 (29 → 32), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/Persistence.swift spike/seam1/project.yml \
        spike/seam1/Tests/PersistenceTests.swift
git commit -m "feat(workspaces): persistence types + v2->v1 migration (pure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `AgentStore` to be workspace-backed

This is the load-bearing change. It replaces the flat `tabs`/`selectedTab` storage with `workspaces`/`selectedWorkspaceID`, makes `tabs`/`selectedTab` computed views of the current workspace, routes the socket per-pane methods through `locatePane`, adds the workspace operations, makes attention global, changes the notification rule, and switches persistence to v1 + migration. **The `apply` switch and ordering guard are copied verbatim.**

> **Why `tabs.append(…)` / `tabs[i].root.split(…)` still work though `tabs` is now computed:** Swift performs get-modify-set *writeback* for mutating-method and subscript-set calls on a computed property. So `store.tabs[i].focusedPaneID = x` reads the current workspace's tabs, mutates element `i`, and writes the array back through the setter. The current-workspace methods rely on this; the cross-workspace (socket) methods use `workspaces[w]…` directly via `locatePane`.

**Files:**
- Modify (full rewrite): `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `Workspace`, `locatePane`, `removingWorkspace`, `totalAttentionCount`, `PersistedState`, `snapshotState`, `buildWorkspaces`, `migrateLegacyTabs` (Tasks 1–2); `Tab`, `Pane`, `SplitNode`, `AgentState`, `SocketServer` (existing).
- Produces (new public API for later tasks):
  - `@Published private(set) var workspaces: [Workspace]`, `@Published var selectedWorkspaceID: String?`, `@Published private(set) var lastSwitchForward: Bool`
  - `var currentWorkspaceIndex: Int?`, `var currentWorkspace: Workspace?`
  - `func anyTab(_ tabID: String) -> Tab?`
  - `func newWorkspace() -> String`, `func selectWorkspace(_ id: String)`, `func renameWorkspace(_ id: String, to: String)`, `func reorderWorkspace(_ id: String, toIndex: Int)`, `func deleteWorkspace(_ id: String)`, `func workspaceHasLiveAgent(_ id: String) -> Bool`, `func nextWorkspace()`, `func prevWorkspace()`, `func swipeToWorkspace(_ delta: Int)`
  - unchanged public surface: `tabs` (computed), `selectedTab` (computed), `newTab`, `select(tabID:)`, `closeTab`, `closeSelected`, `selectIndex`, `selectNext/Previous`, `selectNextAttention`, `rename`, `reorder`, `commitOrder`, `isFocusedSurface`, `cwd(forPane:)`, `apply`, `setTitle`, `setCwd`, `focusPane`, `didFocus`, `closePane`, `selectedTabIsSplit`, `splitFocused`, `closeFocusedPane`, `focusNeighbor`, `toggleZoom`, `setRatio`, `revealPane`, `attentionCount`, `refocusActiveTerminal`, `lastContentSize`, `focusTick`, `socketPath`.

- [ ] **Step 1: Replace the entire file**

Replace the full contents of `spike/seam1/Sources/AgentStore.swift` with:

```swift
import SwiftUI
import AppKit
import UserNotifications

/// App model: workspaces (each owning tabs, each tab a pane tree), selection, the
/// agent-state socket (per-pane), and persistence. `tabs`/`selectedTab` are
/// computed views of the CURRENT workspace, so UI code that predates workspaces
/// keeps working unchanged. Socket/attention methods span ALL workspaces.
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var workspaces: [Workspace] = []
    @Published var selectedWorkspaceID: String?

    /// True when the most recent switch moved forward (to a higher index) — drives
    /// the sidebar slide direction.
    @Published private(set) var lastSwitchForward = true

    /// Bumped to force the selected terminal to reclaim first responder.
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// The content area's size (SwiftUI top-left space), fed by ContentView so
    /// `focusNeighbor` can resolve geometric neighbors against the live layout.
    @Published var lastContentSize: CGSize = .zero

    /// Injected into each pane's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?
    private let persistKey = "shepherd.workspaces.v1"
    private let legacyKey  = "shepherd.tabs.v2"

    private let attentionSounds: [AgentState: NSSound] = {
        var m: [AgentState: NSSound] = [:]
        if let s = AgentStore.bundledSound("done")    { m[.needsCheck] = s }
        if let s = AgentStore.bundledSound("blocked") { m[.blocked]    = s }
        return m
    }()

    private static func bundledSound(_ name: String) -> NSSound? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }

    private init() {
        socketPath = "/tmp/shepherd-\(getpid()).sock"   // short: stays under sun_path's 104 limit
        server = SocketServer(path: socketPath) { [weak self] paneID, event, detail in
            self?.apply(event: event, detail: detail, paneID: paneID)
        }
        server?.start()
        if !restore() { newWorkspace() }   // reopen prior workspaces, else start with one
    }

    // MARK: Current-workspace accessors

    var currentWorkspaceIndex: Int? { workspaces.firstIndex { $0.id == selectedWorkspaceID } }
    var currentWorkspace: Workspace? { currentWorkspaceIndex.map { workspaces[$0] } }

    /// The current workspace's tabs/selection. get/set so existing UI keeps reading
    /// `store.tabs` / `store.selectedTab`; mutations write back via Swift's
    /// get-modify-set writeback for computed properties.
    var tabs: [Tab] {
        get { currentWorkspace?.tabs ?? [] }
        set { if let i = currentWorkspaceIndex { workspaces[i].tabs = newValue } }
    }
    var selectedTab: String? {
        get { currentWorkspace?.selectedTabID }
        set { if let i = currentWorkspaceIndex { workspaces[i].selectedTabID = newValue } }
    }

    /// A tab by id across ALL workspaces (ContentView mounts every workspace's tabs).
    func anyTab(_ tabID: String) -> Tab? {
        for ws in workspaces { if let t = ws.tabs.first(where: { $0.tabID == tabID }) { return t } }
        return nil
    }

    // MARK: Workspaces

    @discardableResult
    func newWorkspace() -> String {
        let tab = Tab(pane: Pane())
        let ws = Workspace(tabs: [tab], selectedTabID: tab.tabID)
        workspaces.append(ws)
        lastSwitchForward = true
        selectedWorkspaceID = ws.id
        save()
        refocusActiveTerminal()
        return ws.id
    }

    func selectWorkspace(_ id: String) {
        guard let to = workspaces.firstIndex(where: { $0.id == id }) else { return }
        if let from = currentWorkspaceIndex { lastSwitchForward = to >= from }
        selectedWorkspaceID = id
        if let ws = currentWorkspace,
           let pid = ws.tabs.first(where: { $0.tabID == ws.selectedTabID })?.focusedPaneID {
            didFocus(paneID: pid)   // viewing a finished workspace clears its need-to-check
        }
        refocusActiveTerminal()
    }

    func renameWorkspace(_ id: String, to title: String) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].userTitle = t.isEmpty ? nil : t
        save()
    }

    func reorderWorkspace(_ id: String, toIndex: Int) {
        guard let from = workspaces.firstIndex(where: { $0.id == id }),
              from != toIndex, workspaces.indices.contains(toIndex) else { return }
        let item = workspaces.remove(at: from)
        workspaces.insert(item, at: toIndex)
        save()
    }

    /// True if any pane in the workspace is a live agent — delete should confirm.
    func workspaceHasLiveAgent(_ id: String) -> Bool {
        guard let ws = workspaces.first(where: { $0.id == id }) else { return false }
        return ws.tabs.flatMap { $0.root.panes }.contains { $0.state != .shell }
    }

    func deleteWorkspace(_ id: String) {
        let oldIndex = workspaces.firstIndex { $0.id == id } ?? 0
        guard let remaining = removingWorkspace(id, from: workspaces) else { return } // last-one guard
        let wasSelected = selectedWorkspaceID == id
        workspaces = remaining
        if wasSelected {
            let next = max(0, min(oldIndex, workspaces.count - 1))
            selectedWorkspaceID = workspaces.indices.contains(next) ? workspaces[next].id : workspaces.first?.id
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func nextWorkspace() { cycleWorkspace(+1, wrap: true) }
    func prevWorkspace() { cycleWorkspace(-1, wrap: true) }
    /// Swipe steps stop at the ends (no wrap), unlike the cyclic keyboard cycle.
    func swipeToWorkspace(_ delta: Int) { cycleWorkspace(delta, wrap: false) }

    private func cycleWorkspace(_ delta: Int, wrap: Bool) {
        guard !workspaces.isEmpty, let i = currentWorkspaceIndex else { return }
        let n = workspaces.count
        let j = wrap ? ((i + delta) % n + n) % n : max(0, min(n - 1, i + delta))
        guard j != i else { return }
        selectWorkspace(workspaces[j].id)
    }

    // MARK: Tabs (current workspace)

    @discardableResult
    func newTab() -> String {
        guard let w = currentWorkspaceIndex else { return newWorkspace() }
        let tab = Tab(pane: Pane())
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        return tab.tabID
    }

    func select(tabID: String) {
        selectedTab = tabID
        guard let tab = tabs.first(where: { $0.tabID == tabID }) else { return }
        didFocus(paneID: tab.focusedPaneID)   // viewing a finished tab clears its need-to-check
    }

    func closeTab(_ tabID: String) {
        guard let w = currentWorkspaceIndex else { return }
        closeTabInWorkspace(w, tabID: tabID)
    }

    /// closeTab targeting a specific workspace; reseeds a fresh tab if it was the
    /// last one so a workspace is never empty (⌘W no longer closes the window).
    private func closeTabInWorkspace(_ w: Int, tabID: String) {
        let wasSelected = workspaces[w].selectedTabID == tabID
        workspaces[w].tabs.removeAll { $0.tabID == tabID }
        if workspaces[w].tabs.isEmpty {
            workspaces[w].reseedIfEmpty()
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        } else if wasSelected {
            workspaces[w].selectedTabID = workspaces[w].tabs.last?.tabID
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func closeSelected() { if let sel = selectedTab { closeTab(sel) } }

    // MARK: Keyboard navigation (tabs, current workspace)

    func selectIndex(_ oneBased: Int) {
        let i = oneBased - 1
        guard tabs.indices.contains(i) else { return }
        select(tabID: tabs[i].tabID)
    }

    func selectNext()     { cycle(+1) }
    func selectPrevious() { cycle(-1) }

    private func cycle(_ delta: Int) {
        guard !tabs.isEmpty,
              let cur = selectedTab,
              let i = tabs.firstIndex(where: { $0.tabID == cur }) else { return }
        select(tabID: tabs[(i + delta + tabs.count) % tabs.count].tabID)
    }

    /// Jump to the next pane that needs you — across ALL workspaces. revealPane
    /// switches workspace + tab + focus.
    func selectNextAttention() {
        var flat: [(ws: String, pane: String)] = []
        for ws in workspaces { for tab in ws.tabs { for pid in tab.paneIDs { flat.append((ws.id, pid)) } } }
        guard !flat.isEmpty else { return }
        let curPane = currentWorkspace.flatMap { ws in
            ws.tabs.first { $0.tabID == ws.selectedTabID }?.focusedPaneID
        }
        let start = flat.firstIndex { $0.ws == selectedWorkspaceID && $0.pane == curPane } ?? -1
        for off in 1...flat.count {
            let e = flat[(start + off) % flat.count]
            if let (w, t) = locatePane(e.pane, in: workspaces),
               workspaces[w].tabs[t].root.pane(e.pane)?.state.wantsAttention == true {
                revealPane(e.pane)
                return
            }
        }
        NSSound.beep()   // nothing needs you
    }

    // MARK: Management (current workspace)

    func rename(tabID: String, to title: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        tabs[i].userTitle = trimmed.isEmpty ? nil : trimmed
        save()
    }

    func reorder(tabID: String, toIndex: Int) {
        guard let from = tabs.firstIndex(where: { $0.tabID == tabID }),
              from != toIndex, tabs.indices.contains(toIndex) else { return }
        var arr = tabs
        let item = arr.remove(at: from)
        arr.insert(item, at: toIndex)
        tabs = arr
    }

    func commitOrder() { save() }

    /// True if `paneID` is the focused pane of the currently selected tab.
    func isFocusedSurface(paneID: String) -> Bool {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return false }
        return tab.focusedPaneID == paneID
    }

    /// cwd to seed a restored pane's surface (consumed once at surface creation).
    func cwd(forPane paneID: String) -> String? {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return nil }
        return workspaces[w].tabs[t].root.pane(paneID)?.cwd
    }

    // MARK: Feeds from libghostty (per-pane, ANY workspace via locatePane)

    /// Agent-state hook event. The lifecycle map + ordering guard are unchanged from
    /// the pre-workspaces version (see SPEC + ADR 0004); only pane lookup changed.
    func apply(event: String, detail: String, paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              let pane = workspaces[w].tabs[t].root.pane(paneID) else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) -> NO SUCH TAB")
            return
        }
        let cur = pane.state
        let midTurn = (cur == .working || cur == .blocked)
        var applied = true
        var newState = cur
        var newReason: String? = pane.reason
        var clearTitle = false
        func set(_ s: AgentState, _ reason: String? = nil) {
            newState = s
            newReason = reason
        }

        switch event {
        case "SessionStart":      clearTitle = true; set(.idle)      // drop shell title; the agent sets its own
        case "SessionEnd":        set(.shell)                         // agent gone
        case "UserPromptSubmit":  set(.working)                       // new turn, from any state
        case "Stop":              if midTurn { set(.needsCheck) } else { applied = false }
        case "StopFailure":       if midTurn { set(.error, detail.isEmpty ? "API error" : detail) } else { applied = false }
        case "PermissionRequest":
            if midTurn { set(.blocked, detail == "ExitPlanMode" ? "plan approval"
                                     : (detail.isEmpty ? "approval needed" : "approve \(detail)")) } else { applied = false }
        case "Elicitation":       if midTurn { set(.blocked, "input requested") } else { applied = false }
        case "SubagentStart":     if midTurn { set(.working, detail.isEmpty ? "subagent" : "subagent: \(detail)") } else { applied = false }
        case "PreToolUse":
            if !midTurn { applied = false }
            else if detail == "AskUserQuestion" { set(.blocked, "answer needed") }
            else if detail == "ExitPlanMode"    { set(.blocked, "plan approval") }
            else { set(.working) }
        case "PostToolUse", "PostToolUseFailure", "SubagentStop", "ElicitationResult":
            if midTurn { set(.working) } else { applied = false }
        default:                  applied = false
        }

        shepherdLog("event=\(event)\(detail.isEmpty ? "" : "[\(detail)]") tab=\(paneID.prefix(8)) "
            + (applied ? "\(cur.rawValue)->\(newState.rawValue)" : "\(cur.rawValue) (ignored: not mid-turn)"))

        if applied {
            _ = workspaces[w].tabs[t].root.updatePane(paneID) {
                if clearTitle { $0.title = "" }
                $0.state = newState
                $0.reason = newReason
            }
            if newState != cur, newState.wantsAttention,
               let updated = workspaces[w].tabs[t].root.pane(paneID) {
                notifyAttention(updated, inWorkspace: workspaces[w].id)
                playAttentionSound(for: newState)
            }
            updateDockBadge()
        }
    }

    private func shepherdLog(_ msg: String) {
        let path = "/tmp/shepherd-events.log"
        guard let data = (msg + "\n").data(using: .utf8) else { return }
        if let h = FileHandle(forWritingAtPath: path) {
            defer { try? h.close() }
            h.seekToEndOfFile()
            h.write(data)
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }

    /// OSC title (SET_TITLE action). Not persisted (only userTitle is).
    func setTitle(_ title: String, paneID: String) {
        guard !title.isEmpty, let (w, t) = locatePane(paneID, in: workspaces) else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.title = title }
    }

    /// Working directory (PWD action) — tracked so we can restore it on relaunch.
    func setCwd(_ cwd: String, paneID: String) {
        guard !cwd.isEmpty, let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].root.pane(paneID)?.cwd != cwd else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.cwd = cwd }
        save()
    }

    /// A pane's surface became first responder (a click). Move its tab's focus to it
    /// and clear its need-to-check. Clicks only reach the selected workspace/tab.
    func focusPane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].focusedPaneID != paneID else { return }
        workspaces[w].tabs[t].focusedPaneID = paneID
        didFocus(paneID: paneID)
    }

    /// Focus clears need-to-check → idle ONLY (never blocked/working).
    func didFocus(paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].root.pane(paneID)?.state == .needsCheck else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = .idle }
        updateDockBadge()
    }

    /// Close a single pane. Collapses the parent split to its sibling; if it was the
    /// tab's last pane, the tab closes (reseeding if it was the workspace's last tab).
    func closePane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        let sibling = workspaces[w].tabs[t].root.siblingLeaf(of: paneID)
        if let newRoot = workspaces[w].tabs[t].root.closing(paneID: paneID) {
            workspaces[w].tabs[t].root = newRoot
            if workspaces[w].tabs[t].focusedPaneID == paneID {
                workspaces[w].tabs[t].focusedPaneID = sibling ?? newRoot.firstLeafID ?? workspaces[w].tabs[t].focusedPaneID
            }
            if workspaces[w].tabs[t].zoomedPaneID == paneID { workspaces[w].tabs[t].zoomedPaneID = nil }
            save()
            updateDockBadge()
        } else {
            closeTabInWorkspace(w, tabID: workspaces[w].tabs[t].tabID)   // was the tab's last pane
        }
    }

    // MARK: Split / focus / zoom (current workspace, keyboard-driven)

    var selectedTabIsSplit: Bool {
        tabs.first(where: { $0.tabID == selectedTab })?.isSplit ?? false
    }

    func splitFocused(_ axis: SplitAxis) {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        let focused = tabs[i].focusedPaneID
        var newPane = Pane()
        newPane.cwd = tabs[i].root.pane(focused)?.cwd
        guard tabs[i].root.split(paneID: focused, axis: axis, newPane: newPane) else { return }
        tabs[i].focusedPaneID = newPane.paneID
        tabs[i].zoomedPaneID = nil
        save()
        refocusActiveTerminal()
    }

    func closeFocusedPane() {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return }
        closePane(tab.focusedPaneID)
    }

    func focusNeighbor(_ dir: FocusDirection) {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        guard tabs[i].zoomedPaneID == nil else { return }
        let rect = CGRect(origin: .zero, size: lastContentSize)
        if let id = tabs[i].root.neighbor(of: tabs[i].focusedPaneID, dir, in: rect) {
            tabs[i].focusedPaneID = id
            refocusActiveTerminal()
        }
    }

    func toggleZoom() {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        tabs[i].zoomedPaneID = tabs[i].zoomedPaneID == nil ? tabs[i].focusedPaneID : nil
        refocusActiveTerminal()
    }

    func setRatio(tabID: String, path: [Int], to ratio: Double) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].root.setRatio(at: path, to: ratio)
        save()
    }

    /// Notification routing / attention jump: select the owning WORKSPACE, focus the
    /// pane's tab + pane, clear need-to-check. Crosses workspace boundaries.
    func revealPane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        if let from = currentWorkspaceIndex { lastSwitchForward = w >= from }
        selectedWorkspaceID = workspaces[w].id
        workspaces[w].tabs[t].focusedPaneID = paneID
        workspaces[w].selectedTabID = workspaces[w].tabs[t].tabID
        didFocus(paneID: paneID)
        refocusActiveTerminal()
    }

    var attentionCount: Int { totalAttentionCount(in: workspaces) }

    // MARK: Attention surfacing (dock badge + notifications + sound)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    /// Fire a native notification when a pane needs you — while Shepherd is NOT
    /// frontmost OR the pane's workspace isn't the active one (a hidden-workspace
    /// agent has no visible sidebar dot to rely on).
    private func notifyAttention(_ pane: Pane, inWorkspace wsID: String) {
        let hidden = wsID != selectedWorkspaceID
        guard !NSApp.isActive || hidden else { return }
        let content = UNMutableNotificationContent()
        content.title = pane.displayTitle
        switch pane.state {
        case .blocked:    content.body = pane.reason ?? "needs you"
        case .needsCheck: content.body = "finished — needs a look"
        case .error:      content.body = "errored: \(pane.reason ?? "API error")"
        default:          return
        }
        content.userInfo = ["paneID": pane.paneID]
        content.sound = nil   // we play our own chime (playAttentionSound) — avoid a double
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "\(pane.paneID)-\(pane.state.rawValue)",
                                  content: content, trigger: nil))
    }

    private func playAttentionSound(for state: AgentState) {
        guard let sound = attentionSounds[state] else { return }
        sound.stop()
        sound.play()
    }

    // MARK: Persistence (workspaces.v1, with one-time v2 migration)

    private func save() {
        let state = snapshotState(workspaces, selectedWorkspaceID: selectedWorkspaceID)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }

    private func restore() -> Bool {
        let defaults = UserDefaults.standard
        var state: PersistedState?
        if let data = defaults.data(forKey: persistKey) {
            state = try? JSONDecoder().decode(PersistedState.self, from: data)
        } else if let legacy = defaults.data(forKey: legacyKey) {
            state = migrateLegacyTabs(legacy)   // one-time v2 → v1 wrap
        }
        guard let state, !state.workspaces.isEmpty else { return false }
        workspaces = buildWorkspaces(from: state)
        guard !workspaces.isEmpty else { return false }
        let i = workspaces.indices.contains(state.selectedWorkspaceIndex) ? state.selectedWorkspaceIndex : 0
        selectedWorkspaceID = workspaces[i].id
        save()   // re-persist in v1 form
        return true
    }
}
```

- [ ] **Step 2: Build the app — verify it compiles**

Run the app-build command. Expected: `** BUILD SUCCEEDED **`. (Fix any `cannot find` errors — they're real here, not SourceKit noise, since the file set didn't change.)

- [ ] **Step 3: Smoke-test (manual) — existing behavior unchanged**

Run the app (run command). Verify the pre-workspaces behavior still works (you'll have one implicit workspace, no switcher UI yet):
- New tab (⌘T), switch tabs (⌘1–9, ⌘⇧[ ]), rename, reorder, splits (⌘D/⌘⇧D), zoom (⌘⇧↩), close pane (⌘W).
- Start `claude` in a pane → sidebar dot goes idle→working→…; dock badge counts; backgrounding fires a notification.
- Quit and relaunch → tabs/splits/cwd restored (migrated from the old `shepherd.tabs.v2` into one workspace on first relaunch).

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(workspaces): make AgentStore workspace-backed

Storage swap to workspaces/selectedWorkspaceID; tabs/selectedTab computed over
the current workspace; socket per-pane methods route through locatePane (global
by construction); workspace ops; global attention; hidden-workspace notification
rule; persistence v1 + v2 migration. apply() logic + ordering guard unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Menu commands (⌘⇧N, ⌃⇥/⌃⇧⇥) + ⌘W reseed

**Files:**
- Modify: `spike/seam1/Sources/ShepherdApp.swift`

**Interfaces:**
- Consumes: `AgentStore.newWorkspace()`, `nextWorkspace()`, `prevWorkspace()`, `closeFocusedPane()`, `closeSelected()`, `selectedTabIsSplit` (Task 3).

- [ ] **Step 1: Change the ⌘W (Close Pane) action**

In `spike/seam1/Sources/ShepherdApp.swift`, replace the existing `Button("Close Pane") { … }` block with:

```swift
                Button("Close Pane") {
                    let s = AgentStore.shared
                    if s.selectedTabIsSplit { s.closeFocusedPane() }
                    else { s.closeSelected() }   // last tab reseeds; window close is the traffic light / ⌘Q
                }
                .keyboardShortcut("w", modifiers: .command)
```

- [ ] **Step 2: Add the workspace commands**

In the same `CommandGroup(after: .newItem)`, immediately after the `Button("New Tab") { … }.keyboardShortcut("t", modifiers: .command)` block, insert:

```swift
                Button("New Workspace") { AgentStore.shared.newWorkspace() }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("Next Workspace") { AgentStore.shared.nextWorkspace() }
                    .keyboardShortcut(.tab, modifiers: .control)
                Button("Previous Workspace") { AgentStore.shared.prevWorkspace() }
                    .keyboardShortcut(.tab, modifiers: [.control, .shift])
```

- [ ] **Step 3: Build — verify it compiles**

Run the app-build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Manual verification**

Run the app:
- `⌘⇧N` → the tab area swaps to a new workspace's single fresh tab (no switcher UI yet — verify by the tab list resetting to one tab).
- `⌃⇥` / `⌃⇧⇥` → cycles between the workspaces (wraps at the ends).
- `⌘W` on the *only* tab of a workspace → a fresh tab appears (window does NOT close).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/ShepherdApp.swift
git commit -m "feat(workspaces): menu commands (new/next/prev) + reseed on last-tab close

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Sidebar header (workspace name + plus) + switcher popover

**Files:**
- Modify: `spike/seam1/Sources/SidebarView.swift`
- Create: `spike/seam1/Sources/WorkspaceSwitcher.swift`

**Interfaces:**
- Consumes: `AgentStore.workspaces`, `selectedWorkspaceID`, `currentWorkspaceIndex`, `newWorkspace()`, `selectWorkspace(_:)`, `renameWorkspace(_:to:)`, `deleteWorkspace(_:)`, `workspaceHasLiveAgent(_:)`, `Workspace.displayName(index:)`, `Workspace.aggregateState`, `Theme`, `LeadingIcon` (existing in SidebarView).
- Produces: `struct WorkspaceSwitcher: View` (rows: dot + name, click-to-switch; inline rename; delete with confirm). Reorder drag is added in Task 8.

- [ ] **Step 1: Replace the sidebar header**

In `spike/seam1/Sources/SidebarView.swift`, add this state to `SidebarView` (next to the existing `@State private var draggingID`):

```swift
    @State private var showSwitcher = false
```

Then in `SidebarView.body`, replace the `Text("TABS") … .padding(.bottom, 6)` block with `header`:

```swift
            header
```

And add these computed properties to `SidebarView` (after `body`, before `footer`):

```swift
    private var header: some View {
        HStack(spacing: 8) {
            Button(action: { showSwitcher.toggle() }) {
                HStack(spacing: 4) {
                    Text(workspaceName)
                        .font(.ui(11, .semibold))
                        .tracking(0.6)
                        .foregroundStyle(Theme.textDim)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .popover(isPresented: $showSwitcher, arrowEdge: .bottom) {
                WorkspaceSwitcher(isPresented: $showSwitcher).environmentObject(store)
            }

            Spacer()

            Button(action: { store.newWorkspace() }) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("New Workspace (⌘⇧N)")
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
    }

    private var workspaceName: String {
        guard let i = store.currentWorkspaceIndex else { return "WORKSPACE" }
        return store.workspaces[i].displayName(index: i).uppercased()
    }
```

- [ ] **Step 2: Make `LeadingIcon` reusable from another file**

The switcher reuses the sidebar's status glyph, which is currently file-private. In `spike/seam1/Sources/SidebarView.swift`, change its declaration from `private struct LeadingIcon: View {` to `struct LeadingIcon: View {` (internal — `BreathingDot`, used only inside the same file, can stay `private`).

- [ ] **Step 3: Create the switcher**

Create `spike/seam1/Sources/WorkspaceSwitcher.swift`:

```swift
import SwiftUI
import AppKit

/// The custom (non-native) workspace dropdown: one row per workspace
/// (aggregate dot + name), click-to-switch. Inline rename; delete with a
/// confirmation when the workspace holds a live agent. Reorder-drag is added later.
struct WorkspaceSwitcher: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool

    @State private var renamingID: String?
    @State private var draft = ""
    @FocusState private var renameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { idx, ws in
                row(ws, index: idx)
            }
        }
        .padding(6)
        .frame(width: 240)
    }

    @ViewBuilder
    private func row(_ ws: Workspace, index: Int) -> some View {
        let isSelected = ws.id == store.selectedWorkspaceID
        HStack(spacing: 9) {
            LeadingIcon(state: ws.aggregateState)

            if renamingID == ws.id {
                TextField("name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.ui(13))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($renameFocused)
                    .onSubmit { commitRename(ws.id) }
                    .onExitCommand { renamingID = nil }
                    .onAppear { renameFocused = true }
            } else {
                Text(ws.displayName(index: index))
                    .font(.ui(13, isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if store.workspaces.count > 1 {
                    Button(action: { confirmDelete(ws) }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .help("Delete workspace")
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 6)
            .fill(isSelected ? Theme.raised : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture {
            guard renamingID != ws.id else { return }
            store.selectWorkspace(ws.id)
            isPresented = false
        }
        .contextMenu {
            Button("Rename") { beginRename(ws, index: index) }
            if store.workspaces.count > 1 {
                Button("Delete", role: .destructive) { confirmDelete(ws) }
            }
        }
    }

    private func beginRename(_ ws: Workspace, index: Int) {
        draft = ws.userTitle ?? ws.displayName(index: index)
        renamingID = ws.id
    }
    private func commitRename(_ id: String) {
        store.renameWorkspace(id, to: draft)
        renamingID = nil
    }

    /// Confirm only when the workspace holds a live agent (delete kills its PTYs).
    private func confirmDelete(_ ws: Workspace) {
        guard store.workspaceHasLiveAgent(ws.id) else { store.deleteWorkspace(ws.id); return }
        let alert = NSAlert()
        alert.messageText = "Delete this workspace?"
        alert.informativeText = "It has running agents. Closing it ends their sessions."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { store.deleteWorkspace(ws.id) }
    }
}
```

- [ ] **Step 4: Regenerate + build**

```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -8
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Manual verification**

Run the app:
- The header shows `WORKSPACE 1` with a chevron + a `+` on the right.
- `+` (or `⌘⇧N`) makes a new workspace; the header name updates.
- Click the name → popover lists all workspaces with a dot + name; click one → switches (popover closes, tab list + content change).
- Right-click a row → Rename / Delete; rename inline; delete a non-current empty workspace; deleting one with a running `claude` shows the confirm alert.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/SidebarView.swift spike/seam1/Sources/WorkspaceSwitcher.swift
git commit -m "feat(workspaces): sidebar workspace name + plus + switcher dropdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Mount all workspaces + switch animation

Keeps every workspace's surfaces mounted (so background-workspace agents keep running) and animates the switch: content cross-fades, the sidebar tab list slides directionally.

**Files:**
- Modify: `spike/seam1/Sources/ContentView.swift`
- Modify: `spike/seam1/Sources/SplitContainer.swift` (look up the tab across workspaces)
- Modify: `spike/seam1/Sources/SidebarView.swift` (slide the tab list)

**Interfaces:**
- Consumes: `AgentStore.workspaces`, `selectedWorkspaceID`, `lastSwitchForward`, `anyTab(_:)` (Task 3).

- [ ] **Step 1: Mount all workspaces' tabs + cross-fade (ContentView)**

In `spike/seam1/Sources/ContentView.swift`, replace the entire content `ZStack` expression — from the line `ZStack {` (the one containing `Theme.ground`) through the closing `})` of its trailing `.background(GeometryReader { … })` modifier — with the block below. (This subsumes the old `.frame(maxWidth:.infinity…)` and `.background(GeometryReader…)` modifiers, so don't leave duplicates.)

```swift
            // Every workspace's surfaces stay mounted (background agents keep
            // running); only the current workspace's selected tab is visible.
            ZStack {
                Theme.ground
                ForEach(store.workspaces) { ws in
                    ForEach(ws.tabs) { tab in
                        let visible = ws.id == store.selectedWorkspaceID && tab.tabID == ws.selectedTabID
                        SplitContainer(node: tab.root,
                                       tabID: tab.tabID,
                                       isTabSelected: visible,
                                       focusTick: store.focusTick,
                                       zoomedPaneID: tab.zoomedPaneID)
                            .opacity(visible ? 1 : 0)
                            .allowsHitTesting(visible)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.easeInOut(duration: 0.22), value: store.selectedWorkspaceID)  // cross-fade on switch
            .background(GeometryReader { geo in
                Color.clear
                    .onAppear { store.lastContentSize = geo.size }
                    .onChange(of: geo.size) { store.lastContentSize = $0 }
            })
```

- [ ] **Step 2: Look up the tab across workspaces (SplitContainer)**

In `spike/seam1/Sources/SplitContainer.swift`, in `SplitContainer.body`, replace:

```swift
        let tab = store.tabs.first { $0.tabID == tabID }
```
with:
```swift
        let tab = store.anyTab(tabID)
```

- [ ] **Step 3: Slide the sidebar tab list (SidebarView)**

In `spike/seam1/Sources/SidebarView.swift`, replace the existing `ScrollView { LazyVStack(spacing: TabRow.gap) { … } … }` block with the same `ScrollView` wrapped for a directional slide:

```swift
            ScrollView {
                LazyVStack(spacing: TabRow.gap) {
                    ForEach(store.tabs) { tab in
                        if tab.isSplit {
                            SplitTabGroup(tab: tab)
                        } else {
                            TabRow(tab: tab, draggingID: $draggingID, dragOffset: $dragOffset)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }
            .id(store.selectedWorkspaceID)   // new identity per workspace → transition fires
            .transition(.asymmetric(
                insertion: .move(edge: store.lastSwitchForward ? .trailing : .leading),
                removal:   .move(edge: store.lastSwitchForward ? .leading : .trailing)))
            .clipped()
            .animation(.easeInOut(duration: 0.25), value: store.selectedWorkspaceID)
```

> If the slide doesn't animate (the `.id`-driven transition can be finicky with
> `.animation(value:)`), the reliable fallback is to wrap the switch call sites in
> `withAnimation(.easeInOut(duration: 0.25)) { … }` — e.g. in `cycleWorkspace`,
> `selectWorkspace`, and `swipeToWorkspace` callers. Decide by the measured feel.

- [ ] **Step 4: Build — verify it compiles**

Run the app-build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Manual verification**

Run the app:
- Start `claude` in workspace 1, switch to workspace 2 (swipe not yet — use `⌃⇥` or the dropdown), let the agent finish: the dock badge increments and a notification fires **while you're on workspace 2** (hidden-workspace rule). `⌘⇧A` jumps back into workspace 1 and focuses that pane.
- Switching workspaces cross-fades the terminal area and slides the sidebar list left/right by direction.
- Confirm a `claude` running in a non-visible workspace keeps running (its state keeps advancing in `/tmp/shepherd-events.log`) — surfaces aren't torn down on switch.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/ContentView.swift spike/seam1/Sources/SplitContainer.swift spike/seam1/Sources/SidebarView.swift
git commit -m "feat(workspaces): mount all workspaces (background liveness) + switch animation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Two-finger swipe on the sidebar

A local scroll-wheel monitor, gated on the sidebar being hovered, turns a horizontal-dominant trackpad swipe into a prev/next workspace step (stops at the ends). Gating + horizontal-dominance check keep vertical tab-list scrolling intact.

**Files:**
- Modify: `spike/seam1/Sources/SidebarView.swift`
- Create: `spike/seam1/Sources/SidebarSwipe.swift`

**Interfaces:**
- Consumes: `AgentStore.swipeToWorkspace(_:)` (Task 3).
- Produces: `struct SidebarSwipe: NSViewRepresentable` — `init(hovering: Bool, onSwipe: @escaping (Int) -> Void)`.

- [ ] **Step 1: Create the swipe monitor**

Create `spike/seam1/Sources/SidebarSwipe.swift`:

```swift
import SwiftUI
import AppKit

/// Installs a local scroll-wheel monitor that converts a horizontal-dominant
/// trackpad swipe (while the sidebar is hovered) into a ±1 workspace step. Vertical
/// scrolls pass through untouched so the tab list still scrolls. Invisible — host it
/// in the sidebar's `.background`.
struct SidebarSwipe: NSViewRepresentable {
    var hovering: Bool
    var onSwipe: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        context.coordinator.onSwipe = onSwipe
        context.coordinator.install()
        return NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.hovering = hovering
        context.coordinator.onSwipe = onSwipe
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.remove()
    }

    final class Coordinator {
        var hovering = false
        var onSwipe: (Int) -> Void = { _ in }
        private var monitor: Any?
        private var accumX: CGFloat = 0
        private var armed = true

        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
                guard let self, self.hovering else { return e }
                if e.phase == .began { self.accumX = 0; self.armed = true }
                let dx = e.scrollingDeltaX, dy = e.scrollingDeltaY
                if abs(dx) > abs(dy) * 1.5 {                       // horizontal-dominant → workspace swipe
                    self.accumX += dx
                    if self.armed, abs(self.accumX) > 50 {
                        let dir = self.accumX < 0 ? 1 : -1        // swipe left → next workspace
                        let cb = self.onSwipe
                        DispatchQueue.main.async { cb(dir) }
                        self.armed = false                        // one switch per gesture
                    }
                    return nil                                    // consume horizontal swipe
                }
                if e.phase == .ended || e.phase == .cancelled { self.accumX = 0; self.armed = true }
                return e                                          // let vertical scroll reach the list
            }
        }

        func remove() { if let m = monitor { NSEvent.removeMonitor(m); monitor = nil } }
    }
}
```

- [ ] **Step 2: Host it in the sidebar, gated on hover**

In `spike/seam1/Sources/SidebarView.swift`, add state to `SidebarView`:

```swift
    @State private var sidebarHovering = false
```

On the outermost `VStack` in `SidebarView.body` (the one with `.background(Theme.ground)`), add these two modifiers right after `.background(Theme.ground)`:

```swift
        .onHover { sidebarHovering = $0 }
        .background(SidebarSwipe(hovering: sidebarHovering,
                                 onSwipe: { store.swipeToWorkspace($0) })
            .frame(width: 0, height: 0))
```

- [ ] **Step 3: Regenerate + build**

```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -8
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Manual verification**

Run the app with ≥2 workspaces:
- Two-finger swipe left/right **over the sidebar** → switches workspace (with the slide), stopping at the first/last (no wrap).
- Two-finger vertical scroll over the sidebar still scrolls the tab list (when it overflows).
- Swiping over the terminal area does NOT switch workspace.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/SidebarSwipe.swift spike/seam1/Sources/SidebarView.swift
git commit -m "feat(workspaces): two-finger sidebar swipe to switch workspace

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Switcher reorder-drag

Adds drag-to-reorder to the switcher rows (mirrors `TabRow`'s live-reorder gesture), so dropdown order = swipe/`⌃⇥` order.

**Files:**
- Modify: `spike/seam1/Sources/WorkspaceSwitcher.swift`

**Interfaces:**
- Consumes: `AgentStore.reorderWorkspace(_:toIndex:)`, `workspaces` (Task 3).

- [ ] **Step 1: Add drag state**

In `WorkspaceSwitcher`, add next to the existing `@State` properties:

```swift
    @State private var draggingID: String?
    @State private var dragOffset: CGFloat = 0

    private static let rowStride: CGFloat = 30   // 28 row height + 2 spacing
```

- [ ] **Step 2: Apply drag offset + gesture to the row**

In `WorkspaceSwitcher.row(_:index:)`, change the row container modifiers. Replace:

```swift
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 6)
            .fill(isSelected ? Theme.raised : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture {
            guard renamingID != ws.id else { return }
            store.selectWorkspace(ws.id)
            isPresented = false
        }
```
with:
```swift
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 6)
            .fill(isSelected ? Theme.raised : Color.clear))
        .contentShape(Rectangle())
        .offset(y: draggingID == ws.id ? dragOffset : 0)
        .zIndex(draggingID == ws.id ? 1 : 0)
        .onTapGesture {
            guard renamingID != ws.id else { return }
            store.selectWorkspace(ws.id)
            isPresented = false
        }
        .gesture(reorderGesture(ws.id))
```

- [ ] **Step 3: Add the reorder gesture**

Add this method to `WorkspaceSwitcher` (after `confirmDelete`):

```swift
    private func reorderGesture(_ id: String) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if draggingID == nil { draggingID = id }
                guard draggingID == id,
                      let from = store.workspaces.firstIndex(where: { $0.id == id }) else { return }
                dragOffset = value.translation.height
                let target = max(0, min(store.workspaces.count - 1,
                                        from + Int((dragOffset / Self.rowStride).rounded())))
                if target != from {
                    store.reorderWorkspace(id, toIndex: target)
                    dragOffset -= CGFloat(target - from) * Self.rowStride
                }
            }
            .onEnded { _ in draggingID = nil; dragOffset = 0 }
    }
```

- [ ] **Step 4: Build — verify it compiles**

Run the app-build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Manual verification**

Run the app with ≥3 workspaces. Open the dropdown, drag a row up/down → order changes live; close + reopen confirms it persisted; `⌃⇥` and swipe now follow the new order.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/WorkspaceSwitcher.swift
git commit -m "feat(workspaces): drag-to-reorder in the switcher dropdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Docs — ADR 0013 + CLAUDE.md + SPEC.md

**Files:**
- Create: `.claude/adr/0013-workspaces.md`
- Modify: `CLAUDE.md` (Shepherd's, at repo root)
- Modify: `SPEC.md`

- [ ] **Step 1: Write ADR 0013**

Create `.claude/adr/0013-workspaces.md`:

```markdown
# 0013. Workspaces: nested model, global attention

Status: Accepted
Date: 2026-06-28

## Context
SPEC §6 deferred workspaces. The model nests AgentStore → [Tab] → SplitNode →
Pane; we add an Arc-style level above tabs so each workspace owns an independent
set of tabs/panes. The defining constraint: Shepherd's "never babysit" promise
must survive — an agent in a hidden workspace still has to pull you back.

## Decision
**1. Nested `Workspace` owns its tabs** (not a flat `tabs` array tagged with a
`workspaceID`). A Workspace is to a Tab what a Tab is to its pane tree. `AgentStore`
holds `workspaces` + `selectedWorkspaceID`; `tabs`/`selectedTab` are computed
get/set views of the current workspace, so all pre-workspaces UI is unchanged.

**2. The socket/state machine is preserved verbatim.** Only pane *lookup* changes:
the per-pane methods (`apply`, `setTitle`, `setCwd`, `cwd(forPane:)`, `focusPane`,
`didFocus`, `closePane`, `revealPane`) use `locatePane`, which walks every
workspace. The `apply` switch + ordering guard (ADR 0004) are copied unchanged.

**3. Attention is global by construction.** Dock badge, `⌘⇧A`, and notifications
span all workspaces. New notification rule: fire when Shepherd isn't frontmost
**or** the pane's workspace isn't the active one (a hidden agent has no visible
sidebar dot). `revealPane`/`⌘⇧A` switch workspace + tab + focus.

**4. UX.** Sidebar header = workspace name (custom dropdown: switch / rename /
delete-with-confirm / drag-reorder) + a `+`. Two-finger horizontal swipe on the
sidebar switches (stops at the ends); `⌘⇧N` new, `⌃⇥`/`⌃⇧⇥` cycle (wrap). Switch
animates: content cross-fades, the sidebar list slides directionally. All other
keys (`⌘T`, `⌘1–9`, `⌘⇧[ ]`) stay scoped to the current workspace.

**5. Edge cases.** Closing a workspace's last tab reseeds a fresh tab (a workspace
is never empty; `⌘W` no longer closes the window — that's the traffic light / ⌘Q).
The last workspace can't be deleted.

## Consequences
- Persistence key `shepherd.tabs.v2` → `shepherd.workspaces.v1` (`PersistedState`:
  workspaces, each with tabs + selection-by-index, + selected workspace index).
  A one-time migration wraps existing v2 tabs into one default workspace. Selection
  persists by index (tab/workspace ids regenerate on restore).
- `ContentView` mounts every workspace's surfaces (opacity-gated) so
  background-workspace agents keep running.
- A full live-Metal-surface slide was judged jank-prone; the switch ships as a
  content cross-fade + sidebar slide (the accepted fallback in the spec).
- Supersedes the workspaces item in SPEC §6.

## Alternatives considered
- **Flat tabs tagged with `workspaceID`** — least churn to the state machine, but
  reorder/selection get fiddlier and the model is a loose foreign key rather than
  containment. Rejected for a muddier model.
- **Per-workspace (siloed) attention** — simpler, but throws away the core promise
  that agents you've set aside still pull you back. Rejected.
- **True horizontal slide of live terminal surfaces** — most Arc-like, but risks
  jank animating Metal layers. Deferred in favor of cross-fade + sidebar slide.
```

- [ ] **Step 2: Update SPEC.md**

In `SPEC.md` §6 (Deferred), remove `workspaces + persistence/restore · ` from the deferred list. Then add a line after the splits "shipped" note:

```markdown
> Workspaces **shipped** (Arc-style, nested model, global attention) — see
> [ADR 0013](.claude/adr/0013-workspaces.md).
```

- [ ] **Step 3: Update CLAUDE.md**

In `/Users/eshaannileshshah/Home/dev/tools/shepherd/CLAUDE.md`:

3a. In the "App source files" list, add entries for the new files:
```markdown
- `Workspace.swift` — **pure model**: a `Workspace` (id, `userTitle`, `tabs`, `selectedTabID`; `displayName`/`aggregateState`/`reseedIfEmpty`) + pure free helpers (`locatePane`, `removingWorkspace`, `totalAttentionCount`). No AppKit — in `ShepherdModelTests`.
- `Persistence.swift` — **pure model**: `PersistedTab`/`PersistedWorkspace`/`PersistedState` + `snapshotState`/`buildWorkspaces`/`migrateLegacyTabs` (v2→v1). In `ShepherdModelTests`.
- `WorkspaceSwitcher.swift` — the custom (non-native) workspace dropdown: switch / inline-rename / delete-with-confirm / drag-reorder.
- `SidebarSwipe.swift` — `NSViewRepresentable` installing a hover-gated scroll-wheel monitor; horizontal-dominant swipe → prev/next workspace.
```

3b. In the "Persistence" section, replace the store-key paragraph's `shepherd.tabs.v2` with `shepherd.workspaces.v1` and note: per workspace, its tabs (the recursive tree + ratios + userTitle/cwd) + selection-by-index; the store keeps `selectedWorkspaceID`; a one-time migration wraps a legacy `shepherd.tabs.v2` blob into one default workspace.

3c. In the keybindings table, add rows: `⌘⇧N` new workspace; `⌃⇥` / `⌃⇧⇥` next / previous workspace (wrap). Note `⌘W` now reseeds a fresh tab on the last tab instead of closing the window.

3d. In "Done vs deferred", move workspaces from deferred to **Done** with a pointer to [ADR 0013].

3e. Add to "Critical gotchas": **`store.tabs`/`selectedTab` are computed views of the current workspace** — socket/attention methods must use `locatePane`/iterate `workspaces` (a hidden-workspace pane isn't in `store.tabs`).

- [ ] **Step 4: Commit**

```bash
git add .claude/adr/0013-workspaces.md SPEC.md CLAUDE.md
git commit -m "docs(workspaces): ADR 0013 + SPEC/CLAUDE updates (workspaces shipped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Model tests pass: run the model-tests command → `** TEST SUCCEEDED **`, 32 tests, 0 failures.
- [ ] App builds: run the app-build command → `** BUILD SUCCEEDED **`.
- [ ] End-to-end manual pass:
  - Create 3 workspaces (`⌘⇧N`); each starts with one fresh tab.
  - Put a different `claude` agent in each; let agents in hidden workspaces block/finish → badge counts across all, notifications fire from hidden workspaces, `⌘⇧A` jumps across workspace boundaries.
  - Switch via dropdown, `⌃⇥`/`⌃⇧⇥` (wrap), and two-finger swipe (stops at ends) — content cross-fades, sidebar slides.
  - Rename / delete (with confirm on live agents; last-workspace guard) / drag-reorder in the dropdown.
  - Quit + relaunch → workspaces, tabs, splits, cwds, names, and selected workspace restored; an old single-workspace install migrates into "Workspace 1".
```
