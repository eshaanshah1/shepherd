# Workbench W5a — history (commits, blame, sequence seam)

> Design record. Roadmap:
> [`2026-07-26-unified-workbench-w1-w5-roadmap.md`](../plans/2026-07-26-unified-workbench-w1-w5-roadmap.md).
> Workbench spec: [`2026-07-26-unified-workbench-design.md`](2026-07-26-unified-workbench-design.md).
> W3, whose merge-preview mechanism and overlay this reuses:
> [`2026-07-27-workbench-w3-merge-resolver-design.md`](2026-07-27-workbench-w3-merge-resolver-design.md).

## What this adds

Three things, all reads plus one small write:

1. A **`Commits (n)`** scope — the branch's commits, each viewable as a diff in the same
   buffer.
2. A **blame lane** in the gutter, for whichever single file the buffer is narrowed to.
3. A **Continue** control that finishes a stopped rebase / cherry-pick / merge, which is
   the one hole the resolver left open.

## W5 is split in two, and this is the read half

The roadmap sizes W5 as "roughly W1–W4 combined" and lists five subsystems: commit list +
graph, commit-as-diff, blame, stash, cherry-pick, interactive rebase. That is not one spec.

The seam is **reading history mutates nothing**. Commits, commit-as-diff and blame reuse
`DiffParser`, `RowPlanner`, the gutter's existing geometry and W3's not-on-disk document
mechanism; stash / cherry-pick / interactive-rebase mutate the repo and carry sequence
state. So:

| | |
|---|---|
| **W5a — this spec** | Commits scope, commit-as-diff, blame lane, the sequence Continue seam |
| **W5b — later spec** | Stash, cherry-pick, interactive rebase (reorderable todo) |

The sequence seam sits in W5a despite being a write, for two reasons. It fixes a loop that
is **broken in the shipped product today** (below), and W5b's todo editor needs a working
continue path to drive rather than inventing one alongside its own work.

### There is no graph renderer

The Commits scope is scoped to `<base>..HEAD` — "what has this branch done", which is what
you want when reviewing an agent's work. That range is linear by construction and typically
1–30 commits, so there are no merge lanes to draw. A rail ~220pt wide showing your own
branch's commits is a list; lane assignment and merge curves would be decoration, and they
are most of what made the roadmap size this phase as it did.

Full-history exploration (any ref, paginated, real multi-parent lanes) is **out of scope and
not a deferred promise** — if it is ever wanted it is its own slice.

## The decision that shapes everything

**A commit is a document whose text is not on disk.**

Every text row in the workbench today is a real line of a file currently on disk. That
invariant is what makes an edit mappable: row → `rowOrigins` → `(path, line)` →
`SourceBuffer` → disk. A commit from three weeks ago shows a file *as it was then*; those
lines are not at those positions now, and the file may since have been renamed or deleted.

Rendering a commit through the disk-backed path therefore breaks in a way this project has
already been bitten by twice. The highlighter resolves a row to `(path, line)` and reads the
file at that line, so row 40 of an old commit gets painted with whatever sits at line 40
**today**. That is the bug that mangled highlighting on the first live run, and the same bug
one layer along when conflicted files anchored to `.new` and were coloured from the
marker-laden file on disk.

Editing is not a second problem to solve — editing history is not a thing. A commit view is
read-only, and the only requirement that carries is that it must be **visibly** read-only,
with the reason in the header, because silent read-only was the W2.2 defect.

### W3 already built the mechanism

A conflicted file is the same shape: text for a path that is not what is on disk.
`mergePreviews: [String: [String]]` holds the lines in memory, `HighlightVariant
.mergePreview` colours them, `RowPlanner` plans rows from supplied lines, and read-only-ness
is decided by **path membership** rather than by a flag someone can forget to check.

W5a extends that pattern to a third provenance rather than inventing anything.

### Two rejected alternatives

**A parallel read-only `CommitSession`** — its own storage, gutter, overlay, highlighter.
Hard isolation, but it duplicates every peripheral, which is the exact trade the
side-by-side design rejected when it chose one editor over two, and every W2/W4 affordance
would need porting into it or be visibly missing.

**Materializing the commit as a detached worktree** (`git worktree add --detach <sha>` to a
temp dir, then diff two real trees). Nothing in the architecture would change and everything
stays disk-backed — but it makes a real checkout, costing seconds and disk per commit
viewed, and an edit would silently write into a throwaway tree. That is a worse version of
the fabrication problem, not a solution to it.

---

