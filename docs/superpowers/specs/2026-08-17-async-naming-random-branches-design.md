# Naming a task stops being on the critical path

**Date:** 2026-08-17
**Status:** design, approved
**Scope:** `v2/` only — `extensions/tasks`, `extensions/github`, `packages/cli`.

## What changes

A task's identity and a task's name become two different things.

Today they are one string. `tasks.create` asks a model for a name, derives the
slug from it, and the first `git worktree add` **waits** for that answer — up to
30 seconds — because the folder and the branch are named after it. Until the
answer lands the row has no name to draw, so it draws the step it is on instead.

After this change: the folder and the branch are minted at once from a random
`<colour>-<breed>` pair, the task exists and provisions immediately, and the
model's answer arrives later and replaces one thing — the label on the tab and
the row. Nothing on disk ever depends on it.

```
create ─┬─ mint `slate-merino` ─→ worktree, branch, task root ─→ agent starts
        └─ ask the model ─────────────────→ title = "Async task naming"
                                              (tab + row relabel, nothing else)
```

## What stops being true

Four recorded decisions are overturned here, and they are named because the code
argues for each of them at length. A future reader finding those arguments
intact must know they were answered rather than missed.

| | said | now |
|---|---|---|
| **D18** | one model call answers both the branch and the row label | it answers only the label |
| **D19** | the slug may change once, before the first git write | the slug is minted at create and never changes |
| **D20** | the first `worktree add` waits for the name | nothing waits for the name, ever |
| **D21** | the composer asks speculatively so Create does not pay for it | there is nothing left to pay for; the ask goes |

And one premise outside `tasks`: `extensions/github` is written on "a task's
branch **is** its slug" (`github/src/index.ts:655`, `github/src/query.ts:13`,
`github/src/sync.ts:25`). It stops being true the first time an agent renames a
branch, so the branch becomes something read from git rather than derived.

The prose in `model/naming.ts`, `model/slug.ts:12`, `index.ts:2271` and
`ui/card-data.ts:97` states the superseded rules and is rewritten as part of this
work, not left to contradict the code.

## The mint

A new pure model file, `extensions/tasks/src/model/mint.ts`:

```ts
export function mintName(random: () => number): string; // `slate-merino`
```

Two curated lists — roughly 30 colours and 45 sheep breeds, about 1,350 pairs.
Both lists are lowercase ASCII with no separators, so a minted name is already
slug-safe and already a legal git branch; `slugify` passes it through unchanged
rather than repairing it.

`random` is a parameter for the reason `ctx.clock` is: a name nobody can predict
is a name no test can assert on. `index.ts` passes `Math.random`; tests pass a
sequence.

### Two kinds of collision, two answers

**The folder.** `uniqueSlug` against `store.takenSlugs()`, exactly as today —
`slate-merino-2`. Unchanged code, new input.

**A branch that already exists in the repo** is the one that matters, and it is a
new hazard rather than a smaller version of an old one. `resolveBranch`
(`model/branch.ts:58`) treats an existing local branch as *check it out*. That is
right when the name was chosen from the work; it is wrong when the name was
drawn from a hat, because a task would silently adopt a deleted task's commits
and the first symptom would be a diff nobody wrote.

So the branch is chosen **after** the refs are known and checked against every
repo at once. `runProvision` already prefetches each repo's refs before the
branch is needed (`index.ts:2369`) — that prefetch existed to overlap the network
with the model call, and it now serves this instead. A name taken as a local or
remote branch in **any** repo of the task is re-minted, **five times at most**,
after which the `uniqueSlug` suffix rule is applied to the last candidate and
that is the answer. A bound rather than a loop, because the failure it guards
against is not "unlucky" but "this repo has 1,300 branches", and a loop there
does not terminate.

Checked across all repos together, never per repo, because one task keeps one
branch name: `taskProvisioned` publishes a single `branch` for the whole task
(`index.ts:2530`), and a per-repo answer would make that fact a lie.

This is also why the slug and the branch may legitimately differ from the first
second of a task's life — the slug is minted before any repo's refs are known.
That is safe only because nothing derives one from the other any more.

## What the record holds

| field | value | changes? |
|---|---|---|
| `slug` | the minted name, resolved once against `takenSlugs` | **never** — it is a directory, and it is on disk |
| `title` | the brief's first line at create; the model's name when it lands | once, and it touches nothing but pixels |

