# Multiple tabs per task — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Scope:** `v2/` only. Nothing under `spike/` is touched.

---

## The change in one sentence

A task owns **one layout root** today; it should own **a group of roots**, the
window should draw a tab strip for the group it is showing, and the sidebar
should list a task's tabs under it — each with its own status dot.

Before: a task = one root = one splittable pane tree.
After: a task = one **group** = N roots, each a splittable pane tree, one on
screen at a time.

## Why a group of roots rather than a tab inside a root

`LayoutStore` already keeps every root mounted and hides the inactive ones with
`display: none` — because "a remounted pane is a new pty" (v1's lesson, recorded
in `app.tsx` and `channels.ts`). Tabs therefore cost **nothing new**: switching
tabs is `layout.switchRoot`, which the sidebar, the CLI and `tasks` already do,
and a hidden tab's agents keep running by construction.

The alternative — `root → tabs[] → tree` inside the store — breaks the one thing
ADR 0035 pinned down: **a sidebar row names a root, and the shell derives the
highlight from the same snapshot value it draws the stage from.** Every
root-level verb (`switchRoot`, `closeRoot`, `openRoot`), the persisted payload,
and `TreeItem.root` would each have to grow a tab coordinate, and the highlight
would need a second value to compare. Grouping roots adds one field and leaves
every existing path meaning exactly what it meant.

It is also **generic**: `group` is an opaque string the kernel never interprets.
`tasks` names its group `task:<id>`; the home root's group is `window-1`, which
is how the home root gets ordinary terminal tabs for free. No kernel code learns
what a task is (ADR 0031).

---

## 1. Core — a root belongs to a group

`packages/core/src/layout/store.ts`

`RootState` gains **one** field:

- **`group: string`** — defaults to the root's own id, so a lone root is a group
  of one and every existing root keeps behaving identically. Set at mint only:
  a root does not move between groups, because the thing that owns the group
  (a task) is also the thing that opened the root.

There is deliberately **no root title.** A tab is named by its focused pane, via
the `displayTitle` that already exists and whose doc comment already says it is
"what the sidebar and the tab strip show" — see §3. A second name on the root
would be a field nothing sets and a second answer to a question that has one.

`group` is persisted in `PersistedLayout.roots[]` and stays at
**`schemaVersion: 1`**, for the same reason the nullable `tree` did: an older
build reading a payload with `group` ignores the unknown field and gets N
independent roots — which is exactly today's behaviour, not corruption. Bumping
the version would instead discard the whole payload, including roots that decode
perfectly.

New store surface:

```ts
groupOf(root: RootID): string | undefined
rootsInGroup(group: string): readonly RootID[]   // creation order = tab order
newTab(group: string, init?: PaneSeed): Result<RootID, string>
```

`newTab` mints `${group}/tab-N` with the smallest unused N, checked against both
live and persisted roots. Readable ids are deliberate: they show up in
`daemon.log`, in `shepherd raw layout.listRoots`, and in the persisted payload,
and `task:t1/tab-2` is legible where a random id is not.

`project()` (the extension-facing `LayoutRoot`) gains `group`, so an extension
can ask which roots belong together without knowing how ids are built.

**Tab reordering is out of scope.** Tab order is root creation order. Drag-to-
reorder needs an explicit order field and a persisted mutation; there is no
caller for it yet (ADR 0031).

## 2. Core — the verbs

`packages/core/src/layout/commands.ts`

| command | change |
|---|---|
| `layout.openRoot` | gains `group` (optional; defaults to the root id) |
| `layout.newTab` | **new** — `{ group?, cwd?, initialCommand? }` |
| `layout.closeGroup` | **new** — `{ group }` |
| `layout.listRoots` | **new** — `{ group? }`, read-only |
| `layout.closeRoot` | falls back to a sibling tab before the home root |
| `layout.switchRoot` | a group anchor lands on the group's last-active root |

**`layout.newTab`** defaults `group` to the active root's group and `cwd` to the
active root's focused pane's cwd — so `+` inside a task lands in that task's
worktree without the kernel knowing what a worktree is. It mints, switches, and
returns `{ root, pane }`.

**`layout.closeGroup`** drains every root in the group through `store.close`
before `removeRoot`, because `layout.close` is the one terminator (ADR 0022) and
dropping a root without draining it leaks a live pty per pane with nothing left
pointing at it. This is what `tasks.archive` and `tasks.delete` call.