## § 1 — Commits scope and the commit view

### The list

`CommitHistory` (pure, unit-tested) parses `git log --format=…` over `<base>..HEAD` into
`[Commit]`: full sha, short sha, subject, author name, ISO timestamp. **NUL-delimited
fields** (`%x00`) — a subject can contain anything, including `|` and newlines.

The range reuses `DiffReadResult.baseName`, which the diff layer already resolves from
`origin/HEAD` → `main` → `master`. Deriving it a second way is how the vs-base segment ended
up meaning two different things in W3.

The count is read in `load()` — one `git log` process, cheap on the scale of the reads
already there.

### Scope and navigation

`WorkbenchScope.commits`, bound to **`⌃4`** (`⌃1` working, `⌃2` vs-base, `⌃3` files are
taken). The `Commits (n)` pill segment appears **only when `n > 0`**, and is gated on
`session.isRepo` like the Working and vs-base segments — outside a repo there is no history,
and Files is the whole workbench. The rail reserves no space for it before that, per the
roadmap's constraint. With it, the pill can reach five segments, which the existing
wrap-past-three layout already handles.

Clicking a commit sets `selectedCommit`. The rail swaps the list for that commit's files
under a single section header — STAGED / UNSTAGED / COMMITTED is meaningless in history —
and a breadcrumb row (`‹ Commits · 1271110`) restores the list. This is the same
narrow-then-restore shape `focus(file:)` already has, so there is one mental model for
"clicking in the rail scopes the buffer" rather than two.

The header band shows subject, author, relative date, and **`read-only · historical
commit`**.

### The document, and why the change surface is small

`DiffReader.readCommit(cwd:sha:)` runs `git show -M --format= <sha>` and returns a
`DiffReadResult` through the existing `DiffParser`. `loadCommit(sha)` then sets `files` to
that result and `stagedFiles` to empty, and calls the ordinary `rebuild()`.

**`selectedCommit` is the only new state, and it is what "historical provenance" means.** A
separate provenance flag alongside it would be a second thing to keep in step with the rail's
selection, and the two disagreeing is precisely the sort of drift that produces a document
coloured from the wrong text.

