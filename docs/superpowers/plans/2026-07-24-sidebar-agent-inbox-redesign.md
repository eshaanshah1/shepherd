# Sidebar Agent-Inbox Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the sidebar by citizen type — a persistent self-sorting **agent inbox** on top (needs-you agents as big cards, calm ones minimized), a fixed **minimized workspace organizer** below (terminals, act-in-place, worktree promoted), and a summonable **⌘K quick-jump** overlay.

**Architecture:** A new pure model (`AgentInbox.swift`) reduces `[Workspace]` into inbox items + the complementary organizer tabs — fully unit-tested, no AppKit. `AgentStore` exposes it as computed views. `SidebarView` renders the inbox above the existing folder list; folders are filtered to the organizer complement and default-collapsed. A new `QuickJumpView` overlay mirrors the existing `⌘/` cheatsheet pattern.

**Tech Stack:** Swift / SwiftUI / AppKit, xcodegen, `ShepherdModelTests` (XCTest). libghostty untouched (presentation only).

## Global Constraints

- **`xcodegen generate` after adding/removing any source file**, from `spike/seam1/`, or the file isn't compiled.
- **A new compiled source must be added to the target's explicit `sources:` list in `project.yml`** — pure-model files go in **both** the `Shepherd` app target and the `ShepherdModelTests` target.
- **Pure-model files carry no SwiftUI/AppKit imports** (they compile into `ShepherdModelTests`). `AgentInbox.swift` may import only `Foundation`.
- **libghostty C API calls stay on the main thread** — not touched here, but don't move existing calls.
- **Do not touch `claude-plugin/` or the hook protocol** — this is presentation only.
- **SourceKit lies in this repo**; `xcodebuild` is ground truth. Ignore "cannot find type" editor noise.
- Work stays on branch **`sidebar-agent-inbox-redesign`** (already created).
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Build (UI tasks' "test"):**
  ```sh
  cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- **Unit tests:**
  ```sh
  cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test -only-testing:ShepherdModelTests
  ```
- **Runtime UI verification is deferred to the user** (project convention — the app is the user's daily driver; never `killall`/relaunch it). Agents verify by compile + unit tests only.

**Model facts (verified in source, use verbatim):**
- `Pane` (`SplitTree.swift:21`): `paneID: String`, `var state: AgentState`, `var reason: String?`, `var cwd: String?`, `var displayTitle: String`, `var provisioning: Bool`. `AgentState.isAgent` = `state != .shell`; `AgentState.wantsAttention` = `blocked || needsCheck || error`.
- `AgentState.rollUp(_:)` priority: `blocked > error > needsCheck > working > idle > shell`.
- `Tab` (`Tab.swift:5`): `tabID: String`, `root: SplitNode`, `var isSplit: Bool` (`paneIDs.count > 1`), `func focusedPane() -> Pane?`, `root.panes -> [Pane]`, `var displayTitle`.
- `Workspace`: `id`, `tabs: [Tab]`, `var collapsed: Bool` (persisted, optional on disk), `displayName(index:)`, `aggregateState`.
- `AgentStore`: `@Published private(set) var workspaces: [Workspace]`, `func revealPane(_ paneID: String)`, `@Published var showShortcuts`, `func newTab(inWorkspace:cwd:sessionID:) -> String`, `func select(tabID:inWorkspace:)`.

---

### Task 1: Pure model — `AgentInbox.swift` + tests

**Files:**
- Create: `spike/seam1/Sources/AgentInbox.swift`
- Create: `spike/seam1/Tests/AgentInboxTests.swift`
- Modify: `spike/seam1/project.yml` (add `AgentInbox.swift` to the `Shepherd` **and** `ShepherdModelTests` `sources:` lists)

**Interfaces:**
- Produces:
  - `struct InboxItem: Equatable, Identifiable { let paneID, tabID, workspaceID, title, workspaceName, cwd: String?; let state: AgentState; let reason: String?; var id: String { paneID } }`
  - `func agentInbox(_ workspaces: [Workspace]) -> [InboxItem]` — every **single-pane tab** whose pane `state.isAgent`, across all workspaces, sorted by `rollUp` urgency then stable original order.
  - `extension Array where Element == InboxItem { var needsYou: [InboxItem]; var calm: [InboxItem] }`
  - `func organizerTabs(_ ws: Workspace) -> [Tab]` — tabs a folder renders: everything **except** single-pane agent tabs.

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/AgentInboxTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class AgentInboxTests: XCTestCase {

    // A single-pane tab in a given state.
    private func agentTab(_ id: String, _ state: AgentState, title: String? = nil, cwd: String? = nil) -> Tab {
        var p = Pane(paneID: "p-\(id)")
        p.state = state
        p.userTitle = title
        p.cwd = cwd
        return Tab(tabID: "t-\(id)", root: .leaf(p))
    }

    // A two-pane (split) tab; its panes' states given.
    private func splitTab(_ id: String, _ s1: AgentState, _ s2: AgentState) -> Tab {
        var a = Pane(paneID: "p-\(id)a"); a.state = s1
        var b = Pane(paneID: "p-\(id)b"); b.state = s2
        return Tab(tabID: "t-\(id)", root: .split(axis: .row, ratio: 0.5, first: .leaf(a), second: .leaf(b)))
    }

    private func ws(_ id: String, _ tabs: [Tab]) -> Workspace {
        Workspace(id: id, userTitle: id, tabs: tabs, selectedTabID: tabs.first?.tabID)
    }

    func test_collects_single_pane_agents_across_workspaces() {
        let workspaces = [
            ws("alpha", [agentTab("1", .blocked), agentTab("2", .shell)]),
            ws("beta",  [agentTab("3", .idle)]),
        ]
        let items = agentInbox(workspaces)
        XCTAssertEqual(items.map(\.paneID), ["p-1", "p-3"])   // shell excluded
        XCTAssertEqual(items.first?.workspaceName, "alpha")
    }

    func test_excludes_split_tabs_even_with_agents() {
        let items = agentInbox([ws("alpha", [splitTab("s", .blocked, .working), agentTab("1", .working)])])
        XCTAssertEqual(items.map(\.paneID), ["p-1"])          // split tab not lifted
    }

    func test_sorts_by_urgency_priority() {
        let workspaces = [ws("a", [
            agentTab("idle", .idle), agentTab("blk", .blocked),
            agentTab("chk", .needsCheck), agentTab("wrk", .working), agentTab("err", .error),
        ])]
        XCTAssertEqual(agentInbox(workspaces).map(\.paneID),
                       ["p-blk", "p-err", "p-chk", "p-wrk", "p-idle"])
    }

    func test_partition_needsYou_vs_calm() {
        let items = agentInbox([ws("a", [
            agentTab("blk", .blocked), agentTab("wrk", .working), agentTab("idle", .idle),
        ])])
        XCTAssertEqual(items.needsYou.map(\.paneID), ["p-blk"])
        XCTAssertEqual(items.calm.map(\.paneID), ["p-wrk", "p-idle"])
    }

    func test_organizerTabs_is_complement_no_overlap() {
        let w = ws("a", [agentTab("agent", .blocked), agentTab("term", .shell), splitTab("s", .working, .shell)])
        let organizer = Set(organizerTabs(w).map(\.tabID))
        let lifted = Set(agentInbox([w]).map(\.tabID))
        XCTAssertEqual(organizer, ["t-term", "t-s"])          // shell + split
        XCTAssertTrue(organizer.isDisjoint(with: lifted))     // no tab in both
        XCTAssertEqual(organizer.union(lifted), Set(w.tabs.map(\.tabID)))  // union = all
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run the unit-test command (Global Constraints). Expected: FAIL — `cannot find 'agentInbox' in scope` / `cannot find type 'InboxItem'`.

- [ ] **Step 3: Write `AgentInbox.swift`**

Create `spike/seam1/Sources/AgentInbox.swift`:

```swift
import Foundation

/// One lifted agent, shown in the sidebar's top inbox. Derived from `[Workspace]`
/// each render — never persisted. Only single-pane agent tabs become items
/// (split tabs stay in their folder; see `organizerTabs`).
struct InboxItem: Equatable, Identifiable {
    let paneID: String
    let tabID: String
    let workspaceID: String
    let title: String
    let workspaceName: String
    let cwd: String?
    let state: AgentState
    let reason: String?
    var id: String { paneID }
}

/// Rank for the inbox sort — mirrors `AgentState.rollUp` priority.
private func urgencyRank(_ s: AgentState) -> Int {
    switch s {
    case .blocked:    return 0
    case .error:      return 1
    case .needsCheck: return 2
    case .working:    return 3
    case .idle:       return 4
    case .shell:      return 5
    }
}

/// Every single-pane agent tab, across all workspaces, most-urgent first.
/// Stable within a rank (workspace order, then tab order).
func agentInbox(_ workspaces: [Workspace]) -> [InboxItem] {
    var items: [InboxItem] = []
    for (i, ws) in workspaces.enumerated() {
        for tab in ws.tabs where !tab.isSplit {
            guard let pane = tab.root.panes.first, pane.state.isAgent else { continue }
            items.append(InboxItem(
                paneID: pane.paneID, tabID: tab.tabID, workspaceID: ws.id,
                title: tab.displayTitle, workspaceName: ws.displayName(index: i),
                cwd: pane.cwd, state: pane.state, reason: pane.reason))
        }
    }
    return items.enumerated()
        .sorted { (urgencyRank($0.element.state), $0.offset) < (urgencyRank($1.element.state), $1.offset) }
        .map(\.element)
}

extension Array where Element == InboxItem {
    /// The loud ones — big cards.
    var needsYou: [InboxItem] { filter { $0.state.wantsAttention } }
    /// The quiet ones — one-line, tucked away.
    var calm: [InboxItem] { filter { !$0.state.wantsAttention } }
}

/// Tabs a workspace folder should render: everything a single-pane agent tab is NOT
/// (i.e. terminal single-pane tabs + all split tabs). Complement of `agentInbox`.
func organizerTabs(_ ws: Workspace) -> [Tab] {
    ws.tabs.filter { tab in
        if tab.isSplit { return true }
        return !(tab.root.panes.first?.state.isAgent ?? false)
    }
}
```

- [ ] **Step 4: Register the source in `project.yml`**

In `spike/seam1/project.yml`, add `Sources/AgentInbox.swift` to the explicit `sources:` list of **both** the `Shepherd` target and the `ShepherdModelTests` target (find the existing pure-model entries like `Sources/StopPolicy.swift` and add alongside).

- [ ] **Step 5: Run tests to verify they pass**

Run `xcodegen generate` then the unit-test command. Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/AgentInbox.swift spike/seam1/Tests/AgentInboxTests.swift spike/seam1/project.yml
git commit -m "feat(sidebar): pure agent-inbox model (lift/sort/partition/organizer complement)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `AgentStore` computed views + collapsed-by-default flip

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`
- Modify: `spike/seam1/Sources/Workspace.swift` (default `collapsed`)
- Test: `spike/seam1/Tests/PersistenceTests.swift`

**Interfaces:**
- Consumes: `agentInbox`, `organizerTabs` (Task 1).
- Produces on `AgentStore`: `var inbox: [InboxItem] { agentInbox(workspaces) }`.
- Produces: new `Workspace` instances default to `collapsed = true`.

- [ ] **Step 1: Add the computed view to `AgentStore`**

Near the existing computed `tabs`/`selectedTab` (around `AgentStore.swift:208`), add:

```swift
/// The top-of-sidebar agent inbox — single-pane agents across every workspace,
/// urgency-sorted. Derived; not persisted. (See AgentInbox.swift.)
var inbox: [InboxItem] { agentInbox(workspaces) }
```

- [ ] **Step 2: Flip the default `collapsed` for new workspaces**

Find where `Workspace.collapsed` defaults. In `Workspace.swift` the stored `var collapsed` should default to `true`:

```swift
var collapsed: Bool = true   // minimized-by-default (organizer); persisted values still win
```

Verify no call site constructs a `Workspace` expecting expanded-by-default that must stay expanded (search `Workspace(`); the migration/persistence path decodes the persisted flag, so existing users are unaffected — only brand-new workspaces start collapsed.

- [ ] **Step 3: Write/extend the persistence test**

In `spike/seam1/Tests/PersistenceTests.swift`, add:

```swift
func test_new_workspace_defaults_collapsed() {
    let w = Workspace(id: "x", userTitle: "x", tabs: [], selectedTabID: nil)
    XCTAssertTrue(w.collapsed)
}

func test_persisted_expanded_flag_still_decodes_expanded() throws {
    // An old blob that explicitly stored collapsed=false must round-trip to expanded.
    var w = Workspace(id: "x", userTitle: "x", tabs: [], selectedTabID: nil)
    w.collapsed = false
    let persisted = PersistedWorkspace(w, selectedIndex: nil)   // match the existing snapshot ctor
    let restored = persisted.collapsed
    XCTAssertEqual(restored, false)
}
```

Adjust the second test to the real `PersistedWorkspace` API if the ctor differs (check `Persistence.swift`); the intent is: an explicitly-persisted `collapsed=false` decodes to `false`.

- [ ] **Step 4: Run tests**

Run `xcodegen generate` + the unit-test command. Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/Workspace.swift spike/seam1/Tests/PersistenceTests.swift
git commit -m "feat(sidebar): store.inbox computed view + collapse-by-default workspaces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Agent-inbox UI zone (top of sidebar)

**Files:**
- Create: `spike/seam1/Sources/AgentInboxView.swift`
- Modify: `spike/seam1/Sources/SidebarView.swift` (mount the zone above the folder `ScrollView` content)
- Modify: `spike/seam1/project.yml` (add `AgentInboxView.swift` to the `Shepherd` target only — it imports SwiftUI)

**Interfaces:**
- Consumes: `store.inbox` (Task 2), `store.revealPane`, `InboxItem`, `Theme`, `AgentState.color`.
- Produces: `struct AgentInboxView: View` — renders needs-you cards + a collapsible "Running (N)" calm section.

- [ ] **Step 1: Create `AgentInboxView.swift`**

```swift
import SwiftUI

/// The top-of-sidebar agent inbox: needs-you agents as big cards, calm ones as
/// one-line rows under a collapsed "Running (N)" disclosure. Cross-workspace;
/// click routes via `revealPane`. Absent entirely when there are no agents.
struct AgentInboxView: View {
    @EnvironmentObject var store: AgentStore
    @State private var showCalm = false

    var body: some View {
        let items = store.inbox
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.needsYou) { card($0) }

                let calm = items.calm
                if !calm.isEmpty {
                    Button { showCalm.toggle() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: showCalm ? "chevron.down" : "chevron.right")
                                .font(.system(size: 8, weight: .semibold))
                            Text("Running \(calm.count)")
                                .font(.ui(10, .medium))
                        }
                        .foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    if showCalm { ForEach(calm) { oneLine($0) } }
                }

                Rectangle().fill(Theme.divider).frame(height: 1).padding(.top, 2)
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
        }
    }

    // Big card — needs-you agents.
    private func card(_ item: InboxItem) -> some View {
        Button { store.revealPane(item.paneID) } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(item.state.color).frame(width: 3, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text("\(item.workspaceName) · \(item.reason ?? item.state.rawValue)")
                        .font(.ui(11)).foregroundStyle(Theme.textDim).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6).padding(.horizontal, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(item.state.color.opacity(0.12)))
        }
        .buttonStyle(.plain).focusable(false)
    }

    // One-line row — calm agents.
    private func oneLine(_ item: InboxItem) -> some View {
        Button { store.revealPane(item.paneID) } label: {
            HStack(spacing: 8) {
                Circle().fill(item.state.color).frame(width: 6, height: 6)
                Text(item.title).font(.ui(12)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text(item.workspaceName).font(.ui(10)).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2).padding(.horizontal, 8)
        }
        .buttonStyle(.plain).focusable(false)
    }
}
```

- [ ] **Step 2: Mount it above the folder list in `SidebarView`**

In `SidebarView.body` (`SidebarView.swift:22`), insert `AgentInboxView()` between `topBar` and the `ScrollView`:

```swift
topBar

AgentInboxView()

ScrollView {
```

- [ ] **Step 3: Register + build**

Add `Sources/AgentInboxView.swift` to the `Shepherd` target `sources:` in `project.yml`. Run the build command. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```sh
git add spike/seam1/Sources/AgentInboxView.swift spike/seam1/Sources/SidebarView.swift spike/seam1/project.yml
git commit -m "feat(sidebar): agent-inbox zone — needs-you cards + collapsible calm rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Workspace organizer — render complement + promote worktree action

**Files:**
- Modify: `spike/seam1/Sources/SidebarView.swift` (`folderSection` body; `WorkspaceFolderHeader` worktree affordance)

**Interfaces:**
- Consumes: `organizerTabs(_:)` (Task 1).

- [ ] **Step 1: Render the organizer complement instead of all tabs**

In `folderSection` (`SidebarView.swift:98`), replace the `ForEach(ws.tabs)` iteration with the organizer complement, and only show "No tabs" when the workspace genuinely has zero tabs:

```swift
if !ws.collapsed {
    let organizer = organizerTabs(ws)
    if ws.tabs.isEmpty {
        Text("No tabs")
            .font(.ui(12, .regular))
            .foregroundStyle(Theme.textDim.opacity(0.7))
            .padding(.leading, 22).padding(.vertical, 3)
            .allowsHitTesting(false)
    } else {
        ForEach(organizer) { tab in
            Group {
                if tab.isSplit {
                    SplitTabGroup(tab: tab, workspaceID: ws.id)
                } else {
                    TabRow(tab: tab, workspaceID: ws.id,
                           draggingID: $draggingID, dragOffset: $dragOffset,
                           folderRegions: folderRegions,
                           dropTargetWorkspaceID: $dropTargetWorkspaceID)
                }
            }
        }
    }
}
```

(A folder whose only tabs are lifted agents renders just its header — intended.)

- [ ] **Step 2: Promote the worktree action out of the hover-only menu**

In `WorkspaceFolderHeader` (`SidebarView.swift:166`), the hover `+` is currently a `Menu` containing "New Tab" / "New Worktree Tab…". Add a **dedicated always-visible worktree glyph button** next to the `+` when `worktreeEnabled`, wired to the same `promptNewWorktree()`:

```swift
if worktreeEnabled {
    Button(action: { promptNewWorktree() }) {
        Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .medium))
    }
    .buttonStyle(.plain).focusable(false)
    .help("New worktree tab")
}
```

Place it in the header's trailing `HStack` beside the existing `+`/menu (keep the menu too — the glyph is the promoted shortcut). Verify `worktreeEnabled` and `promptNewWorktree()` are in scope (they are — same struct).

- [ ] **Step 3: Build**

Run the build command. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```sh
git add spike/seam1/Sources/SidebarView.swift
git commit -m "feat(sidebar): folders render organizer complement + visible worktree button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: ⌘K quick-jump overlay