**`layout.listRoots`** exists because `createLayout()` in the extension host
refuses every synchronous read (`ACROSS_A_PORT`), and `tasks` now needs to know
which roots are in its group and what they are called in order to draw its
sidebar rows. It answers `[{ root, group, label, focusedPane, focusedSession }]`
— where `label` is the resolved `displayTitle` of the root's focused pane, so
the desktop strip, the sidebar and a phone all read one string computed in one
place. A command, like every other thing an extension reaches across the port.

**`layout.switchRoot` on a group's anchor** resolves to that group's
most-recently-active root, so returning to a task puts you back on the tab you
left. Resolved in `main/index.ts`, where `activeRoot` already lives and where a
`Map<group, RootID>` of last-active can be maintained in one place; core
validates and delegates, as it already does. Switching to a root that is *not* a
group anchor is unchanged and lands exactly there.

### `layout.rootClosed` grows `group` and `groupEmpty`

This one is load-bearing rather than cosmetic. `tasks` archives a task when it
sees `layout.rootClosed` for `task:<id>` (the inference from counting sessions
was already found wrong across a relaunch — pane ids are regenerated). With
tabs, two things break unless the event says more:

- closing the last pane of **tab 2** emits `rootClosed` for `task:t1/tab-2`,
  which matches no task and is silently ignored — correct by accident, and only
  because of how ids happen to be built;
- closing the last pane of **tab 1** while tab 2 is still running emits
  `rootClosed` for `task:t1` and **archives a task with a live agent in it**.

So the payload becomes `{ root, group, groupEmpty }` and `tasks` reacts to
`groupEmpty && group === taskRootId(task.id)`. A task is finished with when all
of its tabs are, which is also the only reading a user would expect.

`onLastPaneClosed` in `main/index.ts` switches to a **sibling tab** when one
exists, and to the home root only when the group is empty. The home root's own
rule is unchanged: it empties and the window stays open on `EmptyState`.

### New bus topic: `layout.rootsChanged`

Emitted (debounced, alongside the existing persist debounce) whenever a root is
added, removed, or its focused pane is renamed or changes OSC title. `tasks` subscribes
in order to re-emit its tree when a tab's OSC title changes — without it, the
sidebar's tab labels would be whatever they were at spawn time forever.

## 3. Shell — the tab strip

`packages/app`

`LayoutSnapshot` gains `group: string`.

**A new `TabStrip` primitive in `@shepherd/ui`** (`tab-strip.tsx` +
`tab-strip.css`) — not hand-rolled in the renderer, per the design-system rule.
It paints in role tokens, marks the active tab, and carries a `+`.

Rendered inside `sh-stage`, above the roots and as a sibling of them (never
wrapping them — the hidden roots must stay mounted). **Visible only when the
active group holds more than one root**, so a single-tab task and today's app
look identical; the strip appears when a second tab does, the way Safari's does.

- clicking a tab → `layout.switchRoot { root }`
- `+` → `layout.newTab {}`
- accelerator: **`⌘⇧T`**. `⌘T` is `tasks`' composer overlay and stays that.

**Tab label = `displayTitle(focusedPane, home)`** — the function that already
exists in `layout/pane.ts` and whose doc comment already says it is "what the
sidebar and the tab strip show": the user's name (`userTitle`, `null` by
default), else the program's live OSC title, else a two-component tail of the
cwd. Renaming a tab is `layout.rename` on its focused pane; there is no second
naming mechanism and no new resolution rule to keep in step with this one.

The consequence to know rather than to fix: `tasks` writes
`Ship the login fix · api` into the spawned pane's `userTitle` today (index.ts
:1025), so a task's agent tab is labelled with the task name and its repo. That
is left exactly as it is — it is already what the pane head strip and the
titlebar breadcrumb show, and changing it to make tab labels shorter would
change two surfaces that are not this feature.

**`ViewDock`'s row highlight becomes group-aware:** a row is selected when
`groupOf(row.root) === groupOf(active)`. Still one reading of one snapshot value
— the map from root to group arrives in the same envelope the stage is drawn
from, so ADR 0035 holds unchanged and no new state is introduced anywhere.

## 4. Shell — the sidebar sublist

A task row's children become **its tabs**, drawn the same way whether there is
one or five:

```
▾ Ship the login fix        provisioning api…
     ● api
     ● logs
     … +3
```

- **Always shown, even for one tab.** The layout does not change shape as tabs
  are added, which is the whole reason to draw it for one.
- **Capped at three rows.** With ≤3 tabs, three tab rows. With more, two tabs
  and a `… +N` row.