**There is no third `rebuild()` branch.** A commit's diff *is* a diff; `RowPlanner
.plan(files:staged:revealed:opened:split:)` consumes it unchanged, and no new `BlockKind` is
needed. Only two points in the whole pipeline become provenance-aware:

1. **`sourceAnchor(atStitchedLine:)`** returns `.commit(sha:)` for rows of a historical
   document, where it currently picks `.mergePreview` or `.new`.
2. **The one `fileLines` lookup in `rebuild()`** — today
   `fileLines[path] = text(for: source(of: path))`, the working copy. It becomes
   provenance-aware: disk for a live diff, the `(sha, path)` blob for a commit.

That second one is load-bearing and easy to miss. Gap-revealed rows and rows of edited files
are the *only* rows whose text does not come from the diff itself, and they all funnel
through that single lookup. Left alone, expanding a hunk gap inside a three-week-old commit
splices **today's** lines into it — the same wrong-provenance bug, entering by a different
door. Fixed, gap expansion works normally in a commit view, so the gutter's expand arrows
stay live and there is nothing to suppress. (Dead click targets were one of last session's
nine defects; suppressing the arrows would have been the lesser answer.)

`WorkbenchScope.commits.mode` returns **nil**, alongside `.files`. The enum's doc comment
currently says nil means "a scope that is not a diff", which would become a lie — a commit
*is* a diff, just not one of the two live tree comparisons. The comment gets corrected in the
same change; `mode` is a pure property and cannot depend on `selectedCommit`, which is why
the commit document loads through its own path exactly as conflicts do.

### Blob text

`BlobCache` keyed `(sha, path)`, filled by `git show <sha>:<path>`, **lazily and off-main,
with a redraw callback**. The sha is in the key, so two commits touching the same file cannot
share a parse. `MultiHighlighter.invalidate(source:)` is already a filter rather than keyed
removals, which is exactly why a non-enumerable variant like `.commit(sha:)` is safe to add.

Laziness is not an optimization here, it is the recorded lesson: `SourceBuffer.init` eagerly
ran `git show` per file and paid 287 main-thread spawns before the first row drew.

This is also the correct implementation of a currently-deferred defect. Deletion bands parse
their base blob **from `draw`** — a `Process` on the main thread — recorded in the roadmap as
"`git show` from `draw`". `BlobCache` is the same shape done properly, and the band path can
adopt it afterwards.

### What the commit view does not offer

No staging (there is nothing to stage, so no rows carry stage buttons and `⌘⏎` says why —
the treatment committed files already get), no editing, no split-view old side beyond what
the diff itself carries.

---

## § 2 — The blame lane

### Presentation

An **always-on thin lane** (~5pt) between the line numbers and the sign column, present
whenever the buffer is narrowed to a blameable file. Contiguous rows of one commit form a
run: filled with an age-shaded tint (recent brightest), with a hairline separator between
adjacent runs.

Age gives the heat, the separator gives the grouping, so "this whole block is one change"
reads without two encodings fighting. Colours are `Theme` tokens like every other colour in
the app.

A wide `author · date` text column was considered and rejected on the precedent that
already exists: W1 took the gutter from ~138pt to ~66pt by deleting a second number column,
and removed the staging checkbox column outright, both on the principle that per-row width
reserved for an occasional job is not worth it.

### The text has to be on screen somewhere

A lane alone encodes shape and no facts, and hover-only text is never actually visible. So
the blame text has one destination and two sources:

- The **header** carries a one-line annotation — `1271110 · Eshaan Shah · 2h ago ·
  side-by-side diff, and a hard gate on conflicts` — sourced by default from the **cursor
  row** (`cursorStitchedLine` already exists and is already published).
- **Hover** over the lane overrides it; leaving restores the cursor row.

Hover is then an accelerator rather than the only path to the information.

### Reading blame

`git blame --porcelain`, **not** `--line-porcelain`: porcelain emits a sha's author/time/
summary headers only on that sha's first occurrence, so the output is already grouped by run
and a fraction of the size. `BlameParse` (pure, unit-tested) folds it into per-line
`(sha, author, timestamp, summary)` plus a `sha → meta` map — the dictionary carry is
required precisely because of that header elision.

Uncommitted lines come back as an all-zeros sha with author `Not Committed Yet`. That is a
real state the lane draws distinctly, not a parse failure.

### When it runs

Only when the buffer is narrowed to **one** file — `focus(file:)`, or a single-file Files
scope. Off-main, one process per path, cached. **Never** for the whole-diff view: 287 spawns
is the mistake `SourceBuffer.init` already made once.

The lane occupies width only when there is a blameable file displayed. Focusing rebuilds the
editor anyway (`EditorHost` keys `SourceEditor` on `.id(session.revision)`), so there is no
width animation to jar.

Invalidation: a path's blame is dropped when that file is saved or externally written, and
the whole cache is dropped when HEAD moves (commit, checkout, or a sequence step).

### Rows with no blame draw nothing

- **Deletion bands** — old-side lines. Blaming those is `git blame <sha>^` against a
  different revision, which is a different feature.
- **Merge-preview rows** — the file is mid-merge; there is nothing coherent to blame.
- **Commit-view rows** — `git blame <sha> -- <path>` would be correct and is deliberately
  deferred rather than half-built.

Drawing nothing is the point: a lane that guessed would be worse than a lane that abstains.

### Gutter mechanics, and the rules it inherits

`DiffGutterView` gains the lane in its `width(maxLineNumber:)` sum and its `draw`, plus an
`NSTrackingArea` over the lane's x-range (`.mouseMoved`, `.mouseExited`,
`.activeInKeyWindow`), re-added in `updateTrackingAreas`.

Three existing rules apply unchanged, each having cost this project real time:

- **Rows resolve through `lineIndex(documentY)` → `textLineForPosition`**, never arithmetic
  from `rowHeight`. A row carrying a band is not one row tall, and a second opinion about
  where a row sits is what took two days to unlearn.
- **A block's internal rows divide the block's own height**, if the lane ever draws inside
  one.
- **Re-install on every attach with no "already installed" short-circuit.** A rebuild hands
  us a new editor, scroll view and clip view; that short-circuit is what left the gutter
  observing a dead clip view and frozen from the first rebuild onward.

**Clicking the lane** jumps to that commit in the Commits scope — closing the loop between
§ 1 and § 2. The gutter already draws *and* hit-tests its own targets (the gap arrows), so
this is an existing answer, not a fourth one; `WorkbenchOverlay` is not involved because the
lane is gutter-owned. The hit test checks **x-range first**: a gutter click/drag already
means "select these lines for staging" and the lane must not steal it.

`BlameLane.runs(...)` — consecutive rows → runs, timestamp → shade bucket — is pure and
unit-tested.

---

## § 3 — The sequence seam (rebase / cherry-pick / merge)

### The hole that exists today

Start `git rebase main` in a terminal pane. It stops on a conflict. Resolve that conflict in
the workbench — which works, and is W3. Now nothing finishes the rebase: **`--continue`
appears nowhere in `Sources/`.** `hasConflicts` goes false, the lock lifts, and the sequence
sits half-applied until you go back to the terminal.

W3 built more of this than the roadmap credits. `MergeState` already detects `.merge` /
`.rebase` / `.cherryPick`, reads `msgnum`/`end` for "3 of 7" progress, and resolves real ref
names (`ConflictIntegrationTests` pins the rebase side-inversion). `abortOperation()`
already dispatches `<verb> --abort`. The missing piece is one command and the state around
it.

### The state with no representation

`mergeState.isActive && !hasConflicts` — a stopped sequence with nothing unmerged. Four ways
to arrive: the resolver settled the last file; a rebase stopped on an `edit` or `break` todo;
a merge whose conflicts are resolved but uncommitted; and, in W5b, the todo editor. Today all
four are indistinguishable from a clean repo.

### One uniform action

`continueOperation()` → `git <verb> --continue`, reusing the same verb mapping
`abortOperation()` has. All three operations support `--continue`, so there is no special
case.

### The commit message, verified against real git

`--continue` opens `$GIT_EDITOR` for the commit message. A `Process` spawned from an app
bundle has no tty, so left alone it either errors or **hangs forever holding
`writing = true`** — an unkillable spinner.

Rather than force `GIT_EDITOR=true` and lose rewording, the stopped message is surfaced and
made editable. Probed against **git 2.55** rather than assumed, because W3 was burned by
exactly this class of assumption (`rebase-merge/onto_name` does not exist for a plain
`git rebase`, which put forty hex characters on a button):

| Operation | File holding the pending message |
|---|---|
| rebase (default merge backend) | `rebase-merge/message` |
| merge | `MERGE_MSG` |
| cherry-pick | `MERGE_MSG` |

All resolvable through `rev-parse --git-path`, which `ConflictReader.gitFile` already does,
so linked worktrees and non-default layouts work. **All three contain a trailing
`# Conflicts:` comment block** that git strips at commit time; it is filtered for display.

