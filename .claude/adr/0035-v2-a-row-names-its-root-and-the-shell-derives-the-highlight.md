# 0035. (v2) A row names its root, and the shell derives the highlight

Status: Accepted
Date: 2026-08-09
Scope: `v2/` only.

## Context
The sidebar's highlighted row did not follow the window. Creating a task takes
you to it — the spawn ends in `layout.switchRoot` — and the row for the task now
filling the screen stayed unhighlighted while the row you had clicked before it
stayed lit. The CLI's spawns did the same, and so did a task's last pane closing
and falling the window back to the home root.

The cause was one line: the dock held the selection in a `useState` written only
by a row's own `onClick`. That is a **second copy of a fact the dock does not
own** — which root the window is on — and the copy is only updated by one of the
many things that change the original.

The obvious repair is to update the copy from the other paths too. That is what
was built first, and it is recorded here because it looked right and was not: a
`layout.rootChanged` bus topic, mirrored by `tasks` into a local `activeRoot`,
with the row reporting `selected: true`. It passed its unit tests and the smoke.
It is also the same disease one process along — the copy simply moved from the
renderer to the extension host, where it additionally had to be seeded whenever
the host restarts (no verb could read the active root; `setActive` early-returns
on an unchanged root, so nothing re-announces), lagged the stage by the round
trip that filled it, and desynchronised if a nudge were dropped. The comment
above the topic said "the layout is the only thing that knows", and the code
under it handed a copy to something else.

## Decision
**A row names the layout root it stands for; the shell compares.**
`TreeItem.root` is an **identity**, not a state — written once by the
contribution, never invalidated. The dock draws a row selected when
`row.root === activeRoot`, and `activeRoot` is `snapshots.active` from the layout
snapshot: **the same value the stage already uses** to decide which root to draw
(`app.tsx`, `root.root === snapshots?.active`).

So the highlight and the visible pane group are one value read twice. They cannot
disagree, which is precisely the bug — not "they can be made to agree", but that
there is no longer a second thing to agree with.

The dock keeps **no selection state at all**. A click runs the row's command
(ADR 0031: attributed to the contributing extension) and nothing else. What moves
the highlight is the window moving.

**No bus topic.** A bus event is for something an extension must ACT on —
`layout.rootClosed` is one, because a task archives itself when its pane group
empties. Which root is on screen is a **projection**, and projections travel in
the snapshot. Adding a topic for one would put a second transport under a value
the renderer already receives.

A root id is kernel vocabulary — the shell routes and draws by it — so naming one
in a row tells the shell nothing about what the row MEANS. ADR 0031 holds: what
the row is *about* stays the extension's, in `command` and `actions`. A shell
that knew a row was a *task* would be the violation; a shell that knows a row
corresponds to a root is the shell doing its own job.

## Consequences
Every path that moves the window moves the highlight, including the ones nobody
clicked, which is what `smoke:m3` now asserts — after a task is created through
the composer and the window follows the spawn. That assertion has to live in the
smoke: a unit test can only ever supply both sides of the comparison itself, and
what it cannot check is that the root id `tasks` writes is the same string the
kernel puts in the snapshot. Verified by mutation (wiring `activeRoot={null}`
fails it) rather than by having watched it pass.

`TreeItem.root` is absent on a row that is about no root, and such a row is never
drawn selected — the comparison tests the field's presence first, so a shell that
cannot name its active root does not light every rootless row.

A task row carries its root **even while archived**. There is no live root then,
but clicking one restores it at the same id, and withholding the field would
blank the highlight for exactly the moments after the window has just moved
there.

## Not decided here
**A selection that is not root-shaped.** A tree whose rows are files, PRs or
branches has a current row that no root id can express. `TreeItem.selected` —
a boolean the contribution owns — is the shape for that, and it was deliberately
removed rather than kept alongside this: today `tasks` is the only tree
contribution in the codebase, and a second mechanism with no consumer is a
mechanism nobody is maintaining against reality. Add it when there is such a
tree, and expect the two to coexist; they answer different questions.

**Reading the active root from an extension.** There is still no
`layout.activeRoot` verb, and under this decision nothing needs one. If some
extension later has to make a decision (not a projection) from which root is on
screen, that verb — plus seeding at activate, the shape `agents-core` already
uses for its viewing mirror — is the precedent to follow, not a re-announce
mechanism, which this codebase has declined twice in writing.
