# Sidebar redesign — agent inbox + minimized organizer + quick-jump

**Date:** 2026-07-24
**Status:** design, pending review
**Touches:** `SidebarView.swift`, `AgentStore.swift`, `Workspace.swift`/new pure
model, `ShortcutCatalog.swift`, `ShepherdApp.swift`, `ShepherdModelTests`.

## Problem

Today's sidebar is an accordion of workspace folders (ADR 0017). It is **modal
on the active workspace**: non-active workspaces are inert rows you can only
*travel to*, not act on. That produces three daily frictions:

1. **Attention routing** — an agent that needs you is buried in some other
   workspace; the only fast path is the `⌘⇧A` keyboard hop. No persistent
   "who needs me" glance.
2. **Navigation** — getting to a known place is clicky; there is no fast
   jump-by-name, and workspaces must be clicked open one at a time.
3. **Action friction / discoverability** — to open a tab (or a *worktree* tab)
   in another workspace you must first select it, and even then the worktree
   action is hidden behind a hover button.

Android solved a related problem with an **inbox**: the agents that need you are
big and float to the top; the rest shrink to one-liners and hide. But a pure
inbox can't hold **terminals** — a plain shell never "needs you," so it has no
urgency to sort by. That is exactly why "the inbox view can't be reconciled with
terminals."

## Core insight

Agents and terminals are **different kinds of citizen** and want different
mechanisms:

- **Agents** have a lifecycle (`working → blocked → needsCheck → error → idle`),
  so *urgency is a real signal*. You **monitor** them continuously → they belong
  in a persistent, self-sorting list that **moves to you**.
- **Terminals** have no urgency; you **navigate to them by place**, and only
  *sometimes*. They belong in a **stable** organizer, reached **on demand**.

So the sidebar splits by citizen type — **not by copying**. Each pane appears
**exactly once**: agents in the inbox, terminals in the organizer, quick-jump is
a transient overlay. This kills the duplication a separate "inbox band" would
have caused.

## The three components

### 1. Agents zone — persistent, top, self-sorting (the monitor)

A cross-workspace list of every **agent pane**, sorted by urgency, with a **size
hierarchy** (the Android treatment):

- **Needs-you agents** (`state.wantsAttention` → `blocked` / `needsCheck` /
  `error`) render as **big cards**, always visible, sorted by the existing
  `AgentState.rollUp` priority (`blocked > error > needsCheck`). Card anatomy:
  - line 1: the pane `displayTitle` (bold),
  - line 2: home workspace name · short reason (e.g. "answer needed",
    "approve Bash", the API error type),
  - the state color as a left accent / dot.
- **Calm agents** (`working` / `idle`) render as **one-line rows** (dot + title +
  workspace), tucked under a collapsible **"Running (N)"** disclosure that is
  **collapsed by default**. This is the "rest is minimized / hidden" behavior.
- Clicking any agent → `revealPane` (switch workspace + tab + focus), same call
  `⌘⇧A` already uses.
- **Empty state:** no agents ⇒ the whole zone is absent; the sidebar degrades to
  just the organizer.