Continue then has two paths:

- **Message untouched** → `GIT_EDITOR=true`. Git commits exactly what it had.
- **Message edited** → write it to a temp file and set `GIT_EDITOR="cp '<tmpfile>'"`. Git
  appends the target path to that string, so its editor invocation becomes a copy of our text
  over its message file. Verified end to end: `rebase --continue` exited 0 and the resulting
  commit carried the supplied subject.

The `cp` form depends only on documented `GIT_EDITOR` behaviour — a command string with the
file path appended — rather than on git's internal file layout, which is the more stable of
the two. The path is single-quoted because git runs the string through a shell.

If **no** message file exists (a rebase stopped on `break`), the field is not shown at all,
rather than presenting an empty box that implies a commit is pending.

### The loop

Continue runs off-main, then calls `loadConflicts()` — and nothing else:

- **New conflicts** → `mergeFiles` fills, the lock re-engages, the scope is forced to Files
  (`WorkbenchView.onChange(of: session.hasConflicts)` already does this), and progress
  advances to "4 of 7" on its own.
- **Sequence finished** → `MergeState.idle`, the banner clears, and a full `load()` runs
  because the tree just changed under every row on screen.

The property that makes this safe: **no sequence state of our own is cached.**
`ConflictReader.readState` re-reads git's files on every load, so our position cannot drift
from git's. The "recursion into W3" the roadmap warned about is not recursion — it is the
same load path arriving at a new conflict set.

### The lock extends from conflicts to the whole operation

Today the gate is `hasConflicts`, so resolving the last file **unlocks the workbench
mid-rebase** — you can switch to vs-base while HEAD is a detached replay state, where "vs
base" is meaningless.

The gate becomes **`hasConflicts || mergeState.isActive`**, in `setScope` and in
`resolveOnly`, with the scope-forcing `onChange` widened to match. A mid-sequence tree is
exactly as broken as a conflicted one, and the only doors out become Continue and Abort.

Failure mode: a stale `rebase-merge` directory would lock the workbench with nothing to
resolve. Two things bound it — Abort is always enabled, and the lock is re-derived from git's
own files on every load, so it clears the instant git's state does.

### Where it renders

