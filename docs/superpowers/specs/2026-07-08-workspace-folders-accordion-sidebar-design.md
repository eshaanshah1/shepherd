# Workspace folders — accordion sidebar

**Date:** 2026-07-08
**Status:** approved, ready for implementation
**Branch:** `workspace-folders-accordion-sidebar`

## Problem

Workspaces today live behind a name-dropdown header (`WorkspaceSwitcher`) and a
single-workspace tab strip that **slides** horizontally when you switch
(`SidebarView`'s GeometryReader HStack + `SidebarSwipe` two-finger gesture). Only
one workspace's tabs are visible at a time, and the slide animation is unwanted.

## Goal

Show **every** workspace at once as a **collapsible folder** in one vertical
scroll — an accordion. All tabs are reachable without switching context and
without any horizontal slide. The internal model is unchanged: workspaces own
tabs, tabs own pane-trees. This is a sidebar-presentation change plus a small
amount of per-workspace state (collapse) and store plumbing.

Each folder header carries **one aggregate status dot** with priority
**blocked > done > working > idle** (the existing `AgentState.rollUp`, which also
slots `error` just after `blocked` — kept as-is; `error` is rare).

## Decisions (from brainstorming)

1. **Controls:** a slim top bar keeps a global `+` (new workspace) and a `⋯`
   overflow (`Add remote host…`, plus the pairing code while serving). Folder
   headers own rename/delete (right-click) and reorder (drag).
2. **Collapse:** persisted per folder, default expanded.
3. **New tab:** `⌘T` / footer "New Tab" target the active folder; hovering a
   folder header reveals a `+` that adds a tab directly into that folder (and
   selects it).

## UI structure (`SidebarView.swift`)

```
┌─────────────────────────┐
│ WORKSPACES          + ⋯ │  top bar (label · new-ws · overflow menu)
├─────────────────────────┤
│ ▼ ● Brainstorms         │  WorkspaceFolderHeader (chevron·dot·name, hover +)
│     ● Research 7.25     │    TabRow (indented)
│     ◐ Q2 Planning       │    TabRow
│ ▶ ● Workflows           │  collapsed folder — header only
├─────────────────────────┤
│ + New tab          ⌘T   │  footer (unchanged; targets active folder)
└─────────────────────────┘
```

- **Top bar** replaces the name-dropdown header. `+` → `store.promptingNewWorkspace = true`
  (existing modal). `⋯` is a SwiftUI `Menu` (`.focusable(false)`) with **Add
  remote host…** (moves `promptAddRemoteHost` here) and, when `store.isServing`,
  the **pairing code** shown/selectable.
- **Body** becomes a single `ScrollView` + `LazyVStack` iterating
  `store.workspaces`. For each workspace: a `WorkspaceFolderHeader`, then — if not
  collapsed — its `tab` rows (`TabRow` / `SplitTabGroup`) indented one step. No
  GeometryReader strip, no `.offset`, no slide `.animation`.
- **`WorkspaceFolderHeader`** (new view in `SidebarView.swift`):
  - `▶/▼` disclosure chevron → `store.toggleWorkspaceCollapsed(ws.id)`.
  - `LeadingIcon(state: ws.aggregateState)` — the aggregate dot (working
    breathes), reusing the existing component and priority.
  - Workspace name (`ws.displayName(index:)`), emphasized when it is the active
    workspace (`ws.id == store.selectedWorkspaceID`).
  - Hover reveals a trailing `+` → `store.newTab(inWorkspace: ws.id)`.
  - Right-click context menu: **Rename** (inline `TextField`, mirroring
    `TabRow`'s rename) / **Delete** (guarded NSAlert confirm reused from the old
    switcher, only when >1 workspace and only prompting if it has a live agent).
  - Drag header to reorder workspaces (`store.reorderWorkspace`), mirroring the
    old switcher's row reorder gesture.

## Model / store changes

### `Workspace.swift`
- Add `var collapsed: Bool = false` (runtime folder state). Thread through the
  `init` with a default so existing call-sites are unaffected.

### `Persistence.swift`
- `PersistedWorkspace`: add `var collapsed: Bool?` — **optional** so old
  `shepherd.workspaces.v1` blobs (which lack the key) still decode; `nil` ⇒
  expanded.
- `snapshotState`: write `collapsed: ws.collapsed`.
- `buildWorkspaces`: set `collapsed: pw.collapsed ?? false` on the rebuilt
  `Workspace`. (No store-key bump; the field is additive and back-compatible.)

### `AgentStore.swift`
- `toggleWorkspaceCollapsed(_ id: String)` — flip the flag, `save()`.
- `select(tabID:inWorkspace:)` — set `selectedWorkspaceID` to that workspace,
  set its `selectedTabID`, clear need-to-check via `didFocus`, refocus terminal.
  (Today `select(tabID:)` only works within the current workspace; a tab in a
  non-active folder needs the workspace-targeted variant.)
- `newTab(inWorkspace id:)` — append a fresh tab to that workspace, select it +
  the workspace. (Reuse/generalize existing `newTab`, honoring the remote-host
  `cmdNewTab` path when that workspace is a mirror.)
- Generalize tab **reorder** to the tab's owning workspace: `reorder` /
  `commitOrder` currently assume the current workspace (`store.tabs`). Add a
  workspace-scoped path so dragging a tab inside a non-active folder reorders
  within that folder.
- Keep `nextWorkspace` / `prevWorkspace`; **remove** `swipeToWorkspace`.

### `SidebarView.swift` row plumbing
- `TabRow` and `SplitTabGroup` take the owning `workspaceID` and use it for
  select / reorder / close, instead of assuming `store.tabs` / `store.selectedTab`
  is the tab's workspace.

### `ContentView.swift`
- Remove the `showSwitcher` state, the switcher overlay, and its backdrop. The
  terminal-area ZStack (every workspace's surfaces mounted, cross-fade on
  `selectedWorkspaceID`) is unchanged.

## Deletions

- **`WorkspaceSwitcher.swift`** — deleted; its rename / delete-confirm /
  add-remote-host / pairing-code logic relocates to the folder headers + `⋯`
  menu.
- **`SidebarSwipe.swift`** — deleted; the swipe existed only to drive the slide.
- **`store.swipeToWorkspace`** — deleted.
- Run `xcodegen generate` after removing these files (drop
  `WorkspaceSwitcher.swift` from any explicit `sources:` if listed; the `Sources`
  glob otherwise handles it).

## Kept as-is

- `⌘⇧N` new workspace, `⌃⇥`/`⌃⇧⇥` cycle active workspace, `⌘1–9` tab in current
  workspace, `⌘⇧A` cross-workspace attention jump, `⌘T`/`⌘W` semantics.
- `AgentState.rollUp` / `Workspace.aggregateState` — already the requested
  priority; no change.
- Remote/mirror workspaces render as folders like any other (uniform iteration
  over `store.workspaces`); `isRemote` needs no special-casing in the accordion.

## Testing

- Pure-model additions are covered by `ShepherdModelTests`:
  - `PersistenceTests`: round-trip `collapsed` through
    `snapshotState`/`buildWorkspaces`; decode a legacy blob **without** the
    `collapsed` key (→ expanded) to prove migration-safety.
  - `WorkspaceTests`: `collapsed` default is `false`.
- The `SidebarView` / header interactions are AppKit surface — verified by
  build + the user's runtime check (per repo convention, not killed mid-session).

## Scope boundaries

- **Cross-folder tab move** (drag a tab from one folder into another) is
  **deferred** — reorder stays within a folder for v1.
- No change to the workspace data model beyond the additive `collapsed` flag; no
  persistence-key bump.

## Follow-ups

- New ADR (`.claude/adr/0017-workspace-folders-accordion-sidebar.md`) recording
  the move from dropdown + horizontal slide to a vertical accordion, and the
  deletion of `WorkspaceSwitcher`/`SidebarSwipe`.
- Update `CLAUDE.md`'s Sidebar section + repo-layout notes (remove the swipe /
  slide / dropdown description; describe the accordion).
