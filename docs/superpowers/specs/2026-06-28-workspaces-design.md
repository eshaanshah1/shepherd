# Workspaces (Arc-style) — Design

**Status:** approved, pre-implementation
**Date:** 2026-06-28
**Branch:** `feat/workspaces-arc-style`
**Related:** [ADR 0012 (pane splitting)](../../../.claude/adr/0012-pane-splitting-panes-as-agents.md), [SPEC §6 deferred](../../../SPEC.md). A new **ADR 0013** records the load-bearing decisions here.

---

## 1. Goal

Add **workspaces** to Shepherd, behaving like Arc browser workspaces: each
workspace holds its **own independent set of tabs and panes**. The sidebar
header (today the static `TABS` label) becomes the **current workspace's name**.
You switch workspaces by **two-finger horizontal swipe on the sidebar**, by a
**custom dropdown** opened from the workspace name, or by keyboard. You create a
workspace with a **`+` button** in the header or a hotkey.

Crucially, Shepherd's "never babysit your agents" promise must survive
workspaces: **an agent in a workspace you are not currently viewing still pulls
you back** (badge, notification, jump-to-alert) exactly as if it were in the
visible workspace.

## 2. Non-goals (v1)

- Per-workspace settings/theme/cwd defaults.
- Moving a tab between workspaces (drag a tab across workspaces). Deferred.
- Workspace icons/colors beyond the attention dot.
- Multi-window (still single-window; unchanged from current scope).
- Stable creation-ordinal default names (we use index-based defaults — see §4).

---

## 3. Architecture overview

Today the model nests **`AgentStore` → `[Tab]` → `SplitNode` pane tree → `Pane`**.
Workspaces add **one level above tabs**:

```
AgentStore
  └─ workspaces: [Workspace]            (NEW level)
       └─ tabs: [Tab]                    (unchanged type)
            └─ root: SplitNode           (unchanged)
                 └─ Pane                  (unchanged)
```

A `Workspace` is to `Tab` exactly what a `Tab` is to its pane tree: a named
container that owns its children and remembers which child is selected. This is
the **nested model** (chosen over a flat `tabs` array tagged with a
`workspaceID`) because reorder and selection become trivially per-workspace and
the model is containment, not a loose foreign key.

The deliberate constraint, honored throughout: **the socket→state machinery and
its ordering guard ([ADR 0004](../../../.claude/adr/0004-plugin-protocol-and-ordering.md)) must not change.**
Only *where a pane is found* changes (a new locator that walks all workspaces);
the `apply` decision logic is byte-for-byte the same.

---

## 4. Data model

```swift
/// One workspace owns an independent set of tabs (each a pane tree) plus which
/// tab is selected. To a Tab, a Workspace is what a Tab is to its pane tree.
struct Workspace: Identifiable {
    let id: String
    var userTitle: String?        // nil → "Workspace N" by current index
    var tabs: [Tab]
    var selectedTabID: String?    // restored when this workspace is switched in

    /// Default name is index-based (computed by the caller that knows position).
    func displayName(index: Int) -> String {
        userTitle?.isEmpty == false ? userTitle! : "Workspace \(index + 1)"
    }
}
```

- **`Tab` is unchanged.** It already carries `focusedPaneID` and `zoomedPaneID`,
  so per-tab focus and zoom survive a workspace switch automatically.
- **Default names are index-based** (`Workspace 1/2/3`), so there is no stored
  counter. Tradeoff: deleting "Workspace 1" renumbers the rest. A rename sets
  `userTitle` and wins permanently. (If stable creation-ordinal names are wanted
  later, add a stored `seq`; out of scope for v1.)
- `Workspace` and all list-mutation/locator logic stay **AppKit-free** so they
  are covered by the pure `ShepherdModelTests` target (§11).

---

## 5. `AgentStore` changes

### 5.1 Storage and current-workspace accessors

Replace flat `tabs`/`selectedTab` storage with:

