# Workbench W5b — power tools (stash, cherry-pick, interactive rebase)

> Design record. Roadmap:
> [`2026-07-26-unified-workbench-w1-w5-roadmap.md`](../plans/2026-07-26-unified-workbench-w1-w5-roadmap.md).
> W5a, whose commit document, blob cache and sequence seam this reuses wholesale:
> [`2026-07-28-workbench-w5a-history-design.md`](2026-07-28-workbench-w5a-history-design.md).
> W3, whose resolver every conflict here lands in:
> [`2026-07-27-workbench-w3-merge-resolver-design.md`](2026-07-27-workbench-w3-merge-resolver-design.md).

## What this adds

The write half of W5, and the last phase of the workbench:

1. **Rewrite mode** — the W5a Commits list becomes a reorderable interactive-rebase todo.
2. **Cherry-pick** — from a branch or Shepherd worktree other than this one.
3. **Stash** — a `STASHES` section in the Commits rail; create, preview as a diff, apply,
   pop, drop.
4. **Loose conflicts** — the state W5a's mirror image left out, which locks the workbench
   today with no way out.

## The spine: this adds starters, not an engine

Every one of the three verbs ends in the same place — an operation that either completes or
stops with conflicts — and W5a already built that end. `SequenceRunner.cont` runs
`--continue`, `SequencePolicy.outcome` classifies it off whether HEAD moved, `isMidSequence`
gates every scope, and `loadConflicts()` is the path that arrives at a new conflict set.

So W5b writes almost no new machinery. It adds **ways to start** that machine, and **one
state the machine cannot currently express**. The roadmap's warning about "conflict recursion"
stays answered: it is not recursion, it is the same load path arriving at a new conflict set.

### Five git behaviours probed before being coded against

W3 lost time assuming `rebase-merge/onto_name` exists for a plain rebase; W5a found that
`--continue` exits non-zero when it stops at the next commit. Both were measured, not
reasoned about. These were measured the same way, against **git 2.55**:

| Fact | Consequence |
|---|---|
| **A stash is a 3-parent merge commit**, and `git show -M -m --first-parent --format= stash@{0}` yields exactly its tracked changes vs HEAD-at-stash-time | `DiffReader.readCommit` reads a stash **unchanged**. The `-m --first-parent` W5a added for merge commits is what makes this work; without it the output is not the diff you want |
| `GIT_SEQUENCE_EDITOR` is a **command string with the todo path appended**, exactly like `GIT_EDITOR` — `cp '<file>'` substitutes a todo, path-with-spaces included | the todo writer is a temp file plus a `cp`; no shell script, no tty, no hang |
| git 2.55 writes todo lines as **`pick <shortsha> # <subject>`** (confirmed with global *and* system config neutralised — not a local setting), and a todo of bare `pick <sha>` lines with **no subject at all** rebases correctly | the subject is decoration and identity is the sha. **We never parse git's todo — we only write one**, which sidesteps the format entirely |
| An **empty todo** produces `error: nothing to do` and unwinds cleanly — not a half-applied state | "the user dropped every commit" needs a UI refusal for clarity, not a safety guard |
| A **cherry-pick sequence** uses `sequencer/todo`, has **no `msgnum`/`end`**, and keeps **no record of the original total** — the todo shrinks as picks land and there is no backup file | `ConflictReader` reports `progress: nil` for cherry-pick today. The honest label is `2 remaining`, never `2 of 5`, because the 5 is not recoverable from git |

A sixth, which is the reason § 4 exists at all, is in that section.

---

## § 1 — Rewrite mode (interactive rebase)

### The list you read becomes the list you rewrite, but only on purpose

W5a's Commits rail already shows exactly `<base>..HEAD` — the branch's own commits, oldest
last. That is precisely a rebase todo's contents, so the todo editor is that list with a verb
per row and drag to reorder. Nothing new needs to be listed, fetched or laid out.

