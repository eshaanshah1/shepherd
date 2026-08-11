# The task dot shows what the agents are doing

**Date:** 2026-08-10
**Status:** designed, not built
**Touches:** `extensions/tasks/`, `extensions/agents-core/` (one field — see
"The topic carries its own pane")

## The complaint

> the status dot in shepherd is not working. like its always blue for some reason??

It was, and for two unrelated reasons. This spec fixes the second one. The first
is recorded here because anyone reading this later will hit it first.

### Cause 1 — no hook ever reached v2 (fixed, not by this spec)

`agents.list` returned `[]` on a live app with four tasks running agents. Nothing
was feeding the state machine at all.

v2 ships its own plugin at `extensions/claude-code/plugin/`, but nothing installs
it, and the handoff plan already said so: *"No plugin installer.
`~/.claude/skills/shepherd-v2` is a hand-made symlink."* That symlink did not
exist. What did exist was `~/.claude/skills/shepherd` — **v1's** plugin, whose
`report.sh` guards on `SHEPHERD_TAB_ID` / `SHEPHERD_SOCK`. A v2 pane injects
`SHEPHERD_SESSION_ID` / `SHEPHERD_EVENTS_SOCK` instead, deliberately (ADR 0025,
and `correlation-env.ts` spells out why: so the two apps can run side by side
without cross-talk). So every hook in every v2 pane hit that guard and `exit 0`d
in silence.

The rest of the wire was healthy the whole time. One hand-posted event to
`hooks.sock` adopted the session immediately and drove it
`blocked → urgent → needs-you → amber`. Ingress, registry, attention store, tint
map and CSS were all correct.

Two things worth carrying forward from that half:

- **The symptom of a missing plugin is indistinguishable from a working idle
  agent.** Both are a quiet dot. `agents.list` is the one question that separates
  them, and it should be the first thing anyone runs.
- **An installer is still owed.** Until it exists, a fresh machine reproduces
  this exactly, and the failure says nothing.

### Cause 2 — the dot was never about the agent (this spec)

The row's tint is the **task lifecycle**, not the agent's state:

```ts
const state = displayState(task.lifecycle, attentionOf(task));
return { id: task.id, label: task.title, description: state, tint: state, ... };
```

`LIFECYCLE_STATES` declares five values. Only three are ever written — `draft`,
`running`, `archived`. **`review` and `done` appear nowhere but the enum
declaration**; no code path assigns either. So the reachable palette was:

| what you see | when |
| --- | --- |
| blue (`running` → `working`) | any live task not currently shouting |
| amber (`needs-you` → `attention`) | a session at `attention` or `urgent` |
| green (`done` → `success`) | never |
| grey (`idle`) | archived, or the millisecond a task is a draft |

An agent working and an agent asleep are the same value — `running` — so they are
the same colour. Blue meant "this task exists and nobody is shouting", which is
almost always. That is the always-blue.

Fixing cause 1 alone would not have fixed this. It buys back amber; it cannot
buy back the difference between working and idle, because the lifecycle has no
word for either.

## What it becomes

The dot answers **"what are this task's agents doing"**, rolled up over the
task's own sessions.

| rollup | dot | meaning |
| --- | --- | --- |
| `blocked` | ● amber | an agent needs an answer |
| `error` | ● red | an agent broke |
| `needsCheck` | ● green | a turn finished and you have not seen it |
| `working` | ● blue | in flight |
| `idle` | ○ grey | at rest, or no agent reporting |

**A finished turn is green, not amber**, and this spec said the opposite until a
live run caught it. The palette names both jobs itself — `pasture` is
"done / success", `hay` is "blocked / attention" — and v1 shipped exactly that
(`Theme.needsCheck` = `0x43C988`, commented "done — ready for you"). That is also
what v1's rollup comment means by `done`: there was never a state of that name,
only `needsCheck` under its user-facing word. Painting both amber would make
"finished" and "waiting on an answer" one dot separated by a tooltip. Green still
clears to grey the moment you look at the pane, so it reads "done, unread" rather
than "resolved, ignore me".

**Loudest wins, in that order.** This is v1's `Tab.attentionState()` priority,
which rolled panes up to a tab dot for the same reason: anything wanting you
outranks anything merely busy. The accepted cost is that one blocked workstream
reads blocked while four others make progress — correct, because a blocked agent
waits indefinitely and burns nothing, so it is the fact worth surfacing.

**A task with no reporting session is grey**, identical to idle. An unreported
session and a resting agent are both "nothing is happening", and inventing a
sixth state for the difference would put the *absence of a signal* on the same
axis as the signals. The cost is real and accepted: a dead hook wire looks exactly
like a quiet agent, which is the confusion that opened this whole thread. The
answer to that is the installer owed above, plus `agents.list`, not a colour.