```swift
@Published private(set) var workspaces: [Workspace] = []
@Published var selectedWorkspaceID: String?
```

`store.tabs` and `store.selectedTab` become **computed get/set over the current
workspace**, so every existing view (`SidebarView`, `ContentView`, `TabRow`,
`SplitTabGroup`) keeps reading them unchanged:

```swift
var tabs: [Tab] {
    get { currentWorkspace?.tabs ?? [] }
    set { if let i = currentWorkspaceIndex { workspaces[i].tabs = newValue } }
}
var selectedTab: String? {
    get { currentWorkspace?.selectedTabID }
    set { if let i = currentWorkspaceIndex { workspaces[i].selectedTabID = newValue } }
}
```

Because `workspaces` is `@Published`, mutating a nested `tabs`/`selectedTabID`
fires SwiftUI updates as before.

### 5.2 The locator (the only change to per-pane methods)

```swift
/// Find the (workspace, tab) owning a pane, across ALL workspaces. Correlation
/// is by pane id — the socket knows nothing about workspaces.
private func locate(_ paneID: String) -> (ws: Int, tab: Int)? { … }
```

These seven methods switch their `tabs.firstIndex { $0.paneIDs.contains(paneID) }`
lookup to `locate(paneID)` and otherwise keep their exact logic:
`apply`, `setTitle`, `setCwd`, `focusPane`, `didFocus`, `closePane`, `revealPane`.

> The `apply` switch statement, the `midTurn` guard, and the
> need-to-check/blocked rules are **unchanged**. Global attention falls out for
> free: the locator and the attention loops span every workspace.

### 5.3 New workspace operations

- `newWorkspace()` — append a workspace seeded with **one fresh tab** (mirrors
  the first-launch `newTab()`), select it. Bound to `+` and `⌘⇧N`.
- `selectWorkspace(_ id:)` — set `selectedWorkspaceID`; clears need-to-check on
  the switched-in workspace's focused pane (mirrors `select(tabID:)`'s
  `didFocus`).
- `renameWorkspace(_ id:, to:)` — sets `userTitle` (empty → nil).
- `reorderWorkspace(_ id:, toIndex:)` — drag in the dropdown; also changes
  swipe/`⌃⇥` order.
- `deleteWorkspace(_ id:)` — remove it and tear down its panes' surfaces.
  Guarded so the **last remaining workspace cannot be deleted**. After delete,
  select the previous workspace (or the first). **Confirm** before deleting if
  the workspace contains any live agent (any pane not in `.shell`), since delete
  kills those PTYs.
- `nextWorkspace()` / `prevWorkspace()` — **wrap** (matches existing `⌘⇧[ ]`
  tab cycling). Bound to `⌃⇥` / `⌃⇧⇥`.
- `swipeToWorkspace(delta:)` — like next/prev but **stops at the ends** (no
  wrap); called by the sidebar swipe.

---

## 6. Attention stays global

The whole point of Shepherd survives workspaces: attention aggregates over
**every workspace's tabs' panes**, not just the visible one.

- `attentionCount`, the dock badge, and `selectNextAttention` (`⌘⇧A`) iterate all
  workspaces.
- `selectNextAttention` and `revealPane` (notification click) now **also set
  `selectedWorkspaceID`** to the target pane's workspace, then select its tab and
  focus the pane — so jumping to an alert crosses workspace boundaries.

### 6.1 Notification rule change

Today `notifyAttention` fires only when `!NSApp.isActive` (app not frontmost),
because when Shepherd is frontmost the sidebar dot + badge are enough. With
workspaces, an agent in a **hidden** workspace has no visible sidebar dot. So:

> Fire a notification when **`!NSApp.isActive` OR the pane's workspace is not the
> active workspace.**

Everything else about `notifyAttention` (dedupe id, our own chime, body text per
state) is unchanged.

---

## 7. Sidebar UI

### 7.1 Header → workspace switcher + `+`

Replace the static `Text("TABS")` header with a row:

