# 0017. Workspace folders: accordion sidebar

Status: Accepted
Date: 2026-07-08

## Context
ADR 0013 shipped workspaces behind a **name dropdown** (`WorkspaceSwitcher`) plus
a single-workspace tab strip that **slid horizontally** on switch (a side-by-side
`GeometryReader` HStack offset by `-index*width`, driven by `⌃⇥`/`⌃⇧⇥` and a
two-finger swipe in `SidebarSwipe`). Only one workspace's tabs were visible at a
time. In practice the slide was unwanted and hiding the other workspaces' tabs
made cross-workspace work a switch-and-hunt exercise.

## Decision
Replace the dropdown + slide with a **vertical accordion**: every workspace is a
**collapsible folder**, all tabs visible in one scroll.

**1. Presentation only — the model is unchanged.** `AgentStore` still owns
`workspaces` + `selectedWorkspaceID`; a tab still lives in exactly one workspace.
The sole model addition is `Workspace.collapsed` (folder open/closed), persisted
per workspace as an **optional** `PersistedWorkspace.collapsed` so pre-accordion
`shepherd.workspaces.v1` blobs still decode (nil ⇒ expanded). No store-key bump.

**2. Sidebar layout.** A slim top bar (`WORKSPACES` label · `+` new-workspace ·
`⋯` overflow with *Add remote host…* and, while serving, the pairing code)
replaces the dropdown header. Below it, one `ScrollView`/`LazyVStack` iterates
`store.workspaces`, each rendered as a `WorkspaceFolderHeader` (chevron ·
aggregate dot · name; active workspace reads brighter; hover reveals a `+` that
adds a tab into that folder) followed by its tab rows (indented) when expanded.
Header tap toggles collapse; right-click → rename / collapse / delete.

**3. One aggregate dot per folder.** The folder header dot is the existing
`Workspace.aggregateState` (`AgentState.rollUp`): **blocked > error > done >
working > idle > shell**. This already matched the requested priority.

**4. Selection is workspace-scoped.** Because a tab can be shown in a non-active
folder, `TabRow`/`SplitTabGroup` carry their owning `workspaceID` and call
workspace-scoped store methods (`select(tabID:inWorkspace:)`,
`newTab(inWorkspace:)`, `rename(...inWorkspace:)`, `closeTab(_:inWorkspace:)`,
`reorder(...inWorkspace:)` / `commitOrder(inWorkspace:)`). Clicking any tab
selects it and makes its folder the active workspace.

**5. Folder reorder by drag, resolved by header position.** Tab reorder inside a
folder keeps the uniform-stride live math (rows are contiguous). Folder reorder
can't use a fixed stride (folders have variable heights from their expanded tab
lists), so headers publish their center via a `FolderCentersKey` preference and a
dragged folder drops at the index its header center lands in, on release.

**5a. Cross-folder tab move (hybrid drag).** A tab can be dragged into another
folder. Within its own folder the drag keeps the live stride reflow; once the
cursor enters a *different* folder's region (folders publish their frame via a
`FolderRegionsKey` preference; the gesture reads its location in the shared
`wsList` coordinate space), the reflow is suppressed, that folder highlights, and
on release `AgentStore.moveTab` appends the tab there, selects it, and makes the
folder active. Moves into/out of a remote/mirror workspace are refused
(host-authoritative). **Enabler:** `ContentView` now mounts all tabs in a single
`tabID`-keyed `ForEach` (via `AgentStore.allMountedTabs`) instead of grouping by
workspace — so a re-parented tab keeps its SwiftUI identity, and thus its
libghostty surface and **live PTY**, across the move (grouping would destroy and
recreate it, killing the agent).

**6. Deletions.** `WorkspaceSwitcher.swift` and `SidebarSwipe.swift` are removed
(their rename/delete/add-remote-host/pairing logic moved into the folder headers
and `⋯` menu); `AgentStore.swipeToWorkspace` is gone. `⌃⇥`/`⌃⇧⇥` (cycle active
workspace), `⌘⇧N`, `⌘1–9`, and `⌘⇧A` are unchanged.

## Consequences
- All workspaces and their tabs are visible at once; no horizontal motion.
- Remote/mirror workspaces render as folders like any other (uniform iteration);
  no `isRemote` special-casing in the sidebar.
- A tab (with its live agents) can be dragged between folders; the terminal-area
  flattening keeps its PTY alive across the move.
- Deferred: dragging a **split** tab across folders (only unsplit `TabRow`s carry
  the drag gesture, as before), and choosing the drop *index* within the target
  folder (a cross-folder drop appends).
