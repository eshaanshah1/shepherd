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
