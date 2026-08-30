# A notification is a task, not a state word

**Status:** designed, 2026-08-30. Supersedes nothing; extends ADR 0020's routing
and the `AlertSink` seam `agent-relay.ts` introduced.

## The problem

Every banner Shepherd raises today says one of three sentences — `Turn finished`,
`Waiting on you`, `Turn failed` — over a body that is the raw `alertReason`
(`approve Bash`, or, when there is none, the state word again). Run four agents
and the four banners are indistinguishable: none of them names the task, none of
them says what changed, and clicking one raises the app to wherever it happened
to be. The notification is the one surface that reaches you when Shepherd does
not have the screen, and it is the only surface that has not learned the
vocabulary the rest of the app already speaks.

That vocabulary exists and is unused here:

- `RowFacts` (`renderer/takeover/row-facts.ts`) — the mark, the elapsed, the
  summary, the diff, the repos, and a `question` with exactly two `answers`.
- The four faces (`renderer/takeover/nav.ts`) — `agents | diff | intent | files`
  — and `openingFace`, which already knows a finished task with changes wants
  Diff and everything else wants Agents.
- `jump()` vs `go()` — a teleport that clears the nav stack, against a push that
  does not. ⌘K already teleports; a banner does not navigate at all.

## What this changes

1. A banner is titled with the **task's name**, subtitled with the state, and
   carries a **metadata line** that says something the state word cannot.
2. Clicking it **teleports** to that task, at the face the state implies.
3. It carries up to two **buttons**, which are verbs or places the composing
   extension names — `Diff` and `Agents` on a finished turn, `Open` and
   `Later today` on a block.

Explicitly **not** in this change: answering a permission prompt (Allow/Deny)
from the banner. It needs two things that do not exist — a producer for the
pending question (`RowFacts.question` has a reader and no writer) and a way to
answer a prompt in a pty without guessing at a menu whose shape may have moved.
The design below leaves exactly one seam for it: a row in a table inside `tasks`.

## 1. An alert is a spec

New in `@shepherd/sdk`, beside the other shapes that cross the port:

```ts
export interface AlertGoto {
  readonly task: string;
  /** A face slot (`agents`, `diff`, …). Absent means "the shell decides". */
  readonly face?: string;
}

export type AlertAction =
  /** Run a verb. The shell never learns what it does. */
  | { readonly label: string; readonly command: string; readonly args?: unknown }
  /** Go somewhere. */
  | { readonly label: string; readonly goto: AlertGoto };

export interface AlertSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly actions?: readonly AlertAction[];
  readonly click?: AlertGoto;
}
```

`{command, args}` is deliberately the shape `RowAnswer` and `later.options`
already cross the port with. Main runs a verb it was handed; it does not learn
that `tasks.snooze` exists, exactly as `menuDispatcher` does not.

`AlertSink.notify` takes an `AlertSpec` plus the `sessionId` it belongs to. The
existing two-string call is the fallback, expressed as a spec with no actions and
no click, so there is one code path.

## 2. Who fills it in

`agent-relay` knows a session id and a state. Only `tasks` knows the task's name,
its diff and its last word. So the **kernel declares one command id** —
`alerts.describe` — and any extension may register it; `tasks` does.

```
alerts.describe({ sessionId, state, reason, turnFinished }) -> AlertSpec | null
```

Called by the relay **only after `attention.decide()` has already returned
`banner: true`**. That ordering is the whole cost argument: alerts are rare and
suppressed alerts are common, so the git read and the transcript tail below are
paid once per banner and never for a state change nobody will see.

`null`, an unregistered command, a rejection, or a session that belongs to no
task all mean the same thing: **fall back to today's exact wording**. A person
running Shepherd with `tasks` disabled sees what they see now, and the failure
mode of the composer is the old banner rather than no banner.

Main naming `alerts.describe` is main naming a *kernel* concept. It is not
`agent-relay`'s existing deviation (a table of one extension's topic) made worse;
it is that deviation's replacement shape, and the header comment there should say
so.

## 3. What it says

`tasks` composes, from what it already computes for a card:

| state | title | subtitle | body |
|---|---|---|---|
| blocked | task title | `Waiting on you` | the block reason — `approve Bash`, `plan approval`, `answer needed` |
| turn finished, with changes | task title | `Turn finished` | `3 files · +42 −7` |
| turn finished, no changes | task title | `Turn finished` | the agent's last line (`agents.lastSaid`) |
| error | task title | `Turn failed` | the reason (`API error`, or what the vendor said) |