```
┌──────────────────────────────┐
│  WORKSPACE 1            +     │   ← name = button → dropdown;  + = newWorkspace()
├──────────────────────────────┤
│  ▌ pane 1                     │   ← unchanged tab list (current workspace)
│  ▌ pane 2                     │
│    tab 4                      │
└──────────────────────────────┘
```

- The **name** is a `.plain` button (kept `.focusable(false)` per
  [ADR 0009](../../../.claude/adr/0009-sidebar-custom-rows-not-list.md)) that
  toggles the switcher popover. Styled like the old `TABS` label (uppercase
  tracking) but showing `currentWorkspace.displayName(index:)`.
- The **`+`** is a `.plain`, `.focusable(false)` button → `newWorkspace()`.
- The tab list (`ScrollView` of `TabRow`/`SplitTabGroup`) is **unchanged** — it
  renders `store.tabs`, which now resolves to the current workspace.

### 7.2 Two-finger swipe

A thin `NSViewRepresentable` ("WorkspaceSwipeCatcher") layered over the sidebar
catches **horizontal two-finger scroll** (precise scrolling deltas) and maps a
committed horizontal gesture to `swipeToWorkspace(delta:)`:

- Accumulate `scrollingDeltaX` across a gesture phase; commit one workspace step
  when the accumulated delta passes a threshold, then disarm until the phase
  ends/restarts (one switch per swipe).
- **Deadzone:** only treat as a workspace swipe when `|deltaX|` dominates
  `|deltaY|` (e.g. ratio > ~1.5) — so vertical tab-list scrolling never triggers
  a switch and vice versa.
- **Stops at the ends** (no wrap) — `swipeToWorkspace` clamps.

---

## 8. Switcher dropdown

A custom popover (not macOS-native) anchored to the workspace name. Each row is
**attention dot + workspace name**, click-to-switch. Per-row management:

- **Rename** — inline `TextField` edit (same pattern as `TabRow`'s rename;
  `endEditing()` hands first responder back to the terminal).
- **Delete** — trailing affordance; obeys the last-workspace guard and the
  live-agent confirmation (§5.3).
- **Reorder** — drag rows to reorder (also changes swipe/`⌃⇥` order).

The attention dot reuses the tab roll-up logic: a workspace's dot shows the most
important state across all its panes (blocked > error > needsCheck > working >
idle > shell), so you can see which *hidden* workspace needs you without
switching. **No "new workspace" entry** here — that is the `+` button and `⌘⇧N`.

---

## 9. Content area + slide animation

`ContentView` keeps **all surfaces across all workspaces mounted** (opacity 0
when hidden) so **background-workspace agents keep running** — the same principle
as today's all-tabs-mounted `ZStack`, now spanning every workspace. The `ZStack`
iterates all workspaces' tabs; only the current workspace's selected tab is
visible and hit-testable.

On switch, the outgoing and incoming workspaces' visible surfaces animate a
**directional horizontal slide** (direction from old vs. new workspace index);
the sidebar tab list slides with it.

> **Known risk (stated honestly):** sliding *live* libghostty Metal surfaces may
> be janky. **Fallback:** slide the sidebar list (cheap pure SwiftUI) and
> **cross-fade** the terminal content — same directional cue without animating a
> Metal layer's offset. The implementation plan picks based on measured feel;
> either way the switch is animated, not instant.

---

## 10. Keybindings

| Keys | Action |
|---|---|
| `⌘⇧N` | new workspace (seeds one fresh tab) |
| `⌃⇥` / `⌃⇧⇥` | next / previous workspace (**wraps**) |

Unchanged, now **scoped to the current workspace**: `⌘T` (new tab), `⌘1–9` (tab
N), `⌘⇧[ ]` (prev/next tab), `⌘W` (close pane→tab→…, see §12), splits/zoom/focus,
`⌘⇧A` (jump to alert — now crosses workspaces, §6).