It is an **explicit mode**, entered from a `Rewrite` button, not an always-live affordance.
The list you scroll while reviewing an agent's work must not be the list where a stray drag
rewrites history. Entering copies `commits` into `[PlanRow]` and touches nothing; leaving via
`Cancel` discards it. Apply is the only thing that runs git.

### The plan is pure, and it is where the bugs would be

`RebasePlan` (pure, tested) turns `[PlanRow]` into todo text and decides whether the plan may
run at all. Three rules carry real weight:

**Order is inverted.** git's todo is oldest-first; the rail is newest-first. The emitted todo
must be the reverse of what is on screen. This is the same class as `SplitAxis`'s `.row`
meaning side-by-side — a thing that reads either way and is therefore tested rather than
reasoned about. Getting it backwards would silently reverse a branch's history.

**The first row cannot be `squash` or `fixup`.** There is nothing before it to squash into;
git errors out. The plan refuses with a reason, in the rail, before anything runs.

**All `pick` in the original order is a no-op.** Apply is disabled saying so, rather than
running a rebase that rewrites every sha for no reason — which is not harmless, since it
invalidates any PR the branch has.

### One message-editing entry per plan

`reword` and `squash` both open `$GIT_EDITOR`, and the `cp '<file>'` substitution can supply
exactly **one** message. A plan with two rewords would give both commits the same subject.

So v1's rule: **at most one message-editing entry per plan**, validated in `RebasePlan` with
a reason on the disabled Apply. `fixup` keeps the base commit's message and discards the
other's, so it opens no editor and is unlimited. That leaves reorder + drop + any number of
fixups + one reword-or-squash, which covers tidying an agent's commit series; needing more
means applying and rewriting again, which is a fine loop and is what the button is for.

The alternative — a helper script that pops messages from a list in order — buys a rarer case
at the cost of a shell script in the write path. Rejected for v1, recorded here so the reason
survives.

Messages are collected **before** Apply, in the rail, so the plan is complete when it runs.
A rebase that stops to ask a question is the failure mode `GIT_EDITOR` exists to prevent.

### Apply, and what happens when it stops

`git rebase -i <base>` with `GIT_SEQUENCE_EDITOR="cp '<temp todo>'"`, and `GIT_EDITOR` either
`true` or the same `cp` form for the one message. Then `loadConflicts()`, which is the whole
of the stop handling: a conflicting pick fills `mergeFiles`, the lock re-engages, the scope
forces to Files, and the existing Continue drives the rest. **A stopped `rebase -i` is
structurally identical to the stopped plain rebase W5a already handles** — git 2.55 runs both
through the merge backend and writes the same `rebase-merge` directory, `msgnum`/`end`
included.

Rewrite mode exits on Apply. If the rebase stops, the sequence panel owns the screen, and the
plan is finished — the remaining todo is git's, not ours.

### What Rewrite mode does not offer

- **`edit` and `break`.** Both stop the rebase for work that is not the workbench's shape —
  amend this commit by hand, run something. They belong to a terminal.
- **`rebase --edit-todo`.** The plan is built before Apply; a live todo mid-stop is git's.
- **`--autosquash`**, rebasing onto a different base, and splitting a commit.
- **Rewriting anything outside `<base>..HEAD`.** W5a's no-full-history decision stands.

---

## § 2 — Cherry-pick

### The source problem, and why a picker is the answer

W5a's Commits scope is `<base>..HEAD` by design, which is definitionally every commit you
would *not* cherry-pick. A cherry-pick source lives on another branch — and in Shepherd, very
often in another **worktree**, because that is where each agent works.

So the Commits rail grows a `from: [ ref ▾ ]` control. One call fills it:

```
git for-each-ref refs/heads \
  --format='%(refname:short)%00%(worktreepath)%00%(committerdate:unix)%00%(subject)'
```

`%(worktreepath)` is non-empty exactly when that branch is checked out in a worktree — the
main checkout included — so the picker can mark the ones that are live agents without a second
command. Sorted by commit date descending, because this repo has dozens of branches and the
interesting ones are recent. **The current branch is excluded**: cherry-picking from yourself
is not a thing, and it is the one branch whose `worktreepath` is always set.