There is deliberately **no `branch` field**. A stored branch is a claim about
somebody else's repository that goes stale the moment anyone types
`git branch -m`, and this design invites exactly that. Git is asked instead.

## Naming becomes a background job

`tasks.create` awaits nothing:

1. `slug = uniqueSlug(mintName(random), store.takenSlugs())`
2. `title = args.title ?? firstLine(brief)`
3. `store.put`, `provision(task, images)`, `changed()`

`provision` and `runProvision` lose their `naming` parameter, the
`whileBusy(id, 'naming', …)` wrapper goes, and `settleName` is deleted.

In its place `nameLater(task)` starts alongside provisioning:

- it awaits `pendingName(brief)`, which already never rejects;
- `undefined` — the model is off, signed out, or declined — is an ordinary
  outcome and the task simply keeps the brief as its title;
- on an answer it **re-reads the record**, because the task may have been
  archived, deleted or restored in the meantime, and writes `title` only;
- then `changed()` and a pane relabel (below).

`NAME_ASK_TIMEOUT_MS` stays at 30s and stops being anybody's wait.

### `title` becomes optional, and that is the point

`tasks.create`'s schema takes `title` as required (`index.ts:2885`) and the
composer supplies `titleOf(brief)` — the brief's first line, capped. So the
extension cannot tell a title a human chose from a slice of a paragraph, and
`heuristicName` exists largely to clean up the second case.

`title` becomes optional and the composer stops sending it. An explicitly
supplied title then means something real: `shepherd task new --title 'Fix login'`
is a human's choice, **it wins, and `nameLater` does not run for that task**.
Overwriting a name somebody typed with a guess about the paragraph underneath it
would be a regression, not a feature.

The composer's `titleOf` moves into the extension as `firstLine` — the brief's
first line, trimmed, capped at 72 with an ellipsis — so the CLI's `--brief` gets
the same treatment as the field. Its cap is what keeps a pasted paragraph from
becoming a tab title the width of the window.

**`heuristicName` becomes unreferenced and is deleted**, with its tests. Its two
callers were the slug (now minted) and the title (now the brief's own first
line), and there is no third. It existed to make a slice of a paragraph
survivable as a *name*; the brief is now shown as a brief, which is the honest
version of the same idea. `model/naming.ts` keeps `namingPrompt`, `readName` and
`stillTheSameBrief`, and its file header is rewritten around what is left.

`MIN_BRIEF_CHARS` (24) still gates the ask inside `pendingName`, so a very short
brief is never sent to a model and keeps its own text as the title. That is
unchanged behaviour and it is now the whole behaviour for such a task.

### The composer

`ui/composer.tsx` loses its speculative ask: the `suggested` state, the idle-pause
effect that calls `tasks.suggestName`, the `namedFor` / `namingAsk` refs, the
`title` and `name` arguments to `tasks.create`, and the `stillTheSameBrief` and
`titleOf` code paths. The Create button's guard becomes `brief.trim() === ''` —
the question it was really asking.

`tasks.suggestName` stays registered. It is a public verb, it is what
`nameLater` invokes, and `stillTheSameBrief` remains its de-duplication rule.

## The branch, read live

| site | source of the branch |
|---|---|
| `repoProvisioned` fact (`index.ts:2441`) | the name just created — no read |
| `taskProvisioned` fact (`index.ts:2530`) | the name just created — no read |
| `github` sync, per repo | `git -C <worktree> symbolic-ref --short HEAD` |
| `tasks.delete`'s report | unchanged — `removeWorktree` already reads it from git |

`symbolic-ref --short HEAD` rather than `rev-parse --abbrev-ref HEAD`: on a
detached head the second answers the literal string `HEAD`, which is a valid
branch name to query GitHub with and always wrong. The first fails, and a failure
is the honest answer to "which branch is this worktree on" when it is on none.

The read goes where `github` already sweeps on a timer, so it costs no new
schedule. `github`'s `TaskLike.branch` becomes per-repo rather than per-task;
its client already takes a branch per repo (`client.ts:30`).

## The rename verb

`tasks.renameBranch`, reached from an agent as:

```sh
shepherd task rename-branch <name>
```