**The spinner stays task-level.** `TreeItem.busy` keeps meaning *Shepherd is doing
something to this task* — a git snapshot, worktrees being rebuilt. A working agent
is a static blue dot. This keeps a clean line between what the agent is doing and
what the app is doing to the task, and it keeps a sidebar of four running tasks
from ticking four spinners.

## Architecture

### One mirror replaces another

```
today
  agents-core ──attention.set──▶ core store ──attention.changed──▶ tasks
                                                                     │ mirror, by pane
                                              displayState(lifecycle, attention[])
                                                                     ▼  tint = lifecycle word

after
  agents-core ──agents.stateChanged──▶ tasks
                                          │ mirror, by pane
                                  rollUp(task.sessions → states)
                                          ▼  tint = agent-state word
```

A **mirror** is a local `Map` inside `tasks` holding a copy of state that lives
in core. It exists because `tasks` cannot ask: `attention.get` throws
`NotImplementedError(ACROSS_A_PORT)`, so an extension subscribes to an
announcement and keeps its own copy. Today that is `attention` at `index.ts:268`,
keyed by pane. After this change it is one `Map<paneId, AgentState>` and there is
still exactly one.

The attention mirror is **deleted**, not supplemented. `needs-you` was already
derived from agent state upstream (`attentionFor`), so deriving it here removes a
copy rather than adding one — two overlapping mirrors of one fact are two things
that can disagree, and this codebase keeps writing ADRs against exactly that
shape.

D4 is untouched and arguably strengthened: nothing here *writes* attention, and
now nothing mirrors it either. `tasks` reads a fact `agents-core` publishes, one
topic further upstream, carrying strictly more information.

The sharp edge, checked: **viewing still clears a finished turn.**
`registry.observeViewed` writes `needsCheck → idle` and emits a change, so the
clear rides the state topic. `blocked` correctly does *not* clear when you merely
look at it — the same asymmetry core's attention store implements in
`#clearedByViewing`, arrived at from the same direction. No behaviour is lost by
dropping the attention subscription.

### The topic carries its own pane

`agents.stateChanged` is keyed by **session id**. The mirror it feeds must be
keyed by **pane**, and the difference is not cosmetic.

When `tasks` spawns an agent it gets a pane back immediately and no session id —
`layout.openRoot` and `layout.split` both return a pane. So it writes
`id: 'pending-<ts>'` and starts `correlate()`, which polls `sessions.list` every
500ms, up to ten times, until it can swap the real id in. For as long as five
seconds a task's session has a placeholder id and a true pane. `index.test.ts`
already fixes this in a test and says why in as many words:

> The session below carries a `pending-` id ON PURPOSE: that is what a session
> looks like for the first seconds after a spawn, and it is exactly when an agent
> is most likely to ask something. **A mirror keyed by session id would drop it.**

Keying the new mirror by session id would therefore trade a working `needs-you`
for one that is blind during the first seconds of every spawn — the window that
holds Claude Code's trust prompt and the first permission ask.

So: **`agents-core` puts the pane on the payload.** It already reads
`sessions.list` to seed its registry and merely discards the pane —
`readSessionRows` keeps `id` / `hasForegroundProcess` / `viewing` and drops the
rest. Keeping it and emitting it makes the topic self-sufficient, which is the
same move core's attention store already makes one layer down: resolve
session → pane once, at the source, then announce by pane so no consumer has to
re-derive it. `AgentStateChanged` grows one optional field; `tasks` keeps its
mirror keyed exactly as it is today, and the placeholder id is never consulted.

The alternative — a second mirror keyed by session id beside the pane-keyed one —
was rejected for the reason the rest of this section gives: two copies of one
fact are two things that can disagree.

### The rollup is pure

New: `extensions/tasks/src/model/agent-rollup.ts`.

```ts
export const ROLLUP_PRIORITY = ['blocked', 'error', 'needsCheck', 'working', 'idle'] as const;
export type TaskAgentState = (typeof ROLLUP_PRIORITY)[number];

/** Total over values. Empty, unknown, or all-`shell` → `idle`. */
export function rollUp(states: readonly string[]): TaskAgentState;
```

A total function over values with no IO — the same shape as `lifecycle.ts` beside
it, and testable without a host. `shell` folds to `idle` rather than getting a
state of its own: a pane that has dropped back to a bare prompt has no agent, and
"no agent" is the grey case already decided above.

It takes `readonly string[]`, **not** `readonly AgentState[]`, on purpose. These
values crossed a port and came from an extension this code has never seen — the
rule the repo already states as "answers from a command are `unknown`, and a cast
is not a check". An unrecognised word is data, not a crash, and it folds to
`idle` with everything else that means nothing is happening.

### Vocabulary at the boundary

Every word `tasks` needs **already resolves** in `view-dock`'s `TINT_ROLES`, so
this ships without touching the renderer:

| rollup | tint word emitted | role | dot |
| --- | --- | --- | --- |
| `blocked` | `blocked` | attention | ● amber |
| `error` | `error` | danger | ● red |
| `needsCheck` | `needs-check` | success | ● green |
| `working` | `working` | working | ● blue |
| `idle` | `idle` *(unmapped)* | idle | ○ grey |

`idle` resolving by *falling through* `TINT_ROLES` rather than by an entry is
deliberate and load-bearing: `statusRole` returns `idle` for anything it does not
recognise, which is the behaviour a contribution should get for an unknown word.
Adding an explicit `idle` entry would make the fallback untested by its only
real user.

**A correction, recorded because the reasoning is the useful part:** this section
first called `TINT_ROLES`' `'needs-check'` → `success` entry a stale trap and
routed around it, emitting `needs-you` so a finished turn came out amber. That
was wrong. The entry is v1's model, encoded correctly, and the live run caught it
within minutes — a finished agent went amber and looked identical to a blocked
one. Three independent sources agreed against the guess: the palette's own job
labels, v1's `Theme.needsCheck`, and that `TINT_ROLES` line itself. A word the
shell already resolves is evidence about intent; treating it as debris because it
did not match an assumption is how the assumption survives review.

### Seeding — the bug this would otherwise ship with

An extension that only subscribes misses everything published before it woke, and
would read grey on every row until each session's next transition. `agents-core`
hit this and solved it with buffer-then-drain; the renderer hit it and solved it
with follow-then-pull (`app.tsx:260`, and its comment says why: with HMR, a
late-mounting consumer is every reload, not an edge case).

`tasks` takes the renderer's shape, because `agents.list` already returns current
state: **subscribe first, then pull `agents.list`, then merge the snapshot
*under* anything the subscription has already delivered** — a transition landing
between the two is newer than the snapshot by construction.

`agents.list` grows the same `pane` field, for the same reason and in the same
commit. A snapshot the mirror cannot key is a snapshot that seeds nothing, and
one source of a fact emitting it two ways is how the two drift.

### What the lifecycle still governs

Archived still selects the DONE section. That is a list split, not a tint, so it
is untouched — and it is also why green never needed to exist: a finished task is
already under a heading that says so, and a green dot beside it would say one
thing twice.

A `draft` task has no sessions yet and rolls up to grey, consistent with the
no-agent rule.

The row's `description` — its tooltip — switches from the lifecycle word to the
agent-state word, so hovering explains the dot rather than describing a different
axis. The `busy` override keeps winning over it.

### `tasks.list` output

`displayState` is repointed at the rollup, with one carve-out stated exactly:

```
displayState = task.lifecycle === 'archived' ? 'archived' : rollUp(states)
```

Archived wins because an archived task is not a thing whose agents are doing
anything, and reporting `idle` for it would answer a question nobody asked. Every
other lifecycle value yields to the rollup. In practice the two agree — an
archived task's sessions are gone, so it would roll up to `idle` anyway — and the
carve-out exists so that a stale live session cannot make an archived task report
as though it were live.

`lifecycle` is already on the wire beside it, so remote and CLI callers keep both
questions answerable: what the task **is**, and what its agents are **doing**.
Verified before deciding this: `displayState` has no consumers outside
`extensions/tasks/` in this repo, so the shape is ours to change.

## Testing

- `model/agent-rollup.test.ts` — exhaustive over the priority order; empty input;
  unknown words; all-`shell`. Pure, no host.
- `model/lifecycle.test.ts` — updated for `displayState` taking a rolled-up state.
  The existing assertion that the *stored* vocabulary cannot express `needs-you`
  stays exactly as it is; it is still the guard against a second writer.
- `index.test.ts` — the mirror nudges `changed()` **only on a real delta**, ported
  from the attention-mirror test it replaces; the seed merges under the
  subscription rather than over it; and the existing `pending-` id fixture stays
  exactly as it is, because it is the regression test for the keying decision
  above.
- `agents-core`'s own tests — `readSessionRows` keeps the pane, and a state change
  emits it.
- `vendor-boundary.test.ts` — still passes unchanged. `agents.stateChanged` is
  `agents-core`'s topic, not a vendor's, so no vendor name enters this extension.
- `pnpm smoke:m3`.

And the bar this repo sets in its own CLAUDE.md: **a green unit suite is not a
working app.** The real check is watching a dot go amber in the running app when
an agent blocks, and grey when it is left alone.

## Risk

**Tasks whose panes have no plugin loaded go from blue to grey.** That is the
design working — they genuinely have no reporting agent — but it will read as a
regression, because more rows will change colour on ship than the change appears
to justify. Anyone who sees it should run `agents.list` and reload the plugin in
those panes rather than reach for this code.

## Not in scope

- The v2 plugin installer (owed; ADR 0005's five-case classification is unbuilt).
- `TINT_ROLES`' `'needs-check'` → green entry.
- Writing `review` / `done` lifecycle values. The dot no longer needs them, so
  whether a task can be "in review" is now a product question standing on its
  own rather than a colour bug.