Choosing a ref lists `HEAD..<ref>` — what that branch has that this one does not.
`CommitHistory.logArguments` generalizes from `base: String` to an arbitrary range; the
existing `<base>..HEAD` call becomes one caller of it.

This is **bounded** history browsing: one ref at a time, no graph, no pagination, no
multi-parent lanes. It does not reopen the question W5a closed; it answers a different one.

### Picking

Selecting one or more commits and confirming runs `git cherry-pick <sha> [<sha>…]` in
oldest-first order. Conflicts land in the existing lock and Continue loop with no new code —
that is the whole point of the spine.

Clicking a source commit **previews it read-only** through `readCommit`, since it is an
ordinary commit of an ordinary ref. Provenance, colours and read-only all come from
`DocumentProvenance` unchanged.

### The progress counter that is missing today

A multi-commit cherry-pick stops with `CHERRY_PICK_HEAD` and `sequencer/todo`, and
`ConflictReader` passes `progress: nil` for it — so the banner says `cherry-pick` and nothing
else while five picks are pending. Reading `sequencer/todo`'s line count gives **remaining**,
and the original total is genuinely not recoverable (measured: the todo shrinks in place, and
the sequencer directory holds only `todo`, `head` and `abort-safety`).

`MergeProgress` therefore gains a remaining-only shape, and the banner reads
`cherry-pick · 2 remaining`. Inventing a denominator by remembering what we started with
would be a cached sequence state, which is exactly what the design rule forbids — ours could
drift from git's after an abort in a terminal pane.

---

## § 3 — Stash

### A stash is already a document this workbench can render

Measured, and it is the finding that makes this section small: **a stash is a merge commit
with three parents** — HEAD at stash time, the index state, and (with `-u`) the untracked
files. `git show -M -m --first-parent --format= stash@{0}` yields its tracked changes against
HEAD-at-stash-time, which is exactly what you want to see, and it is byte-for-byte the
argument list `DiffReader.readCommit` already builds. `git show stash@{0}:<path>` feeds
`BlobCache` unchanged.

So a stash needs **no** new document type, no new `HighlightVariant`, no provenance case. It
is a commit-shaped read-only document, and W5a made those work.

This is also the second time `-m --first-parent` has paid for itself: added for merge commits,
it is what makes stashes render at all.

### Where it lives

A collapsible **`STASHES`** section under the commit list in the Commits scope, not a fifth
scope. `⌘G`'s scope rhythm stays at four segments — W3's live run already found five
equal-width segments unreadable, and while the pill wraps past three now, a second row of
chrome for something used a few times a week is a bad trade. A stash *is* a kind of history,
which is what that scope is.

The list comes from `git stash list --format='%gd%x00%H%x00%at%x00%gs'` — the same
NUL-delimited shape and the same reason as `CommitHistory.parse`: a stash message is free text
and a human-readable delimiter eventually splits one. Pure parse in `StashList`.

Row actions: **Apply** / **Pop** / **Drop**, with Drop confirmed because it is the one
irreversible action here.

### Creating one

A **Stash** button beside Commit in working-tree scope, reusing the commit draft as the
message — the draft is already there and already describes the work. A menu carries
`--staged` (stash only what is staged) and `--include-untracked`.

Stashing is the natural neighbour of committing: both are "put this somewhere and clean the
tree", and the box that names the change is already on screen.

### Untracked files in a stash are listed, not previewed

Measured: files stashed with `-u` live in the stash's **third** parent and do not appear in
the first-parent diff at all. Their paths come from `git ls-tree stash@{n}^3` and are listed
under the stash labelled *untracked (not previewed)*.

Synthesizing all-addition rows from those blobs is possible and is not being done. It is the
same shape as reconstructing a binary blob so it could flow through the normal write path,
which W3 refused for the same reason: the rows would claim to be a diff of something, and
they are not.

