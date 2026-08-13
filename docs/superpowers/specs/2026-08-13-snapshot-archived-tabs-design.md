# Snapshot archived tabs until unarchive

Date: 2026-08-13
Status: Design, approved for planning
Supersedes nothing. Builds directly on
[`2026-08-11-mark-done-and-archived-tabs.md`](2026-08-11-mark-done-and-archived-tabs.md).

## The problem

Clicking a shelved task materializes it. `tasks.reveal`
(`v2/extensions/tasks/src/index.ts:2854`) calls `materialize(task)` for anything
`isShelved` returns true for — which re-provisions every repo, replays the git
archive commits, recreates the worktrees on disk and opens panes that spawn
ptys. A glance at work from three weeks ago costs a git restore and, on the
machine this was measured for, 838 MB.

The screens were already saved. Archiving captures each pane through
`sessions.capture` and writes it to `${ctx.dataDir}/.archives/<task>/<root>/<pane>.term`
(`captureTabs`, `index.ts:1656`). Restore replays them — but only by spawning a
real session and seeding the emulator before the pty speaks (`rebuildTabs`,
`index.ts:1741`).

So the bytes exist and are already faithful. What is missing is the ability to
**show them without the machinery underneath**: viewing a shelved task should
render what was on screen, and only an explicit restore should put disk, git and
agents back.

## Scope

Applies to **both** shelved states, which the model deliberately keeps separate:

- `shelvedAt` — work snapshotted and worktrees reclaimed, task still active
  (this is what closing a task's last pane does, via the `rootClosed`
  subscription at `index.ts:1163`).
- `lifecycle: 'archived'` — shipped/done.

Both currently re-materialize on click. Both become snapshot-only.

Out of scope: changing when a task is shelved, the git archive/restore plumbing
(`model/archive.ts`), and archive retention (there is none — `index.ts:1190`
records why).

## Design

### 1. A pane may have no session

`Pane` gains two fields, both round-tripping through `PersistedPane`
(`v2/packages/core/src/layout/serialize.ts:38`):

- `readOnly: true` — this pane never spawns a session.
- `snapshotFile: string` — an absolute path to the bytes it replays. Named
  apart from `seed` deliberately; the two are not variants of one thing (see
  below).

The branch that matters is in the **renderer**, not the store.
`PaneSessionRegistry.#sync` creates a session for any mounted pane whose
`sessionId` is null (`pane-sessions.ts:521`) — that is the rule that makes a
persisted pane with a dead binding come back alive, and it is exactly what must
not happen here. A `readOnly` pane sets `wantSession: false` and never reaches
it. `LayoutStore.#adoptPersistedSessions` needs no change: it drops an unclaimed
binding and leaves the pane, which is already correct for a pane that never had
one.

Keystrokes need no separate guard. `#buildTerminal`'s `onData` listener already
returns early while `sessionId === null` (`pane-sessions.ts:473`), so a
read-only pane swallows input by construction rather than by a flag somebody has
to remember to set.

**The kernel never learns the word "archive."** It learns "replay these bytes
from this file and never spawn." `tasks` owns writing the file and choosing the
path; `historyPath` (`model/archive-tabs.ts:115`) already sanitises every
segment, including stripping dots so `..` cannot survive. A path is not task
vocabulary, so D11 holds.

`snapshotFile` is persisted, unlike `seed` — and the distinction is the point.
`seed` is one-shot and memory-only (`store.ts:643`, cleared on pane close)
because a pane whose session dies and is replaced must not replay a screen from
before the task was shelved. A read-only pane has no session to replace: the
file **is** what the pane shows, for as long as the pane exists.

The bytes reach the renderer through a new IPC, `layout:snapshotBytes`, asked
once per pane when its terminal is built. Not through the layout envelope: that
is pushed on every change, and a screenful of scrollback per read-only pane on
each push is a cost paid forever for a value that never changes.

### 2. Tree-shaped open

`layout.openRoot` gains `tree?: PersistedNode`, deserialized by
`deserializeNode` (`serialize.ts:96`) — which already validates as it goes
rather than trusting a cast, because it reads a value a half-finished write can
have mangled.

This closes a gap that predates this work. `ArchivedTab.tree` is captured and
stored verbatim but nothing has ever read it: `rebuildTabs` reopens a task's
panes **flat**, because `layout.split` takes an axis and no path and so cannot
reproduce a tree of ratios (the comment at `index.ts:1774` says exactly this).

One command serves both paths, deliberately. A snapshot that showed a faithful
three-pane layout and a restore that produced a flat row would be a
discontinuity the user reads as a bug, and shipping it on purpose to save work
in the kernel is the wrong trade.

### 3. Renderer

`PaneSessionRegistry.attach` / `suspend` set `wantSession` from
`!pane.readOnly`, and `#buildTerminal` writes the pane's bytes into the fresh
emulator when it has a `snapshotFile`. `TerminalPane` itself is unchanged apart
from a `data-readonly` attribute the smoke can read: the pane's read-only-ness
travels on the `Pane` it already receives.