The rail footer already draws `mergeState.summary` and the abort row. While a sequence is
active it becomes the sequence panel — summary, the message field when there is one,
**Continue**, **Abort** — in place of the ordinary commit box, which mid-sequence would
create a stray commit.

Continue is enabled when `isActive && !hasConflicts && !writing`; otherwise it is **disabled
with the reason** ("3 conflicts left"), never dead. Git's stderr goes to the existing
`lastError` row — `--continue` refusing because a hand-resolved file was never staged is a
real case, and it must show git's own words.

`SequencePolicy` (pure): can-continue, plus the reason when not.

---

## New units

Pure (no AppKit; in `ShepherdModelTests`, added to the target's explicit `sources:` list):

| Unit | Responsibility |
|---|---|
| `CommitHistory` | `git log` output → `[Commit]`; NUL-delimited parse |
| `BlameParse` | `--porcelain` output → per-line blame + `sha → meta` |
| `BlameLane` | consecutive rows → runs; timestamp → shade bucket |
| `SequencePolicy` | can-continue and the reason; message-comment stripping |

Impure:

| Unit | Responsibility |
|---|---|
| `BlobCache` | `(sha, path)` → blob text, lazy, off-main, redraw callback |
| `SequenceRunner` | `--continue` spawn incl. the `GIT_EDITOR` choice; pending-message read |

Changed: `DiffReader` (`readCommit`), `WorkbenchScope` (`.commits` + the corrected `mode`
comment), `HighlightVariant` (`.commit(sha:)`), `WorkbenchSession` (`selectedCommit`, the two
provenance points, `continueOperation`, the widened lock),
`DiffGutter` (lane + tracking area + x-range hit test), `WorkbenchView` (Commits rail,
breadcrumb, header annotation, sequence panel), `ShortcutCatalog` (`⌃4`, display-only).

History lives in its own types with `WorkbenchSession` coordinating. The session is already
1991 lines; W5a would add ~400 more, and growing it further is how the next round of
coordinate-mapping bugs gets easier to write.

## Testing

Pure units per the table above. One **real-git integration test** on the
`ConflictIntegrationTests` pattern (real repos, real git, because only real git knows what
files it writes): a three-commit rebase where commits 2 and 3 both conflict — resolve →
continue → conflict → resolve → continue → idle, asserting progress reads 2/3 then 3/3 and
that the final tree is what git considers rebased. It covers **both message paths**, and
`merge --continue` / `cherry-pick --continue`.

That test is the only thing that can prove the `GIT_EDITOR` handling works, because the
failure mode is a hang, which no unit test and no green build can see.

### Green tests are not the bar

Nine defects last session were found by a person pressing something — the crash, the overlay
never drawing, bands vanishing on resolve, dead click targets. Before this merges, in
`ShepherdDev`:

1. Commits scope → drill into a commit → confirm syntax colours are **that commit's** text,
   then expand a hunk gap inside an old commit. This is where wrong provenance shows.
2. Blame lane on a focused file: scroll hard and confirm the lane tracks the text, the header
   annotation follows the cursor, hover overrides it, and clicking jumps to the commit.
3. The sequence loop on a real two-conflict rebase, both keep-message and reword.

Never `killall Shepherd` — it is the user's daily terminal.

## Risks carried deliberately

- **`git blame` is slow on a large file with deep history.** v1 is one off-main shot with an
  empty lane until it lands. If it drags, the escalation is `--incremental` streaming, not a
  spinner in the gutter.
- **The widened lock** can strand the workbench on a stale sequence directory. Bounded as
  described above.
- **A commit touching many files** costs one `git show <sha>:<path>` per file whose rows get
  highlighted. Lazy and cached, but a 200-file commit drilled into and scrolled end to end
  will spawn 200 processes over its lifetime. Acceptable; measure before optimizing, per the
  virtualization finding.

## Deferred, recorded so it is not mistaken for done

- **Blame inside a commit view** (`git blame <sha>`) and **blame on deletion bands**
  (`git blame <sha>^`). Both draw nothing today.
- **Full-history exploration** — any ref, pagination, multi-parent lanes. Not a promise.
- **Rewording arbitrary past commits.** W5a rewords only the message of the commit a
  sequence has stopped on, because that is the one git is already asking about.
- **`GIT_SEQUENCE_EDITOR`** — W5b's `rebase -i` needs the same treatment for the todo list.
  Recorded here so it is not rediscovered.
- **Adopting `BlobCache` in the deletion-band path**, retiring the `git show`-from-`draw`
  defect.
- **W5b entirely**: stash, cherry-pick, interactive rebase.