- **The two it shows are the two that WANT YOU** — not the first two. An agent
  that has finished its turn, a shell command that completed while you were
  elsewhere: those are the tabs worth a row, and a cap that showed tab 1 and tab
  2 would hide exactly the thing the sidebar exists to surface. The order is
  `ROLLUP_PRIORITY`'s (`blocked`, `error`, `needsCheck`, `working`, `idle`) with
  creation order as the tie-break, so a quiet task still reads left-to-right and
  a loud one floats what changed to the top. `needsCheck` is the state this rule
  is really about, and it is already the one that clears the moment you look at
  the pane — so a row promoted for wanting you stops being promoted as soon as
  you have seen it.
- **Each tab row owns its status dot** — `tint` is the agent rollup over the
  panes *in that root*, not over the task. The task row's dot stays the rollup
  over all of them, so a collapsed task still says what it says today.
- **`… +N` expands in place.** It invokes `tasks.expandTabs { task }`, which
  flips a per-task in-memory flag and nudges the tree; expanded, every tab is
  listed with a `… less` row at the end. Nothing new crosses the wire and it
  works on a phone unchanged.
- **The task's label stays the AI-generated title.** Untouched.

**The per-repo child rows go away.** They were the task row's children and the
tabs now hold that slot; what they said — `ready`, `provisioning`, `hook failed`
— folds into the task row's `description`, which already carries state and
already appends trouble (`provisioning api…`, `ready — hook failed`). One
sublist with one meaning.

For `tasks` to draw a per-tab dot it must know which root each of its sessions
is in, so **`TaskSession` gains `root: string`**, written at spawn and persisted.
Deriving it by walking the layout every render is the "second copy of what is on
screen" that ADR 0035 warns about; the session's root is a fact about the spawn,
fixed at the moment the pane was created.

## 5. `tasks`

- `taskRootId(id)` becomes **the group id and tab 1's root id** — one string,
  two roles, and the file's existing note about four callers agreeing still
  applies unchanged.
- `openAgentPane` passes `group: taskRootId(task.id)` to `layout.openRoot`, and
  keeps splitting into tab 1 for a second agent. (Spawning into whichever tab is
  on screen is a nicer gesture and a different decision; not now.)
- `tasks.archive` / `tasks.delete` call `layout.closeGroup` instead of
  `layout.closeRoot`.
- the archive-on-close listener gates on `groupEmpty`.
- new command `tasks.expandTabs { task }`.
- `tasks.presentation` gains an optional `root`, so it can answer for one tab.

## 6. Remote

**No new wire vocabulary, which is the point.** `control.ts` says it deliberately
invents none: a phone is another shell, `TreeItem` is already renderer-agnostic,
and `PresentEffect` already says what a tap should show.

The tab rows `tasks` returns for the desktop sidebar **are** the remote payload:

```
▾ Ship the login fix        root=task:t1
     ● api                  root=task:t1        presents→ tasks.presentation
     ● logs                 root=task:t1/tab-2  presents→ tasks.presentation
     … +3                   command→ tasks.expandTabs
```

- `root` gives the row its identity, so a remote shell highlights the tab it is
  showing from its own reading of its own active root;
- `presents` returns `{ kind: 'session', sessionId }` for **that tab's** focused
  leaf, re-checked at click time (a recorded session id presented without
  checking is the scar that field already carries), so a phone attaches to the
  right pty and this Mac's window does not move;
- `command` stays `tasks.reveal` on the task row — the desktop gesture — and a
  remote client uses `presents` instead, exactly as it does today.

`… +N` works remotely for free: it is a row with a command, and expansion is
host-side state re-emitted through `onDidChange`.

---

## Testing

**Unit** — `layout/store.test.ts`: group defaulting, `rootsInGroup` order,
`newTab` id minting against live *and* persisted roots, `closeGroup` draining
every pane through the terminator, persistence round-trip with `group`, and a
payload-without-`group` restore (every root its own group, today's behaviour). `layout/commands.test.ts`: sibling
fall-through on `closeRoot`, `groupEmpty` on the last root only, anchor →
last-active resolution. `tasks`: the cap-at-3 shape for 1/2/3/4/5 tabs, expanded
and collapsed, per-tab tint rollup, `presentation` for a named root.

**The gate.** A green unit suite is not a working app and this repo has the scars
— the archive-on-close bug passed every unit test because each supplied both
halves of the correlation. `pnpm smoke:m3` must be extended and must pass:
open a task, add a tab, put an agent in each, switch between them and assert
**both ptys survive** (the mount rule), close tab 1's last pane and assert the
task is **not** archived while tab 2 lives, then close tab 2 and assert it is.

Every command runs `env -u NODE_OPTIONS`.

## Out of scope

Tab reordering; moving a tab between tasks; per-tab worktrees (a tab is a view
onto the task's worktrees, not a second checkout); a tab strip for the home root
beyond what falls out of the generic implementation.
