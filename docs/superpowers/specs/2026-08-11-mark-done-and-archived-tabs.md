# Mark done, and an archive that restores exactly — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Scope:** `v2/` only. Builds on `2026-08-11-task-tabs-design.md` (a task owns a group of roots).

---

## The change

1. A task row gets a **checkmark on hover** — "mark done" — running the archive it already has.
2. **Archiving preserves the whole group**: every tab, its pane tree, each pane's cwd, its session identity, and the last 1000 lines of what was on screen.
3. **Restoring reproduces it**: the tabs come back with their splits and their scrollback painted. It does **not** relaunch agents — it rebuilds the *screen*, and each pane is left with its agent's resume line **staged at the prompt, unsubmitted**. Pressing Enter is what resumes an agent, and that is the user's to press.
4. An archived task **lives one week**, not thirty days.

## 1. The affordance — `TreeItem.primaryAction`

`Row` already has a hover slot and its rule 4 says so in as many words ("the trailing area is a 1-cell grid … a hover ACTION in every row that wants one"). What is missing is a way for a contributed row to *declare* one — `TreeItem` has `command` (the row's click), `presents` (the read-only twin) and `actions` (the right-click menu), and none of them is "the one verb worth a button".

```ts
  /**
   * The row's ONE verb worth a control of its own — drawn in the trailing slot,
   * revealed on hover and on keyboard focus within the row.
   *
   * Declared by the extension for the reason `actions` is: the shell cannot know
   * a row's verbs, and a sidebar that hardcoded a checkmark would be a sidebar
   * that knows what a task is (ADR 0031). Attributed to the CONTRIBUTING
   * EXTENSION, never to the user (D14) — the click is the user's, the command id
   * is not, and they cannot see it.
   *
   * Singular on purpose. A row with three hover buttons is a toolbar, and the
   * menu already exists for the rest.
   */
  readonly primaryAction?: {
    readonly id: string;
    /** The accessible name. Required — an icon-only control names nothing. */
    readonly label: string;
    readonly icon?: string;
    readonly args?: unknown;
  };
```

`tasks` declares `{ id: 'tasks.archive', label: 'Mark done', icon: 'check', args: { task } }` on a live task, and nothing on an archived one — the verb that is available is the one that changes its state, which is the rule its `actions` already follows.

**Not a new lifecycle.** "Done" is what archiving already means; this makes it a gesture instead of a right-click. The menu keeps its Archive entry, because a menu that lost an item the moment it grew a button is a menu that teaches you to hunt.

A remote client gets it for free: it is a field on a row it already draws, and it may render it as a swipe, a button, or nothing.

## 2. What archiving captures

Today `tasks.archive` snapshots the worktrees and closes the group. It also has to capture the group **before** `layout.closeGroup` runs, because that is what kills the ptys and takes the mirrors with them.

```ts
interface ArchivedPane {
  readonly pane: string;            // the id it had; a restored pane gets a NEW one
  readonly cwd: string | null;
  readonly userTitle: string | null;
  /** Opaque (D11). Stored unread, handed back unread. */
  readonly sessionId?: string;
  readonly kindId?: string;
  readonly resumeTarget?: string;
  /** Path, relative to the archive dir, of this pane's captured screen. */
  readonly history?: string;
}

interface ArchivedTab {
  readonly root: string;
  /** The split shape, as `serialize.ts` already writes one. */
  readonly tree: PersistedNode | null;
  readonly focusedPane: string | null;
  readonly panes: readonly ArchivedPane[];
}
```

`TaskRecord.tabs?: readonly ArchivedTab[]` — additive, `s.stored`, absent on every record written before this.

**Scrollback** comes from `SessionMirror.capture(sink, lines)`, which already exists and already serializes terminal state including scrollback — it is how a remote viewer is replayed on attach. It has no command; this adds one:

- **`sessions.capture { session, lines? }`** → `{ bytes: string }` (base64), `lines` defaulting to 1000.

The bytes go to `<dataDir>/.archives/<taskId>/<root>/<pane>.term`, and the record stores the relative path. A file per pane rather than a column: a build log is megabytes, and SQLite is where the *record* lives, not where a terminal's history does.

**Capture only happens on the path where there is something to capture — and
that is a real limit, found by the smoke rather than reasoned about.** Closing a
task's panes by hand destroys each screen as it goes, so by the time the last one
empties the group and triggers the archive, the roots are gone and there is
nothing to read. Marking a task done while it is on screen (the checkmark, or
`tasks.archive` from anywhere) is what preserves it. This is inherent: capturing
the other path would mean capturing continuously, against every pane, on the
chance that the next close is the last one.

**Capture is best-effort and never blocks the archive.** A session that has already exited has no mirror, and a task you cannot archive because one pane's history could not be read is a worse outcome than a tab that comes back blank. Failures are logged and the pane is archived without `history`.

## 3. What restoring rebuilds

For each `ArchivedTab`, in order:

1. `layout.openRoot { root, group, cwd }` for the first, `layout.newTab { group }` for the rest — the ids are the ones that were archived, so a restored task's tabs keep their names.
2. Rebuild the splits from `tree` through `layout.split`, and apply each pane's `cwd` and `userTitle`.
3. **Replay the history** into the pane.
4. **Stage the resume line, unsubmitted.**

### Replay belongs to the mirror, not to the renderer

`sessions.create` gains an optional `seed` (the captured bytes). The daemon pre-loads the new session's mirror with it, so **every** viewer replays it — the desktop pane that opened it, and a phone that attaches an hour later. A renderer-only seam (write the bytes into the xterm on mount) is cheaper and quietly desktop-only: the mirror is the one authority on what a new viewer sees, and a second answer to that question is exactly the shape ADR 0037 was written about.

### The resume line is TYPED, NOT RUN

This is the correction that shapes the whole feature: **restoring rebuilds the screen; it does not relaunch anything.** The agent still needs a command to resume, and issuing it is the user's.

`layout.setInitialInput` already documents that "a newline in this string is an **Enter press**", so a line staged **without** a trailing newline is typed into the pty and left sitting at the prompt. That is the whole mechanism — no new seam, and the invariant that there is exactly one initial input per pane is untouched.

So a restored agent pane shows its history, then its shell prompt, then the resume command ready to run. Press Enter and the agent comes back; do not, and nothing was spent.

A pane with no `resumeTarget` (a plain shell tab) stages nothing.

## 4. An archived task lives a week

`ARCHIVE_TTL_MS`: `30 * 24 * 60 * 60 * 1000` → `7 * 24 * 60 * 60 * 1000`. The comment's reasoning is unchanged — literal days, because a user asking "does this still exist" counts days.

The sweep that deletes an expired task must now also delete `<dataDir>/.archives/<taskId>`, or the history files outlive every record that names them and nothing will ever mention them again.

**Worth stating plainly:** with tabs and auto-staged resume, an archive is now a real shelf, and a week is a short one. If work is being lost to expiry, the number is the thing to change and it is one constant.

## Testing

**Unit.** `tasks`: the archive record for a two-tab group (shape, cwds, opaque ids, history paths); capture failure archiving the pane without history; restore rebuilding N roots with their splits; the staged line carrying **no trailing newline**; a record with no `tabs` restoring exactly as it does today. `expiry`: seven days, and the archive directory removed with the record. `view-dock`: a `primaryAction` row draws its control, attributes it to the extension, and an absent one draws nothing.

**The gate.** `pnpm smoke:m3`: archive a task with two tabs and an agent, assert the history files exist, restore it, and assert **both roots are back with their panes** and **no new agent process was started** — the last one is the claim the whole correction is about, and only the real app can make it.

## Out of scope

Restoring onto a machine other than the one that archived it (the history files are local); pruning history by size; a `done` lifecycle distinct from `archived`.