**Files:**
- Create: `spike/seam1/Sources/QuickJumpView.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `@Published var showQuickJump = false`)
- Modify: `spike/seam1/Sources/ShortcutCatalog.swift` (add `.quickJump` id + command)
- Modify: `spike/seam1/Sources/ShepherdApp.swift` (`ShortcutActions.run` case)
- Modify: `spike/seam1/Sources/ContentView.swift` (mount overlay)
- Modify: `spike/seam1/project.yml` (add `QuickJumpView.swift` to `Shepherd`)
- Test: `spike/seam1/Tests/ShortcutCatalogTests.swift`

**Interfaces:**
- Consumes: `store.workspaces`, `store.revealPane`, `store.select(tabID:inWorkspace:)`, `organizerTabs`, `InboxItem`.
- Produces: `.quickJump` `ShortcutID`; `AgentStore.showQuickJump`.

- [ ] **Step 1: Add the shortcut to the catalog (test first)**

The catalog is unit-tested for full `ShortcutID` coverage. In `ShortcutCatalogTests.swift` that coverage test already iterates `ShortcutID.allCases` — adding a case will make it fail until the command exists. Add the id + command:

In `ShortcutCatalog.swift`, add `quickJump` to the `ShortcutID` enum (`:19`) in the `focusNav` group:

```swift
case find, reviewDiff, openEditor, saveFile, quickJump
```

and a command in `all` (in the `.focusNav` category block):

```swift
.init(id: .quickJump, title: "Quick Jump", key: "k", modifiers: .command, category: .focusNav, display: "⌘K"),
```

- [ ] **Step 2: Run catalog tests to confirm they pass (no dupe glyph/key, full coverage)**

Run the unit-test command. Expected: PASS (`⌘K` is unused; coverage now includes `.quickJump`). If a "no duplicate key" assertion trips, `⌘K` collides with nothing in the catalog — re-verify the display string is exactly `⌘K`.

- [ ] **Step 3: Add store flag**

In `AgentStore.swift`, beside `@Published var showShortcuts` (`:49`):

```swift
@Published var showQuickJump = false
```

- [ ] **Step 4: Wire the action**

In `ShepherdApp.swift` `ShortcutActions.run` (`:103`), add a case:

```swift
case .quickJump: s.showQuickJump.toggle()
```

- [ ] **Step 5: Create `QuickJumpView.swift`**

```swift
import SwiftUI