Scrollback, selection, copy and the find-bar keep working with no extra code:
they are emulator-side, and the captured bytes carry the scrollback (the mirror
serializes 1000 lines by default, `mirror.ts:44`, and the capture is prefixed
with RIS so it replaces rather than appends).

### 4. `reveal` stops materializing

`tasks.reveal` drops its `isShelved → materialize` call. In its place, for each
`ArchivedTab` on the record: `layout.openRoot` with the tab's stored `root` id,
its `group`, and its `tree` — rewritten first so each leaf carries
`readOnly: true` and the `snapshotFile` resolved from that pane's `history`
field. Rewriting the tree rather than passing a parallel map is what keeps the
correlation single: `ArchivedPane.pane` is the same id the tree's leaf carries,
and joining them twice is two chances to disagree.

Root ids are the archived ones, as `rebuildTabs` already uses — so a snapshot
task's tabs appear under the names the sidebar rows and the tab strip key on
(ADR 0035), and nothing downstream needs to know it is looking at a snapshot.

No git runs. No session is created. No directory is written.

**A task with no `tabs`** — shelved before tabs existed, or a draft that never
spawned — opens its root empty with a placeholder, exactly as today. There is
nothing to snapshot and the Restore path is unchanged.

**A pane whose `.term` file is unreadable** comes back blank rather than
refusing, matching `readHistory`'s existing stance (`index.ts:1803`): a missing
file is an expired or hand-cleaned archive, and a tab that comes back blank
beats one that will not come back.

### 5. `tasks.restore` becomes the real one

Today `restore` only flips lifecycle (`index.ts:3006`) and materialization
happens as a side effect of `reveal`. With those decoupled, `restore` does the
work:

1. Close this task's read-only roots.
2. `materialize(task)` — provision, replay each `RepoArchive`, clear
   `archives`/`shelvedAt`, `rebuildTabs` (now passing `tree`, per §2).
3. Set `lifecycle: 'running'` and `activatedAt` when the task was `archived`.
   A task that was only `shelvedAt` keeps its lifecycle: it never left.

Both entry points invoke this same command.

### 6. The button

Two affordances, one command:

- **The sidebar row** keeps a Restore verb, on both an `archived` and a
  `shelvedAt` row.
- **The snapshot view** carries a banner across the root: "Archived — Restore".

The banner reuses `RootPlaceholder`. `setPlaceholder` already accepts a root
that has panes (`store.ts:557`); it is `placeholderOf` that refuses to read one
back while `state.tree !== null` (`store.ts:544`). That refusal exists for a
named reason — a stale line reading `Creating the worktree` drawn over a running
agent is the one way the feature can lie. **A read-only root has no running
agent and no pending fill**, so the reason does not reach it, and the read-side
guard widens to "refuse over a root with live panes" rather than "refuse over
any panes".

`RootPlaceholder` gains an optional `action: { command, label, args? }`. The
label and command id come from the extension, so the shell draws the button
without knowing `tasks.restore` exists — the same rule ADR 0031 sets for a
contributed row's verbs, and the same shape `TreeItem.command` already uses.

## Decisions to record as ADRs

1. **A pane may have no session, and that is not a ghost.** Why `readOnly` +
   `snapshotFile` persist when `seed` deliberately does not, and why the branch
   belongs in the renderer's `#sync` rather than in the store's restore path.
2. **A placeholder may sit over a root that has panes, when none of them is
   live.** Why `placeholderOf`'s refusal is scoped to its actual reason.

## Testing

- **Unit, layout:** a tree-shaped `openRoot` reproduces axes and ratios; a
  `readOnly` pane round-trips through serialize/deserialize; a persisted
  `readOnly` pane with no `sessionId` survives `#restore` instead of being swept.
- **Unit, tasks:** revealing a shelved task invokes no `process.exec` and no
  session create — the inverse of the existing test at `index.test.ts:602`
  ("runs NO git at all for an archived task"); `restore` invokes both.
- **Renderer:** a `readOnly` `TerminalPane` writes its bytes and never calls
  `sessionCreate`.
- **`pnpm smoke:m3`** — the gate that matters, per CLAUDE.md's warning that a
  green unit suite is not a working app (the archive-on-close bug passed every
  unit test because each supplied both halves of the correlation). It already
  asserts an archived pane kept its screen (`smoke-m3.ts:274`). Extend it with:
  click a shelved task → its tabs are on screen, `sessions.list` gained nothing,
  the worktree directories do not exist; then Restore → the directories are back
  and the panes have sessions.

## Consequences

- Reading old work is free. The 838 MB and the git restore are spent only when
  asked for.
- Split geometry comes back on restore, closing `index.ts:1774`.
- The layout kernel persists two kinds of pane. The cost is one branch in the
  deserializer, taken deliberately over losing your place on every `pnpm ship` —
  which on this project is constant.
- A snapshot is exactly as good as the capture that produced it: 1000 lines,
  no live output, and stale by construction. It is a photograph, and the banner
  says so.