**What counts as an agent pane (v1 scope):** a **single-pane tab** whose pane
`state.isAgent` (`!= .shell`). Split tabs are **not** lifted — they stay in the
organizer with their existing `SplitTabGroup` pip/dot treatment (consistent with
the PR-status feature's "single-pane tabs only, v1"). This avoids tearing a split
tab across two zones and keeps v1 tractable; the common case (one agent = one
tab) is handled cleanly.

### 2. Workspaces zone — persistent, minimized, actionable (the organizer)

The existing workspace folders, in **fixed user order** (no urgency reordering —
they already don't reorder; `⌘1-9` / `⌃⇥` order stays stable), but:

- **Collapsed to one-line headers by default** (aggregate dot + name). Change the
  default of `Workspace.collapsed` to collapsed for a fresh workspace; existing
  persisted flags are respected.
- **Every header is live in place** — new tab, **new worktree tab (promoted out
  of hover into a visible affordance)**, rename, switch — no travel required.
  (Reuse the existing per-folder ops that already carry `workspaceID`.)
- **Shows only the tabs NOT lifted to the Agents zone** — i.e. terminal
  single-pane tabs + all split tabs. A workspace whose only tab is its agent
  therefore shows an **empty folder** (just its actionable header). This is
  intended: the organizer becomes a **launcher/organizer** for terminals and
  actions, and the agent lives up top. Expand a folder to browse/click its
  terminals.
- Archived-worktrees subsection (`ArchivedSection`) stays as today.

### 3. Quick jump — summonable overlay (the "sometimes")

A `⌘K` HUD overlay (same pattern as the existing `⌘/` `ShortcutCheatsheetView`):
a text field over a dimmed click-to-dismiss backdrop.

- Fuzzy-filters across **every workspace / tab / pane** by name + cwd; arrow keys
  move selection, Enter → `revealPane` (or switch workspace).
- Also lists **actions**: "New tab in `<ws>`", "New worktree tab in `<ws>`" — so
  you can act in any workspace without traveling there.
- Esc / click-out / `⌘K` dismiss (hidden `.cancelAction`, like the cheatsheet).
- This is the primary fast path to a specific terminal; the collapsed folders are
  the browsable fallback. Scales past "a lot more tabs" because typing beats
  scrolling.

## How it resolves each pain

| Pain | Resolution |
|---|---|
| Agent buried | Floated to the top Agents zone, always; needs-you as a big card. |
| Clicky navigation | `⌘K` jumps anywhere by typing; folders one-line + fixed, muscle memory holds. |
| Act elsewhere / hidden worktree | Every header live; worktree action visible; or fire from `⌘K`. |
| Duplication | Agents only in zone 1, terminals only in zone 2, `⌘K` transient. No pane twice. |
| Terminals don't move | They sit still in fixed folders; reached by summoning, not by sorting. |

## Data model & where the logic lives

Keep the reduce **pure and unit-tested** (mirrors `StopPolicy` / `SleepPolicy`).
Add a pure model — proposed `AgentInbox.swift`:

- `struct InboxItem { paneID, tabID, workspaceID, title, workspaceName, cwd,
  state, reason }`.
- `func agentInbox(_ workspaces: [Workspace]) -> [InboxItem]` — walk every
  workspace → tab → pane, select **single-pane agent tabs**, map to items, sort
  by `rollUp` priority then stable original order.
- `partition` into `needsYou` (`wantsAttention`) vs `calm`.
- A companion `func organizerTabs(_ ws: Workspace) -> [Tab]` (or a filter) that
  returns the tabs a folder should render (everything not lifted).

`SidebarView` consumes these; `AgentStore` exposes them as computed views (the
store already owns `workspaces`). No new persisted state — the inbox is derived.

**Reason string:** cards want a short reason on needs-you agents. `AgentStore`
already computes reasons in `apply` (e.g. "approve Bash"). If it isn't on the
`Pane` today, add an optional `Pane.attentionReason: String?` set alongside the
state transition; otherwise fall back to the bare state word. (Confirm during
implementation.)

## Keybindings

Add `⌘K` (quick jump) to `ShortcutCatalog` (single source of truth) with a
`ShortcutID`; wire it in `ShortcutActions.run`. Menu + `⌘/` cheatsheet pick it up
automatically. Existing bindings unchanged.

## Persistence & migration

- No new persisted schema. Inbox is derived each render.
- Default `Workspace.collapsed` for *new* workspaces flips to `true`
  (minimized-by-default); persisted values still decode and win. Verify the
  `PersistenceTests` still round-trip.

## Edge cases

- **Split tabs**: never lifted (v1) — remain in the organizer.
- **Empty folders**: allowed and expected (organizer = launcher). The existing
  empty-workspace handling (`WorkspaceEmptyView`) is for a workspace with **zero
  tabs**; a folder with only-agent-tabs is *non-empty* but shows no organizer
  rows — render just the actionable header (no empty-view).
- **Remote / mirror workspaces**: mirror panes carry state over the wire, so they
  appear in the Agents zone like local ones; `revealPane` already works
  cross-workspace. Worktree actions on a mirror still route to the host (existing
  v1 limitation, unchanged).
- **Provisioning worktree panes** (`Pane.provisioning`): a provisioning pane is
  not yet an agent (`.shell`) → stays in the organizer with its
  `WorktreeProvisioningView`, graduates to the inbox once its agent starts.
- **A pane graduating**: run `claude` in an organizer terminal → it becomes an
  agent → on the next render it moves to the Agents zone (motion "to you"). This
  is intended.

## Testing

`ShepherdModelTests` (pure, no AppKit):
- `AgentInboxTests`: enumeration across multiple workspaces; single-pane-agent
  selection (split tabs excluded, shells excluded); urgency sort order; needs-you
  vs calm partition; organizer-tabs complement (union with inbox = all tabs, no
  overlap).
- Extend `PersistenceTests` for the `collapsed` default flip (old blobs decode
  unchanged; new workspace defaults collapsed).
- Add `AgentInbox` (+ any new `Pane` field) to the test target's `sources:` in
  `project.yml`; `xcodegen generate` after.

SwiftUI rendering (cards, disclosure, `⌘K` overlay) is verified by the user at
runtime (per project convention — compile + unit tests here, runtime checks
deferred to the user).

## Non-goals (deferred)

- Lifting **split-tab** agent panes into the inbox (v1: single-pane only).
- Per-agent inline actions on the cards (answer/approve from the sidebar) — click
  jumps you to the pane; acting there is unchanged.
- Rebinding `⌘K`; sourcing pane-collapse defaults from `~/.config/shepherd`.
- Any change to the state machine / hook protocol — this is presentation only.

## Open question for review

`⌘K` as a **centered overlay HUD** (recommended — matches "only sometimes",
reuses the `⌘/` pattern, gets out of the way) vs a **persistent search box pinned
in the sidebar** (more discoverable, costs a permanent row). Spec assumes the
overlay; flag if you'd rather have the pinned box.
