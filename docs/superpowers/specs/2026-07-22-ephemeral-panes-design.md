# Ephemeral Panes — Design

**Date:** 2026-07-22
**Status:** Approved design, pre-implementation
**Branch:** `ephemeral-panes`

## Summary

Ephemeral panes are lightweight scratch terminals that belong to **no workspace**
and take **no sidebar space**. Summoned by a global hotkey, one appears as a
floating **overlay** card inside the Shepherd window; clicking away collapses it to
a bottom-right **picture-in-picture (PiP)** thumbnail (up to 5). Clicking a PiP
brings it back to the overlay. They are throwaway by spirit but not by lifecycle —
never auto-killed, destroyed only on explicit close. `claude` can run inside one and
it is fully attention-tracked (state dot, dock badge, notifications, ⌘⇧A). They
persist across restart and mirror to remote clients as a synthetic **"Temp Tabs"**
folder.

Think "mini Arc windows": transient-feeling, always one active overlay, the rest
tucked into PiP.

## Motivation

Today every agent/terminal lives in a workspace → tab → pane tree, occupies a
sidebar row, and participates in the accordion. That's the right model for tracked,
long-running work. It's heavyweight for a quick "let me just run one thing" — you
have to make a tab, it clutters the sidebar, and closing it is ceremony. Ephemeral
panes are the fast path: hotkey → scratch shell → glance → tuck away or close.

## Decisions (resolved during brainstorming)

| # | Question | Decision |
|---|---|---|
| 1 | Trigger & content | Global hotkey (**⌘⌥N**) → a plain **shell** |
| 2 | Starting directory | **Always home (`~`)** — detached scratch space |
| 3 | Destroy trigger | **Explicit close only** (⌘W while overlay up / close button); never auto-reaped |
| 4 | Collapse to PiP | **Auto on blur** (click away) **+ manual** minimize button + Esc; only one overlay active at a time |
| 5 | PiP cap | **5 max; block the 6th summon** (beep + brief flash, no-op) |
| 6 | Agent-state tracking | **Full attention** — state dot on PiP + dock badge + notifications + ⌘⇧A |
| 7 | Persistence | **Yes** — restore as PiPs on launch (cwd + `sessionID`), like tabs |
| 8 | Remote/phone | **Wire the mirror now** — synthetic "Temp Tabs" workspace over `WorkspaceTree` |
| 9 | Window model | **In-window SwiftUI overlays** (overlay + PiP row layered over the terminal area) |

## Non-goals (v1)