/// ⌘K quick-jump: fuzzy-filter across every workspace / tab / pane and jump
/// (revealPane), plus fire "new tab / new worktree tab in <ws>" actions. Overlay
/// HUD mirroring ShortcutCheatsheetView — Esc / click-out / ⌘K dismiss.
struct QuickJumpView: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    private struct Row: Identifiable { let id: String; let label: String; let sub: String; let run: () -> Void }

    private var rows: [Row] {
        var out: [Row] = []
        for (i, ws) in store.workspaces.enumerated() {
            let wsName = ws.displayName(index: i)
            for tab in ws.tabs {
                let pane = tab.focusedPane()
                let pid = pane?.paneID ?? ""
                out.append(Row(id: "jump-\(tab.tabID)", label: tab.displayTitle, sub: wsName) {
                    if !pid.isEmpty { store.revealPane(pid) } else { store.select(tabID: tab.tabID, inWorkspace: ws.id) }
                })
            }
            out.append(Row(id: "newtab-\(ws.id)", label: "New tab in \(wsName)", sub: "action") {
                _ = store.newTab(inWorkspace: ws.id)
            })
        }
        guard !query.isEmpty else { return out }
        let q = query.lowercased()
        return out.filter { ($0.label + " " + $0.sub).lowercased().contains(q) }
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.45).ignoresSafeArea()
                .contentShape(Rectangle()).onTapGesture { isPresented = false }
            card
        }
        .background(escHandler)
        .onAppear { fieldFocused = true; selection = 0 }
    }

    private var card: some View {
        let list = rows
        return VStack(alignment: .leading, spacing: 10) {
            TextField("Jump to workspace, tab, or action…", text: $query)
                .textFieldStyle(.plain).font(.ui(14))
                .focused($fieldFocused)
                .onChange(of: query) { _ in selection = 0 }
                .onSubmit { fire(list) }
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { idx, row in
                        HStack {
                            Text(row.label).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                            Spacer()
                            Text(row.sub).font(.ui(10)).foregroundStyle(Theme.textDim)
                        }
                        .padding(.vertical, 4).padding(.horizontal, 8)
                        .background(RoundedRectangle(cornerRadius: 6)
                            .fill(idx == selection ? Theme.working.opacity(0.18) : .clear))
                        .contentShape(Rectangle())
                        .onTapGesture { row.run(); isPresented = false }
                    }
                }
            }
            .frame(maxHeight: 320)
        }
        .padding(20).frame(width: 460)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface1)
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1)))
        .shadow(color: .black.opacity(0.35), radius: 30, y: 16)
    }

    private func fire(_ list: [Row]) {
        guard list.indices.contains(selection) else { return }
        list[selection].run(); isPresented = false
    }

    // Esc to dismiss (hidden .cancelAction), mirroring ShortcutCheatsheetView.
    private var escHandler: some View {
        Button("") { isPresented = false }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
    }
}
```

> Note: arrow-key selection is a nice-to-have; type-to-filter + Enter/click covers v1. If `ShortcutCheatsheetView`'s `escHandler` is `private`, replicate the same pattern here (shown above) rather than referencing it.

- [ ] **Step 6: Mount the overlay in `ContentView`**

In `ContentView.swift`, beside the existing `showShortcuts` overlay (`:92`), add:

```swift
.overlay {
    if store.showQuickJump {
        QuickJumpView(isPresented: $store.showQuickJump)
    }
}
.animation(.easeOut(duration: 0.12), value: store.showQuickJump)
```

- [ ] **Step 7: Register + build + test**

Add `Sources/QuickJumpView.swift` to the `Shepherd` target `sources:`. Run `xcodegen generate`, the build command (BUILD SUCCEEDED), then the unit-test command (PASS).

- [ ] **Step 8: Commit**

```sh
git add spike/seam1/Sources/QuickJumpView.swift spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/ShortcutCatalog.swift spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/ContentView.swift spike/seam1/Tests/ShortcutCatalogTests.swift spike/seam1/project.yml
git commit -m "feat(sidebar): ⌘K quick-jump overlay (fuzzy jump + new-tab actions)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs — CLAUDE.md sidebar section + shortcut table