---

## § 4 — Loose conflicts: the mirror of the state W5a missed

### The sixth probe, and the defect it found

W5a named `mergeState.isActive && !hasConflicts` "the state with no representation". Its
mirror is worse, and W5a did not consider it:

**`hasConflicts && !mergeState.isActive`** — unmerged files with no operation in progress.

A conflicted `git stash pop` produces exactly this. Measured: three unmerged stages, and **no
`MERGE_HEAD`, no `CHERRY_PICK_HEAD`, no `rebase-merge`, no `sequencer`, no `MERGE_MSG`**. The
same shape comes from `git checkout -m` and `git apply -3`. `git stash apply --continue` does
not exist.

Run that through the shipped code:

- `hasConflicts` is true, so `isMidSequence` is true and the workbench **locks to Files** and
  `setScope` refuses to leave.
- `SequencePolicy.canContinue(isActive: false, …)` is false, and the reason reads *"nothing in
  progress"* — beside a lock that says otherwise.
- `abortOperation()` hits `guard mergeState.isActive` and **returns silently**. A dead button.

The only exit is another application. That is reachable in the shipped build today, before
W5b writes a line — a locked workbench with no way out is the trap this project keeps
refusing to ship, and it shipped.

### The representation

`MergeState` gains no operation case — inventing `.stashApply` would be a guess, since git
records nothing that distinguishes a conflicted stash apply from a conflicted
`git checkout -m`. Instead a **derived** `ConflictContext`:

| | |
|---|---|
| `.sequence(Operation)` | git has an operation active — today's behaviour, unchanged |
| `.loose` | unmerged files, nothing active |

Derived on every read from git's own files, never cached, following the rule
`ConflictReader.readState` already sets: our position cannot drift from git's.

The lock itself does not change. `isMidSequence` is still right — a tree with unmerged files
is broken and diffing it is meaningless. What changes is what the panel says and offers.

### What `.loose` shows

No Continue, because there is nothing to continue and a disabled button whose reason
contradicts the lock is worse than no button. Instead:

> **⚠ 1 conflict · no operation in progress**
> Resolve each file; the result stays in your working tree.

and one escape: **Discard changes…**.

The discard is **`git checkout HEAD -- <unmerged paths>`**, not `reset --hard`. Per-path, so
unrelated dirty files in the tree are untouched, and the confirmation can name exactly which
files will be restored. `reset --hard` would throw away work the user never put at risk,
which is not an escape hatch, it is a second trap.

When `git stash list` is non-empty the confirmation also reports `stash@{0} (<message>) still
exists` — as **information, not a claim**. A conflicted pop does keep its stash entry, but
nothing in git proves the top entry is the one that was applied, and saying so would be a
fabrication of exactly the kind this project has twice refused.

---

## Order of work

Deliberately not the order the sections are numbered in. Ascending by size, with the live
defect first:

1. **§ 4, loose conflicts.** A trap reachable in the shipped build, and it is small. It also
   puts `ConflictContext` in place before anything else starts producing conflicts.
2. **§ 3, stash.** The smallest feature, and the one that proves the reuse claim — if a stash
   does not render through `readCommit` untouched, that is worth knowing before § 1 and § 2
   are built on the same assumption.
3. **§ 2, cherry-pick.** Generalizes `CommitHistory.logArguments` and adds the ref picker,
   both of which Rewrite mode benefits from being able to assume.
4. **§ 1, Rewrite mode.** The largest, and the one that most wants a working Continue path
   underneath it.

## New units