- **No splitting** an ephemeral pane — each is exactly one pane.
- **No real floating NSPanels** — in-window overlays only (can't float over other apps).
- **No spawning from the phone beyond the normal tab affordance** — the client's
  new-tab into "Temp Tabs" routes to `spawnEphemeral`, but no phone-specific UI.
- **No auto-reaping / idle timeout.**

## Architecture

### 1. Model (`EphemeralPane.swift`, pure model, unit-tested)

```swift
struct EphemeralPane: Identifiable {
    var pane: Pane          // reuses cwd / state / sessionID / displayTitle / userTitle
    var collapsed: Bool     // true = PiP thumbnail, false = the overlay
    var id: String { pane.id }
}

let ephemeralPaneCap = 5
```

Single-pane by construction — no `SplitNode`, `Tab`, or `Workspace` around it. All
per-pane behavior (cwd, state, session resume, display title priority) reuses the
existing `Pane`.

Pure helpers in this file (so they're testable without AppKit):
- `canSpawnEphemeral(count:) -> Bool` — `count < ephemeralPaneCap`.
- collapse/expand transforms that enforce **the single-overlay invariant** (expanding
  index `i` sets `collapsed = true` on all others).
- `ephemeralAttentionCount(_:) -> Int` — panes whose `state.wantsAttention`.

### 2. Store (`AgentStore`)

New state:
```swift
@Published var ephemeralPanes: [EphemeralPane] = []
@Published var expandedEphemeralID: String? = nil   // the single overlay, nil = all PiP
```

New methods:
- `spawnEphemeral()` — guard `canSpawnEphemeral`; else `NSSound.beep()` + set a
  transient flag driving a PiP-row flash. Otherwise: make `Pane(cwd: homeDir)`,
  collapse the current overlay, append un-collapsed, set `expandedEphemeralID`.
- `expandEphemeral(_ id:)` / `collapseEphemeral(_ id:)` — maintain the invariant +
  update `expandedEphemeralID`.
- `closeEphemeral(_ id:)` — remove from array, drop the surface (PTY dies), clear
  `expandedEphemeralID` if it matched, then `save()` + `broadcastEphemeralTree()`.

**Socket bridge:** `apply(event:detail:paneID:…)` currently resolves the pane via
`locatePane(_:in: workspaces)`. Extend: on miss, look in `ephemeralPanes`; if found,
run the **same** `StopPolicy.applyEvent` against that pane's state, then surface
(badge / notification / PiP dot). `didFocus` similarly clears an ephemeral pane's
need-to-check when its overlay is opened.

### 3. Attention integration

Every cross-workspace aggregation additionally folds in `ephemeralPanes`:
- `attentionCount` (dock badge) = `totalAttentionCount(in: workspaces) + ephemeralAttentionCount(ephemeralPanes)`.
- `anyAgentBusy` — OR in ephemeral busy panes (feeds the sleep guard).
- Notifications — `notifyAttention` fires for ephemeral panes too (a backgrounded
  ephemeral agent going blocked/done still pings you).
- `selectNextAttention` (⌘⇧A) — include ephemeral panes in the ring; landing on one
  **expands its overlay** (not `revealPane`, which is workspace/tab-scoped).

### 4. UI (`EphemeralOverlayView.swift`, in-window)

Mounted in `ContentView`'s ZStack, **above** `terminalArea` and **below** the
existing modal overlays (new-workspace, remote sheets, cheatsheet, approval).

One `ForEach(store.ephemeralPanes, id: \.id)` mounts each pane's `GhosttyTerminal`
**exactly once** and keeps it mounted regardless of collapsed state — so the live
PTY survives collapse/expand (same principle as the flat `tabID`-keyed tab mounting
in `terminalArea`). Each pane's container animates its frame/position between two
layouts:

- **PiP slot** — bottom-right vertical stack of ~240×150 rounded cards, each a live
  (small) terminal render, a corner **state dot**, and on hover: the title + a close
  (×). Click anywhere on the card → `expandEphemeral`. Capped at 5; when a blocked
  spawn happens the row does a brief flash/shake.
- **Overlay** — only `expandedEphemeralID`'s pane: a centered floating card (~65% of
  the content rect) with a titlebar (display title · minimize · close) over the
  full-size terminal, atop a **dim click-catch backdrop** (mirrors
  `ShortcutCheatsheetView`) whose tap `collapseEphemeral`s it. A hidden
  `.cancelAction` button maps **Esc** to collapse.

The ephemeral surface claims first responder while its overlay is open, so keystrokes
(and menu shortcuts like ⌘W) act on it.

### 5. Persistence (`Persistence.swift`)

`PersistedState` gains an **optional** field so old blobs still decode:
```swift
struct PersistedEphemeral: Codable { var userTitle: String?; var cwd: String?; var sessionID: String? }
struct PersistedState: Codable {
    var workspaces: [PersistedWorkspace]
    var selectedWorkspaceIndex: Int
    var ephemeral: [PersistedEphemeral]?   // optional ⇒ pre-feature blobs decode as nil
}
```
`snapshotState` captures `ephemeralPanes`; `buildWorkspaces`'s sibling (or a new
`buildEphemerals(from:)`) rebuilds them **all collapsed (PiP)**, `.shell` state, fresh
ids. A restored pane carrying a `sessionID` resumes via the existing
`claudeResumeInput` → `takeResumeInput` path in `GhosttyTerminal.makeSurface`.

### 6. Remote mirror — "Temp Tabs"

`workspaceTrees()` appends one synthetic `WorkspaceTree`:
- `workspaceID = "ephemeral"` (reserved constant), `name = "Temp Tabs"`,
- one single-leaf `RemoteTab` per ephemeral pane (`RemoteNode` leaf = the pane),
- `selectedTabID` = the expanded overlay's pane id (or first).

A new `broadcastEphemeralTree()` fires on every ephemeral mutation (spawn / collapse /
expand / close / rename / state change), alongside the existing per-workspace
broadcasts. `workspaceList` includes `"ephemeral"` so clients list it.

Client→host commands targeting the reserved id are special-cased in
`applyRemoteCommand`:
- `cmdNewTab(workspaceID: "ephemeral")` → `spawnEphemeral()`
- `cmdSwitchTab(workspaceID: "ephemeral", tabID:)` / `cmdFocusPane` → `expandEphemeral`
- `cmdClosePane(paneID:)` where the id is ephemeral → `closeEphemeral`