Two sources, both of which the extension already has a route to:

- **`agents.lastSaid`** — asked, never read off a transcript. `tasks` already
  does this for the rail's second line, and `summaryFor` is the existing rule for
  when a last line is worth drawing (never when it merely repeats the title).
- **The diff stat**, which needs one small addition, below.

### 3a. `editor.stat`

`RowFacts.diff` (`{added, removed, files}`) has a reader in the takeover and no
producer anywhere. `editor.changes` answers *which* paths changed, not how much,
and ADR 0048 puts the working tree under `editor` — so `tasks` shelling out to
`git diff --numstat` itself would be a second owner of the same question.

So `editor` grows one command:

```
editor.stat({ root, base? }) -> { files: number; added: number; removed: number }
```

one `git diff --numstat` (plus untracked, counted the way `listStatus` already
counts them), `base` widening it from "uncommitted" to "since this checkout
forked" for the same reason `editor.changes` takes one. Zero changes answer
`{0,0,0}`, and the caller draws nothing.

This is the one piece of the change that is not about notifications. It is here
because the metadata line was the ask, and because the same command is what
finally lets a takeover row draw the diff column it already has code for.

## 4. Clicking teleports

The click carries `{task}` and, optionally, a face. Main:

1. raises the window (`show()` + `focus()`), and
2. pushes `EMIT.navigate` — `{ task, face?, how: 'jump' }` — to every live
   renderer, the way `EMIT.agentsChanged` is pushed.

The renderer resolves the task id against its triage entries and calls the
`open(entry, 'jump')` it already has — the path ⌘K uses. Which means:

- the **stack is cleared**, so `esc` after arriving from a banner goes Home
  rather than back into the task the banner interrupted;
- the **face comes from `openingFace`**, so blocked lands on Agents and a
  finished turn with changes lands on Diff, with `nearestFace` covering a face
  nothing has claimed;
- **no face logic is duplicated in main**, which forwards an opaque string.

An entry the renderer does not know yet (a task whose row has not arrived) falls
back to invoking the task's own reveal verb, so the window still moves.

## 5. Buttons

The table lives in `tasks`, because the labels are its vocabulary:

| state | buttons |
|---|---|
| turn finished | **Diff** → `goto {task, face:'diff'}`, **Agents** → `goto {task, face:'agents'}` |
| blocked | **Open** → `goto {task, face:'agents'}`, **Later today** → `tasks.snooze {task, until:'today'}` |
| error | **Open** → `goto {task, face:'agents'}` |

Two, never more: macOS renders the first as a button and folds the rest into a
dropdown, and a dropdown in a banner is a menu nobody opens. `Later today` is a
concrete verb rather than the rail's three-way `Later` menu for the same reason.

When Allow/Deny arrives it is a fourth row in this table and nothing else moves.

## 6. Delivery

`system-alerts.ts` grows `subtitle` and `actions` on the Electron
`Notification`, and wires two events it currently ignores:

- `click` → dispatch the spec's `click`
- `action(_, index)` → dispatch `actions[index]`

Both go through one injected `dispatch(action)` callback, shaped like
`menuDispatcher`: a `goto` becomes a raise + an `EMIT.navigate` push, a command
becomes `registry.invoke(command, args, USER)`, and a failure is reported rather
than swallowed — a button that quietly does nothing is indistinguishable from a
feature that has stopped working.

The existing loud-failure paths (`isSupported`, the `failed` event, the unsigned
dev-build warning) are untouched. Under `pnpm dev` nothing here is reachable,
because the banner is refused before it is drawn; the check that matters happens
in the ad-hoc-signed `Shep.app`, which is where buttons render at all.

## 7. Testing

Every decision above is pure and lands in a unit test:

- **the composer** in `tasks` — a table of `(state, facts) -> AlertSpec`, including
  the fallbacks: no last line, no changes, a last line that is the title again.
- **`editor.stat`** — over a real temp git repo, as `editor`'s other commands are:
  staged, unstaged, untracked, and clean answering `{0,0,0}`.
- **`system-alerts`** — the fake `NotificationHandle` grows `click` and `action`,
  and asserts each dispatches the right entry, and that an out-of-range index
  dispatches nothing.
- **the relay** — `describe` is consulted only when `banner` is true; a `null`,
  a throw and an unregistered command each produce the old wording.
- **the renderer** — an `EMIT.navigate` push jumps (stack empty) rather than
  pushes, and an unknown task id falls back to the reveal verb.

Then one manual pass in the signed build: four agents, four banners, each naming
its own task, each landing where it says it will.