**Files:**
- Modify: `CLAUDE.md` (Sidebar section + keybindings table)

- [ ] **Step 1: Update the Sidebar description**

In `spike/seam1`'s repo `CLAUDE.md`, revise the **Sidebar** section to describe the two-zone model: `AgentInboxView` (cross-workspace inbox, needs-you cards + collapsible calm rows, `store.inbox`/`AgentInbox.swift`), organizer folders rendering `organizerTabs` (complement — single-pane agent tabs are lifted out), collapse-by-default, the promoted worktree glyph, and the `⌘K` `QuickJumpView` overlay. Add `AgentInbox.swift` to the App-source-files list and the test list.

- [ ] **Step 2: Add ⌘K to the keybindings table**

Add a row: `| ⌘K | quick-jump overlay (fuzzy jump to any workspace/tab/pane + new-tab actions) |`.

- [ ] **Step 3: Commit**

```sh
git add CLAUDE.md
git commit -m "docs: sidebar two-zone (agent inbox + organizer) + ⌘K in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Agents zone (cards + calm minimized, cross-workspace, urgency sort) → Tasks 1, 3. ✓
- Single-pane-only lift, split tabs stay → Task 1 (`agentInbox` excludes `isSplit`), Task 4 (organizer keeps splits). ✓
- Workspaces organizer (fixed order, collapse-by-default, act-in-place, worktree promoted, complement render) → Tasks 2, 4. ✓
- Quick-jump ⌘K overlay (fuzzy jump + actions) → Task 5. ✓
- No duplication (agents in zone 1, terminals in zone 2, overlay transient) → Task 1 disjoint test + Task 4 complement render. ✓
- `revealPane` routing, keybinding via catalog, no persisted inbox state, default-collapsed migration-safe → Tasks 2, 5. ✓
- Edge cases: empty folders (Task 4 header-only), provisioning panes stay `.shell` (excluded by `isAgent`), mirror panes carry state (appear via `agentInbox`) — covered by the model; no extra task needed. ✓

**Placeholder scan:** none — every code step has concrete code; the one soft note (arrow-key selection) is explicitly scoped out of v1, not a placeholder.

**Type consistency:** `agentInbox`/`organizerTabs`/`InboxItem`/`.needsYou`/`.calm` used identically across Tasks 1→3→4→5. `store.inbox`, `store.showQuickJump`, `.quickJump` consistent. `revealPane(_:)`, `newTab(inWorkspace:)`, `select(tabID:inWorkspace:)` match verified `AgentStore` signatures.

**Open question resolved:** ⌘K is an overlay HUD (spec's recommended option; user said "go").
