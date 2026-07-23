# Empty workspaces

**Date:** 2026-07-23
**Branch:** `feature/empty-workspaces`
**Status:** design

## Problem

Today a workspace is *never* empty. `Workspace.reseedIfEmpty()` drops a fresh
tab whenever a workspace hits zero tabs — closing the last tab (⌘W /
close-tab) or dragging the last tab out to another folder immediately spawns a
new one. `⌘⇧N` also seeds a tab. The result is stray tabs the user didn't ask
for: a workspace you've cleared re-fills with an empty shell you now have to
close again.

## Goal

Let a workspace hold **zero tabs** and persist as an empty container. An empty
workspace is **not deleted** — it's a real workspace you can switch to, name,
collapse, and later open tabs in. This keeps the tab count down to what the
user actually wants open.

## Scope (decided)

- **Closing the last tab leaves the workspace empty** — no reseed. Applies to
  `closeTabInWorkspace` (⌘W / close-tab) and `moveTab`'s source cleanup (drag
  the last tab to another folder).
- **All workspaces may be empty at once** — the app can be fully tab-less; the
  content area shows an empty state.
- **`⌘⇧N` still seeds one tab** — unchanged. Empty workspaces only result from
  the user closing tabs.
- **Content-area empty state:** hint + a **New Tab** button (plus **New
  Worktree Tab…** when the workspace's default dir is a git work tree).

Out of scope / unchanged: `⌘⇧N` seeding; remote/mirror workspaces (an empty
tree just rides the existing `WorkspaceTree` broadcast, host-authoritative — no
special handling in v1); the control CLI (`ls`/`state` naturally report zero
tabs); first-launch seeding (a fresh install still gets one default
workspace + tab — an empty app only results from the user closing tabs).

## Design

### 1. Stop reseeding (`Workspace` + `AgentStore`)

- **Delete `Workspace.reseedIfEmpty()`.**
- **`AgentStore.closeTabInWorkspace`:** remove the `reseedIfEmpty()` branch.
  After `tabs.removeAll`, if the workspace is now empty set
  `selectedTabID = nil`; otherwise keep the existing "select the last tab if the
  closed one was selected" behavior. Still `refocusActiveTerminal()` (it
  tolerates no focused pane), `save()`, `updateDockBadge()`, `postPaneClosed`,
  `broadcastWorkspaceTree`.
- **`AgentStore.moveTab` source cleanup:** replace `reseedIfEmpty()` with the
  same "empty ⇒ `selectedTabID = nil`" handling for the source workspace.
- The now-empty workspace **stays selected** and shows the empty state — least
  surprising, matches "not deleted." Deletion remains a separate explicit
  action (folder right-click → Delete, still guarded so the last workspace
  can't be removed via `removingWorkspace`).

### 2. Persistence round-trip (`Persistence.swift`)

- **`buildWorkspaces`:** the current `guard !tabs.isEmpty else { return nil }`
  drops empty workspaces on restore — **remove that guard.** Build the
  workspace regardless; when `tabs` is empty, `selectedTabID` resolves to `nil`
  (the existing `tabs.first?.tabID` fallback already yields nil for an empty
  array). Keep the outer `compactMap` (a malformed *tab* can still drop to nil
  and be filtered), but a workspace with zero tabs must now survive.
- **`snapshotState`:** already tolerates an empty workspace — `selTab` defaults
  to `0`, which on restore fails `tabs.indices.contains(0)` and yields a nil
  selection. No change needed, but covered by a test.
- No schema/version bump: `PersistedWorkspace` shape is unchanged (an empty
  `tabs: []` is valid). Old blobs still decode.

### 3. Content-area empty state (`ContentView` + new `WorkspaceEmptyView`)

- In `terminalArea`, when the selected workspace has no visible tab
  (`store.selectedTab == nil`, i.e. `allMountedTabs` has no `visible` entry),
  render a centered **`WorkspaceEmptyView`** over `Theme.ground` instead of the
  bare ground.
- `WorkspaceEmptyView` contents: a muted hint line (`No tabs · ⌘T`), a **New
  Tab** button → `store.newTab()`, and a **New Worktree Tab…** button shown
  only when the selected workspace's default dir is a git work tree (reusing
  `WorktreeService`'s existing work-tree detection, checked off-main when the
  view appears; mirror workspaces gate on the wired `defaultPath` like the
  sidebar does) → the existing `store.newWorktreeTab(...)` prompt path.
- Styling per `Theme` tokens; controls `.focusable(false)` so focus stays on
  the terminal (per ADR 0009). The view is inert chrome — no new state model.

### 4. Sidebar — activating & showing an empty folder (`SidebarView`)

- **Activation gap:** today a workspace becomes *active* only by clicking one
  of its tabs; an empty folder has none. Fix: clicking an **empty** folder's
  header **selects that workspace** (`store.selectWorkspace(ws.id)`) so the
  content area shows its empty state, in addition to the normal collapse
  toggle. A non-empty folder header keeps its current toggle-only behavior.
- The folder still renders its header (chevron · aggregate dot · name ·
  hover-`+`). The aggregate dot for an empty workspace is `AgentState.rollUp([])
  == .shell` (neutral) — no change.
- Expanded with zero tab rows, show a single faint **`No tabs`** placeholder
  row (dimmed, non-interactive) so the folder doesn't look broken. The hover-`+`
  menu (New Tab / New Worktree Tab…) already lets the user add one.

## Testing

Pure-model coverage in `ShepherdModelTests` (UI verified at runtime by the user
per the ship ritual):

- **Persistence:** snapshot → build round-trip of a workspace with `tabs == []`
  preserves it as an empty workspace with `selectedTabID == nil` (regression
  guard against the removed `!tabs.isEmpty` drop). A mixed state (one empty +
  one non-empty workspace) restores both, selection intact.
- **Empty-on-close (model-level):** a `Workspace` whose `tabs` are cleared has
  `selectedTabID == nil` and `aggregateState == .shell`; `reseedIfEmpty` no
  longer exists (compile-level once deleted).
- **`removingWorkspace` last-workspace guard** still returns nil for the final
  workspace (unchanged behavior, re-asserted).

Runtime checks deferred to the user: close last tab → workspace stays, empty
state renders; New Tab / New Worktree Tab buttons work; clicking an empty
folder header activates it; empty workspace survives relaunch.

## Files touched

- `Workspace.swift` — delete `reseedIfEmpty()`.
- `AgentStore.swift` — `closeTabInWorkspace`, `moveTab` (drop reseed; nil the
  selection when empty).
- `Persistence.swift` — `buildWorkspaces` (remove the empty-drop guard).
- `ContentView.swift` — render `WorkspaceEmptyView` when no visible tab.
- `WorkspaceEmptyView.swift` — **new** content-area empty state (add to
  `project.yml` sources; `xcodegen generate`).
- `SidebarView.swift` — empty-folder header selects the workspace; `No tabs`
  placeholder row.
- `Tests/PersistenceTests.swift` (+ `WorkspaceTests.swift` if needed) — the
  round-trip + guard tests above.
- `CLAUDE.md` — update the ⌘W / "a workspace is never empty" notes once landed.