| Unit | Pure? | Responsibility |
|---|---|---|
| `RebasePlan.swift` | **pure** | `PlanRow`, `RebaseVerb`; rows → todo text (**reversed**); validity — first-row squash, the one-message rule, no-op detection; the reason for each refusal |
| `StashList.swift` | **pure** | `Stash`; `git stash list` argument builder and NUL-delimited parse |
| `RefList.swift` | **pure** | `Ref`; the `for-each-ref` argument builder and parse, incl. the worktree marking and date ordering |
| `SequencePolicy` (modify) | **pure** | `ConflictContext`; the `.loose` explanation and discard reason; remaining-only progress |
| `CommitHistory` (modify) | **pure** | `logArguments` generalized from `base:` to an arbitrary range |
| `StashRunner.swift` | no | `push` / `apply` / `pop` / `drop` / `ls-tree` of the untracked parent |
| `RebaseRunner.swift` | no | the temp todo, `GIT_SEQUENCE_EDITOR`, the `rebase -i` spawn |
| `CherryPickRunner.swift` | no | the pick spawn; ref and range reads |
| `ConflictReader` (modify) | no | `ConflictContext`; cherry-pick remaining from `sequencer/todo` |
| `WorkbenchSession` (modify) | no | plan state, stash/ref state, the new actions, the `.loose` panel data |
| `WorkbenchView` (modify) | no | Rewrite mode, the ref picker, the STASHES section, the loose-conflict panel |

Every pure unit goes in `ShepherdModelTests`' explicit `sources:` list.

## Testing

Unit coverage on the pure units, with the emphasis on `RebasePlan`'s inversion and validity —
that is where a wrong answer silently reverses a branch.

Real-git integration tests, which have now earned their keep twice (the rebase side-inversion
in W3, the non-zero `--continue` in W5a — neither reachable by a unit test):

- **`RebasePlanIntegrationTests`** — apply a reorder + fixup + drop plan to a real repo and
  assert the resulting log; assert an empty plan and a first-row-squash plan are refused
  before git sees them; assert a bare `<verb> <sha>` todo (no subjects) is honoured.
- **`StashIntegrationTests`** — a stash reads as a diff through `readCommit`; `-u` files are
  in the third parent and absent from the first-parent diff; **a conflicted pop leaves
  unmerged files with no operation active** and `ConflictContext` reports `.loose`; the
  per-path discard restores the conflicted file and leaves an unrelated dirty file alone.
- **`CherryPickIntegrationTests`** — a multi-commit pick that stops, continues and finishes;
  the remaining count read from `sequencer/todo` as the sequence advances.

### Green tests are not the bar

Every phase of this workbench has been finished by a human pressing something: eleven defects
in W1's first live run, nine in W3/W4, and W5a's are still unticked as this is written. Drag
to reorder, a menu per row, a confirmation dialog and a locked-with-no-exit panel are all in
the class that `xcodebuild` cannot see. **W5b merges after a live run, not after green
tests.**

## Risks carried deliberately

- **Rewrite mode rewrites history.** Every commit gets a new sha, which invalidates a PR's
  review state. Mitigated only by it being explicit, opt-in and no-op-refusing — not by
  anything clever.
- **A stopped `rebase -i` inherits W5a's Continue path**, which as this is written has not
  been driven from the UI. If that path is broken, Rewrite mode is broken with it. This is why
  the W5a live-run gate comes first.
- **The one-message rule will feel arbitrary** the first time someone wants two rewords. The
  reason is recorded above; the fix is a dispatcher script, and it is a follow-up, not a
  deferred promise.
- **`.loose` is inferred, not read.** git records nothing saying "a stash apply conflicted",
  so the panel describes the *shape* of the state rather than naming its cause. Honest, and
  slightly less helpful than naming it would be if naming it were possible.

## Deferred, recorded so it is not mistaken for done

- Several message-editing entries in one plan (the dispatcher script).
- `edit` / `break` verbs; `rebase --edit-todo` on a live todo; `--autosquash`; splitting a
  commit; rebasing onto a different base.
- Full-history exploration beyond one picked ref — W5a's decision, unchanged.
- Previewing a stash's untracked files as rows.
- Cherry-picking from a remote ref that is not a local branch (`origin/*` is not in
  `refs/heads`).
- `git stash branch <name>`, and applying a stash with `--index` to restore staged-ness.