Host stays authoritative (like existing Mac-to-Mac mirrors); worktree/git concepts
don't apply. On the phone it renders as a normal folder — no overlay/PiP notion there.

### 7. Keybindings (`ShortcutCatalog` — single source of truth)

- New `ShortcutID.newEphemeral`, key **⌘⌥N**, in an appropriate category. Menu bar +
  ⌘/ cheatsheet pick it up automatically; `ShortcutActions.run(.newEphemeral)` →
  `store.spawnEphemeral()`.
- `ShortcutActions.run(.closePane)` gains a precedence check: if
  `store.expandedEphemeralID != nil`, `closeEphemeral(that)`; otherwise the existing
  pane/tab close logic. (⌘⌥N is free today; ⌘⌥-arrows are focus moves, distinct.)

### 8. Testing (`EphemeralPaneTests` → `ShepherdModelTests`)

Pure-model coverage (added to the target's `sources:` in `project.yml`; the test file
is picked up by the `Tests` glob):
- **Cap:** `canSpawnEphemeral` false at 5; spawn beyond cap is a no-op on the array.
- **Single-overlay invariant:** expanding one collapses all others; at most one
  `!collapsed` after any sequence of expand/collapse ops.
- **Attention counting:** `ephemeralAttentionCount` counts only `wantsAttention`
  states; total badge = workspaces + ephemerals.
- **Persistence round-trip:** snapshot → build restores count, cwd, `sessionID`, and
  all-collapsed.

## Data flow (summon → tuck → attention)

```
⌘⌥N → ShortcutActions.run(.newEphemeral) → store.spawnEphemeral()
   → append EphemeralPane(pane: Pane(cwd: ~), collapsed: false), set expandedEphemeralID
   → EphemeralOverlayView mounts a GhosttyTerminal, injects SHEPHERD_TAB_ID/SOCK
   → broadcastEphemeralTree()  (clients see it under "Temp Tabs")

click away → backdrop tap → store.collapseEphemeral(id) → PiP slot (surface stays mounted)

claude inside → hook → report.sh → socket → AgentStore.apply
   → paneID misses workspaces, hits ephemeralPanes → StopPolicy.applyEvent
   → PiP state dot + dock badge + (if away) notification

⌘⇧A → selectNextAttention → lands on ephemeral → expandEphemeral(id) → overlay returns

⌘W (overlay up) → closeEphemeral(id) → PTY dies, removed, broadcast
```

## File-by-file impact

| File | Change |
|---|---|
| `EphemeralPane.swift` | **new** — model + pure helpers (cap, invariant, attention count) |
| `EphemeralOverlayView.swift` | **new** — overlay card + PiP row layer |
| `AgentStore.swift` | `ephemeralPanes` / `expandedEphemeralID`, spawn/expand/collapse/close, `apply`/`didFocus` ephemeral resolution, attention aggregation, `broadcastEphemeralTree`, `applyRemoteCommand` "ephemeral" cases, `workspaceTrees` append |
| `ContentView.swift` | mount `EphemeralOverlayView` in the ZStack |
| `Persistence.swift` | `PersistedEphemeral`, optional `ephemeral` field, snapshot/build |
| `ShortcutCatalog.swift` | `newEphemeral` = ⌘⌥N |
| `ShepherdApp.swift` | `ShortcutActions` wiring (`newEphemeral`, `closePane` precedence) |
| `RemoteProtocol.swift` | reserved `"ephemeral"` workspace id constant (if needed) |
| `Tests/EphemeralPaneTests.swift` + `project.yml` | new pure-model tests |

## Risks / edge cases

- **First-responder handoff** between an ephemeral overlay and the underlying terminal
  — the dim backdrop makes "click away" a single deterministic event (collapse), so
  there's no ambiguous focus split. Clicking a PiP is likewise explicit.
- **⌘W ambiguity** — resolved by `expandedEphemeralID` precedence: overlay up ⇒ ⌘W
  closes the ephemeral; otherwise normal pane/tab close.
- **Restore ordering** — ephemerals rebuild after workspaces; all collapsed, so no
  overlay steals focus on launch.
- **Remote reserved id collision** — `"ephemeral"` is a fixed literal; real workspace
  ids are UUIDs, so no clash.