`⌃⇥` is captured at the menu level so it never leaks into the terminal/TUIs.
Keyboard cycling **wraps** (cyclic idiom, matching `⌘⇧[ ]`); swipe **stops at the
ends** (spatial idiom) — a deliberate, documented difference.

---

## 11. Persistence + migration

- New key **`shepherd.workspaces.v1`**: `[PersistedWorkspace]` where
  `PersistedWorkspace { userTitle: String?, selectedTabID: String?, tabs: [PersistedTab] }`,
  plus a stored `selectedWorkspaceID`. `PersistedTab` is unchanged.
- **Restore** rebuilds workspaces in order; panes decode as **fresh ids + `.shell`**
  (unchanged `Pane.Codable` behavior — live agent state and zoom never survive a
  restart).
- **Migration:** on launch, if `shepherd.workspaces.v1` is absent but the old
  `shepherd.tabs.v2` exists, wrap those tabs into **one default workspace**
  (`userTitle = nil` → "Workspace 1") and select it. Going forward only the new
  key is written; the old key is read once for migration and otherwise ignored.
- If neither key exists (fresh install), create one workspace with one tab
  (mirrors today's `if !restore() { newTab() }`).

---

## 12. Edge cases

- **Close the last tab in a workspace** (`⌘W` cascade: pane → tab → …): if it was
  the workspace's last tab, **reseed a fresh tab**. A workspace is never empty,
  and `⌘W` **no longer closes the window**. Window close stays on the traffic
  light / `⌘Q`. *(This is a deliberate change from today's "last tab → close
  window".)*
- **Delete the only workspace:** blocked by the guard.
- **Delete a workspace with live agents:** confirm first (§5.3); on confirm, its
  panes' surfaces are torn down (PTYs end).
- **Switch-in restores selection:** the switched-in workspace's `selectedTabID`,
  and each of its tabs' own `focusedPaneID`/`zoomedPaneID`.
- **Notification click for a hidden-workspace agent:** `revealPane` switches
  workspace, selects the tab, focuses the pane, clears need-to-check.

---

## 13. Testing + ADR

**Pure-model tests (`ShepherdModelTests`)** — keep `Workspace` + list/locator
logic AppKit-free and cover:

- add / select / rename / reorder a workspace;
- **last-workspace delete guard**;
- `locate(paneID)` finds panes across multiple workspaces;
- **reseed-on-last-tab-close** keeps the workspace at ≥1 tab;
- `selectWorkspace` restores `selectedTabID`;
- **migration**: a `shepherd.tabs.v2` blob decodes into one default workspace;
- attention aggregation counts panes across all workspaces.

**ADR 0013** — record: nested `Workspace` model (vs. flat tag), global attention
+ the notification rule change, swipe-stops / keyboard-wraps, reseed-on-last-tab,
and the live-surface slide risk + fallback.

**Manual verification** — multi-workspace agent attention (badge/notification
from a hidden workspace), swipe + slide feel, dropdown rename/delete/reorder,
migration from an existing install, restart restore.

---

## 14. File-by-file impact (orientation, not a plan)

- `Workspace.swift` *(new)* — the struct + pure list/locator helpers.
- `AgentStore.swift` — storage swap, computed `tabs`/`selectedTab`, `locate`,
  workspace ops, global attention, notification rule, persistence v1 + migration.
- `SidebarView.swift` — header → switcher button + `+`; swipe catcher; the
  switcher popover (rename/delete/reorder) — possibly a new
  `WorkspaceSwitcher.swift`.
- `ContentView.swift` — mount all workspaces' surfaces; slide/cross-fade on
  switch.
- `ShepherdApp.swift` — `⌘⇧N`, `⌃⇥`, `⌃⇧⇥` menu commands.
- `Tests/SplitTreeTests.swift` (or a new `WorkspaceTests.swift`) — §13 coverage.
- `.claude/adr/0013-workspaces.md` *(new)*; `CLAUDE.md` + `SPEC.md` updated
  (workspaces moves from deferred to shipped).
