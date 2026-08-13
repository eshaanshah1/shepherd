# 0042. (v2) A pane may have no session, and that is not a ghost

Status: Accepted
Date: 2026-08-13
Scope: `v2/` only.
Extends: [0022](0022-v2-layout-owns-the-session-binding.md), [0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md).

## Context

Clicking a shelved task materialized it. `tasks.reveal` called `materialize` for
anything `isShelved` answered true for — re-provisioning every repo, replaying
the git archive commits, recreating the worktrees and opening panes that spawn
ptys. A glance at work from three weeks ago cost a git restore and, on the
machine this was measured for, **838 MB** of worktree.

The screens were already saved. Archiving captures each pane through
`sessions.capture` into `${dataDir}/.archives/<task>/<root>/<pane>.term`, and
restoring replays them — but only by spawning a real session and seeding the
emulator before the pty speaks. The bytes existed and the only way to show them
was to rebuild everything underneath them.

## Decision

**A `Pane` may be `readOnly`, and carry a `snapshotFile` instead of a session.**
Both persist. The renderer never creates a session for such a pane, and writes
the file's bytes into its emulator once.

### The kernel does not learn what an archive is

`snapshotFile` is an absolute path and nothing more. The layout does not know
these bytes came from a task, or that tasks exist; it knows "replay this file
and never spawn". `tasks` owns writing the file and choosing the path
(`historyPath`, which sanitises every segment — a root id contains `:` and `/`
by construction, so a path built by concatenation would write outside the
directory it was meant to). A second producer of captured screens needs nothing
new here. D11 holds.

### `snapshotFile` persists; `seed` deliberately does not

They look like variants of one thing and are not. `seed` is one-shot and memory
only (`LayoutStore.#initialSeed`, cleared on pane close) because a pane whose
session dies and is replaced must not silently replay a screen from before the
task was shelved. A read-only pane has no session to replace: the file **is**
what the pane shows, for as long as the pane exists, and a relaunch that dropped
it would leave an archived tab blank.

### The enforcement is in the renderer, not the store

`PaneSessionRegistry.#sync` creates a session for any mounted pane whose
`sessionId` is null. That is what makes a persisted pane with a dead binding
come back alive, and it is exactly what must not happen here — so `attach` and
`suspend` set `wantSession` from `!pane.readOnly` and the create branch is never
reached.

`LayoutStore.#adoptPersistedSessions` needed **no** change, which is worth
recording because the obvious place to put the branch was there: it drops an
unclaimed binding and leaves the pane, which is already correct for a pane that
never had one. Keystrokes need no guard either — `#buildTerminal`'s `onData`
listener already returns early while `sessionId` is null, so a read-only pane
swallows input by construction rather than by a flag somebody has to remember.

### The bytes travel on their own channel

`layout:snapshot` takes a **pane id** and answers bytes. Not a path: the page
has no filesystem and must not be handed one — main resolves `snapshotFile` from
the tree it owns, so a compromised renderer can ask for the screen of a pane
that exists and for nothing else on the machine. And not the layout envelope,
which is pushed on every change: a screenful of scrollback per read-only pane on
every push is a cost paid forever for a value that never changes.

### A tree-shaped `openRoot`, and why it wins over the persisted record

`layout.openRoot` takes a `tree`, so a root can be minted with splits and ratios
rather than one pane. `layout.split` takes an axis and no path, which is why a
restored task's tabs came back **flat** for two milestones — one argument now
serves both the snapshot view and the live restore, so the two cannot drift into
showing the same task two different ways. Panes of a shaped tab are staged
through `layout.seedPane`, because a shaped open mints several at once and
`openRoot`'s own `seed` lands on the focused one.

`tree` is checked **before** `#restore`, where `empty` and `group` are checked
after it. The difference is which fact is more recent: a restored root is the
panes the user left there, and re-deciding its group would let the second caller
of `open` move the first caller's window — but a `tree` is not a preference
about a root that already exists, it is the root's contents, handed over by the
one thing that knows them.

The m3 smoke found this and no unit test could have. Shelving removes the task's
root, but the layout's write is debounced by 400 ms, so a task revealed in the
same breath found its own **pre-archive** record still on disk and came back as
live panes in a worktree that had just been deleted. Nothing said so: the log
read `restored 1 pane(s)`, which is what a working restore also says.

## Consequences

- Reading shelved work is free. The 838 MB and the git restore are spent only
  when asked for, by `tasks.restore`.
- Split geometry survives a restore, closing a gap that had its own comment.
- The layout persists two kinds of pane. The cost is one branch in the
  deserializer, taken deliberately over losing your place on every `pnpm ship` —
  which on this project is constant.
- A snapshot is exactly as good as the capture that produced it: 1000 lines, no
  live output, stale by construction. It is a photograph, and the banner
  ([0043](0043-v2-a-placeholder-may-cover-a-root-of-captured-screens.md)) says so.