One entry in the CLI's `VERBS` table (`packages/cli/src/argv.ts:32`) plus one
registered command. The CLI owns no verbs by design, so this is a table line.

Behaviour:

- scoped to the caller's own task, like `tasks.spawn` — an agent may not rename
  another task's branches;
- validates the name as a git ref and refuses one already taken in any of the
  task's repos, before renaming any of them;
- runs `git branch -m <old> <new>` in each worktree;
- **writes nothing to the record.** Git is the truth, so a rename by this verb
  and a rename typed by hand in a terminal are the same event.

A partial failure is reported per repo rather than rolled back: a rename that
succeeded is not a thing to undo behind the user's back, and the next read of git
describes whatever is actually there.

## The rail row and the tab

`stepLabel` stops replacing the label. The label is `task.title` from the moment
the task exists — the brief's first line, then the model's name.

The step needs a home that does not give a row a second height (§10 refuses a row
that grows). So `CardData` gains `stage?: string`, drawn in the card head beside
the title with `flex: none` and one step down the ink ramp — the treatment `dupe`
already has at `ui/task-card.tsx:192`, where the title truncates *around* it. It
is present only while the task is provisioning and gone the moment that ends.

```
● in shepherd, the way a new task starts is…    Creating the worktree
● Async task naming & random branches
```

The comment at `ui/card-data.ts:97` — "there is deliberately no `stage` field" —
is rewritten rather than deleted: it was right for a row whose label *was* the
step, and the reason it stops being right is the reason this field exists.

**The tension, stated.** §10 refuses "a status word beside a status mark". This
is read as a step and not a status: the mark says *working*, the stage says which
part, and it never says `Working`. The current code already made that call by
putting the same words in the label; this moves them one cell right so the name
can have the label back.

**The tab.** Pane titles are set once, at open, through `layout.rename`
(`index.ts:1481`), and a pane's `userTitle` beats its OSC title
(`2026-08-13-osc-title-and-cwd-design.md`). So `nameLater` must re-issue
`layout.rename` for every live pane of the task when the name lands — the
orchestrator's pane with the bare title, a workstream pane with
`<title> · <repo>`. A failure is logged and stepped over, for the reason the
existing call gives: a title is the decorative part of a spawn.

## What the agent is told

A section in the generated task-root `CLAUDE.md` (`model/root-synth.ts`), which
is the only `CLAUDE.md` loaded at session start:

```markdown
## Branch

Every worktree here is on `slate-merino`. Rename it whenever you like:

    shepherd task rename-branch <name>
```

No explanation of why the name is random — the agent does not need the history,
it needs the door and permission to use it. `SynthInput` gains the branch name so
the section can state the real one.

The same two lines join the verb list in
`extensions/tasks/skill/shepherd-tasks/SKILL.md`, which is where an agent looks
for verbs.

The section names the branch as it was minted and does not update after a rename.
That is accepted: it is a prompt to act, and once acted on its job is done.

## Verification

`smoke-m3` asserts both halves of the old behaviour and both change:

- `created.slug === 'provisioned-by-the-m3-smoke'` becomes "the slug is a minted
  `<colour>-<breed>`";
- `settled?.slug === 'stub-named-this'` becomes "**the title** settled to the
  model's answer, and the slug did not move".

New tests:

| | asserts |
|---|---|
| `model/mint.test.ts` | shape, slug-safety, and that a seeded sequence is reproducible |
| branch collision | a name taken in *any* repo is re-minted; the fallback path when every attempt collides |
| `nameLater` | a deleted record is not resurrected; an archived one still relabels; `undefined` keeps the brief |
| `renameBranch` | refuses a taken name before touching any repo; partial failure is reported per repo |
| `tasks.create` | an explicit `title` wins and suppresses the ask |

The M3 lesson applies to the collision test in particular: a gate that passes with
the change reverted is not a gate. Each new test is run against the unmodified
code first.

## Not doing

- **No `git worktree move`, no task-root re-synth, no trust re-seeding.** The
  folder never changes, and that is the whole reason this shape is cheap.
- **No stored `branch`.**
- **No per-repo branch names.** One task, one branch.
- **No rename of the task folder** when the name lands, ever — D19's argument
  about what a rename would cost is still correct, which is why the folder is
  taken off the naming path rather than dragged along it.
