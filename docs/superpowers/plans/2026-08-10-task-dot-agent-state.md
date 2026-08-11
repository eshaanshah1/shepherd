# Task Dot Shows Agent State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Shepherd v2 sidebar task dot shows a rollup of its sessions' agent state (working / idle / needsCheck / blocked / error) instead of the task lifecycle, which only ever holds three of its five values.

**Architecture:** A session's pane becomes a bus fact (`session.bound`) the way its death already is (`session.exit`). `agents-core` keeps that mapping and puts the pane on `agents.stateChanged` and `agents.list`. `tasks` then swaps its pane-keyed *attention* mirror for a pane-keyed *agent-state* mirror — one mirror in, one mirror out — and tints each row by rolling that state up over the task's own sessions, loudest first.

**Tech Stack:** TypeScript (node type-stripping, `erasableSyntaxOnly`), Electron, vitest, pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-08-10-task-dot-agent-state-design.md`](../specs/2026-08-10-task-dot-agent-state-design.md)

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before running a line of our code, and the symptom is every check failing at once with no output explaining why.
- **No `enum`, no parameter properties, no TypeScript-only runtime syntax.** `erasableSyntaxOnly` is on because Electron type-strips the main entry and stripping can only erase. Use `as const` arrays plus a derived union, the way `AGENT_STATES` and `LIFECYCLE_STATES` already do.
- **An extension never names a vendor.** No `claude`, `claudeCode.*`, or `--resume` in `extensions/tasks/` code. `vendor-boundary.test.ts` greps for this and will fail the build.
- **Answers from a command are `unknown`, and a cast is not a check.** Values crossing the port get structural reads, not casts.
- **`v2/tooling/eslint/boundaries.js` is the architecture diagram.** If an import is refused, the rule is right and the import is wrong — do not widen it for this work; nothing here needs a new edge.
- **Imports use explicit `.ts` extensions**, matching every file in the repo.
- Full check: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/app/src/main/session-bound.ts` | **Create.** The `session.bound` topic + its publisher. Mirrors `viewing-topic.ts`. |
| `packages/app/src/main/session-bound.test.ts` | **Create.** Against a real `EventBus`. |
| `packages/app/src/main/index.ts` | **Modify.** Announce on bind, inside the existing `bridge` layout callback. |
| `extensions/agents-core/src/manifest.ts` | **Modify.** Export `SESSION_BOUND_TOPIC`. |
| `extensions/agents-core/src/index.ts` | **Modify.** Keep `sessionId → paneId`; put `pane` on the emitted change and on `agents.list`. |
| `extensions/agents-core/src/index.test.ts` | **Create.** `readSessionRows` keeps the pane. |
| `extensions/tasks/src/model/agent-rollup.ts` | **Create.** Pure loudest-wins rollup. |
| `extensions/tasks/src/model/agent-rollup.test.ts` | **Create.** |
| `extensions/tasks/src/model/lifecycle.ts` | **Modify.** `displayState` takes a rolled-up agent state. |
| `extensions/tasks/src/model/lifecycle.test.ts` | **Modify.** |
| `extensions/tasks/src/index.ts` | **Modify.** Swap the mirror; wire tint / description / `tasks.list`; seed from `agents.list`. |
| `extensions/tasks/src/index.test.ts` | **Modify.** Port the attention-mirror suite onto the state topic. |

---

### Task 1: `session.bound` — a session's pane, on the bus

A session gets its pane in `SessionBridge`'s `bind` callback, and `LayoutStore.bindSession` deliberately announces nothing (it is not a structural change, and publishing it would re-render the renderer that caused it). `session.exit` already exists for exactly the symmetric reason — without it an agent extension "learns of a death only from the reconciliation sweep, which is a *heuristic over a pty*". Birth has the same problem and no signal at all. The sweep cannot substitute: `schedule()` returns early unless something is already `working`/`blocked`, so a freshly-bound idle session may never be swept.

**Files:**
- Create: `packages/app/src/main/session-bound.ts`
- Create: `packages/app/src/main/session-bound.test.ts`
- Modify: `packages/app/src/main/index.ts` (the `bridge` layout `bind` callback, ~line 538)

**Interfaces:**
- Produces: `SESSION_BOUND_TOPIC = 'session.bound'`; `interface SessionBound { readonly sessionId: SessionID; readonly paneId: PaneID }`; `publishSessionBound(options: { bus: EventBus; by: Caller }): { announce(pane: PaneID, session: SessionID): void }`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/main/session-bound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EventBus } from '@shepherd/core';
import { KERNEL, nullLogger, paneId, sessionId } from '@shepherd/sdk';
import { SESSION_BOUND_TOPIC, publishSessionBound, type SessionBound } from './session-bound.ts';

/**
 * The birth signal, asserted against a REAL bus.
 *
 * `session.exit` exists because inferring a death from the pty sweep is a
 * heuristic. This is the same argument for birth, and it is stronger: the sweep
 * only runs while something is already `working` or `blocked`, so a session that
 * is bound and then sits idle is never swept at all.
 */

describe('session.bound', () => {
  const harness = (): { bus: EventBus; seen: SessionBound[] } => {
    const bus = new EventBus({ logger: nullLogger });
    const seen: SessionBound[] = [];
    bus.on(SESSION_BOUND_TOPIC, (payload) => void seen.push(payload as SessionBound));
    return { bus, seen };
  };

  it('carries both ids, so a subscriber can key by either', () => {
    const { bus, seen } = harness();
    publishSessionBound({ bus, by: KERNEL }).announce(paneId('p1'), sessionId('s1'));

    expect(seen).toEqual([{ sessionId: 's1', paneId: 'p1' }]);
  });

  it('announces every bind, because a rebind is a NEW pane for that session', () => {
    // A pane whose session died and was replaced binds again. A publisher that
    // deduplicated would leave every consumer pointing at the dead pane.
    const { bus, seen } = harness();
    const topic = publishSessionBound({ bus, by: KERNEL });

    topic.announce(paneId('p1'), sessionId('s1'));
    topic.announce(paneId('p2'), sessionId('s1'));

    expect(seen.map((event) => event.paneId)).toEqual(['p1', 'p2']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-bound
```

Expected: FAIL — `Cannot find module './session-bound.ts'`.

- [ ] **Step 3: Write the module**

Create `packages/app/src/main/session-bound.ts`:

```ts
import type { Caller, PaneID, SessionID } from '@shepherd/sdk';
import type { EventBus } from '@shepherd/core';

/**
 * `session.bound` — a session's pane, on the bus, at the moment it becomes true.
 *
 * The symmetric half of `session.exit`, and it exists for the reason that one
 * does: an extension a process away cannot ask the layout anything, so a fact it
 * needs has to be pushed or inferred, and inference here is a heuristic over a
 * pty. Birth is worse than death was: the reconciliation sweep only runs while
 * something is already `working` or `blocked`, so a session that binds and then
 * waits is never swept, and a consumer keyed on the pane would hold nothing for
 * it indefinitely.
 *
 * `LayoutStore.bindSession` stays silent on purpose — it is not a structural
 * change and announcing it would re-render the renderer that caused it. This is
 * a bus event rather than a layout notification, so that reasoning is untouched.
 */

export const SESSION_BOUND_TOPIC = 'session.bound';

export interface SessionBound {
  readonly sessionId: SessionID;
  readonly paneId: PaneID;
}

export interface SessionBoundTopic {
  announce(pane: PaneID, session: SessionID): void;
}

export function publishSessionBound(options: { bus: EventBus; by: Caller }): SessionBoundTopic {
  return {
    /**
     * Every bind, with no deduplication. A pane whose session died and was
     * replaced binds again, and a publisher that suppressed the second one would
     * leave every subscriber keyed to the dead pane.
     */
    announce(pane, session) {
      options.bus.emit(SESSION_BOUND_TOPIC, { sessionId: session, paneId: pane }, options.by);
    },
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-bound
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into main**

In `packages/app/src/main/index.ts`, add to the existing import block from `./viewing-topic.ts`'s neighbourhood:

```ts
import { publishSessionBound } from './session-bound.ts';
```

Immediately after the `const viewingTopic = publishViewingEdges({ viewing, layout, bus, logger });` line, add:

```ts
/**
 * `session.bound` — the pane a session landed in. See the module for why the
 * sweep cannot infer this.
 */
const boundTopic = publishSessionBound({ bus, by: KERNEL });
```

Then in the `bridge` layout `bind` callback, immediately after `publishLayout();`:

```ts
      // The pane a session lives in, announced once, at the moment it is true.
      boundTopic.announce(pane, session);
```

`KERNEL` is already imported in this file — it is the caller `session.exit` is emitted as.

- [ ] **Step 6: Typecheck, lint, and commit**

```sh
env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint
git add packages/app/src/main/session-bound.ts packages/app/src/main/session-bound.test.ts packages/app/src/main/index.ts
git commit -m "feat(v2): a session's pane is a bus fact, like its death already is

\`session.exit\` exists because inferring a death from the pty sweep is a
heuristic. Birth had no signal at all, and is worse: the sweep returns
early unless something is already working or blocked, so a session that
binds and then waits is never swept.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `agents-core` keeps the pane and emits it

`agents.stateChanged` is keyed by session id. `tasks` cannot key a mirror by session id — for up to five seconds after a spawn its record holds `pending-<ts>` and only the pane is true. Rather than have every consumer re-derive the mapping, the source emits it. This is the move core's attention store already makes one layer down: resolve session → pane once, then announce by pane.

**Files:**
- Modify: `extensions/agents-core/src/manifest.ts` (beside `SESSION_EXIT_TOPIC`, ~line 41)
- Modify: `extensions/agents-core/src/index.ts` (`SessionRow`, `readSessionRows`, `publish`, the `agents.list` handler, the subscriptions)
- Create: `extensions/agents-core/src/index.test.ts`

**Interfaces:**
- Consumes: `SESSION_BOUND_TOPIC` from Task 1 — as the bare string `'session.bound'`, re-declared here. `main` does the same for `'session.exit'`: a topic name is public vocabulary, and an extension may import `@shepherd/sdk` and nothing else.
- Produces: `AgentStateChanged` gains `readonly pane?: string`; `agents.list` rows gain `readonly pane?: string`.

- [ ] **Step 1: Write the failing test**

Create `extensions/agents-core/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readSessionRows } from './index.ts';

/**
 * The reader is deliberately lenient — see its own comment: a strict schema
 * would reject every row the day `sessions.list` grows a field, and the symptom
 * would be an agent extension that quietly tracks nothing.
 *
 * The pane is what `tasks` keys its mirror by, so dropping it here is not a
 * cosmetic loss: it is the difference between a task dot that works during the
 * first seconds of a spawn and one that does not.
 */

describe('readSessionRows', () => {
  it('keeps the pane, which is what a consumer keys by', () => {
    expect(readSessionRows([{ id: 's1', paneId: 'p1', viewing: true, hasForegroundProcess: false }])).toEqual([
      { id: 's1', paneId: 'p1', viewing: true, hasForegroundProcess: false },
    ]);
  });

  it('keeps a row with no pane rather than dropping it', () => {
    // A session with no pane is a real state, briefly, and its agent state is
    // still worth tracking. Only the pane is missing.
    expect(readSessionRows([{ id: 's1', viewing: null, hasForegroundProcess: null }])).toEqual([
      { id: 's1', viewing: null, hasForegroundProcess: null },
    ]);
  });

  it('ignores a non-string pane rather than trusting it', () => {
    expect(readSessionRows([{ id: 's1', paneId: 42 }])).toEqual([
      { id: 's1', viewing: null, hasForegroundProcess: null },
    ]);
  });

  it('still skips a row with no id, because that is the key', () => {
    expect(readSessionRows([{ paneId: 'p1' }, { id: 's2', paneId: 'p2' }])).toEqual([
      { id: 's2', paneId: 'p2', viewing: null, hasForegroundProcess: null },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-agents-core test
```

Expected: FAIL — the first test gets a row with no `paneId` key.

- [ ] **Step 3: Keep the pane in the reader**

In `extensions/agents-core/src/index.ts`, change `SessionRow` to:

```ts
interface SessionRow {
  readonly id: string;
  /** Where it is running. Absent for a session not yet bound to a pane. */
  readonly paneId?: string;
  readonly hasForegroundProcess: boolean | null;
  readonly viewing: boolean | null;
}
```

and inside `readSessionRows`, replace the `rows.push({...})` call with:

```ts
    const pane = row['paneId'];
    rows.push({
      id: row['id'],
      ...(typeof pane === 'string' ? { paneId: pane } : {}),
      hasForegroundProcess: triState(row['hasForegroundProcess']),
      viewing: triState(row['viewing']),
    });
```

- [ ] **Step 4: Run it and watch it pass**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-agents-core test
```

Expected: PASS, 4 new tests, and every pre-existing agents-core test still green.

- [ ] **Step 5: Export the topic name**

In `extensions/agents-core/src/manifest.ts`, directly below `export const SESSION_EXIT_TOPIC = 'session.exit';`:

```ts
/** A session's pane, announced once when it binds. Main publishes it. */
export const SESSION_BOUND_TOPIC = 'session.bound';
```

- [ ] **Step 6: Track the mapping and put it on the wire**

In `extensions/agents-core/src/index.ts`, add `SESSION_BOUND_TOPIC` to the existing import from `./manifest.ts` (it already imports `SESSION_EXIT_TOPIC`).

Directly above the `publish` function, add:

```ts
/**
 * `sessionId → paneId`, so the change this extension emits can be keyed by
 * either end.
 *
 * A consumer cannot re-derive it: `tasks` holds a placeholder session id for the
 * first seconds after a spawn and only the pane is true, which is exactly when an
 * agent hits its trust prompt. Fed by three things and needing all of them — the
 * seed, for sessions that existed before this extension woke; `session.bound`,
 * for the exact moment a new one lands; and the sweep, which is a backstop and
 * nothing more (it returns early unless something is already working or blocked,
 * so it cannot be relied on to see a quiet session at all).
 */
const panes = new Map<string, string>();
```

In `publish`, change the emit line to:

```ts
    const pane = panes.get(change.sessionId);
    events.emit(AGENT_STATE_TOPIC, { ...change, level, alertReason: reason, ...(pane === undefined ? {} : { pane }) });
```

Update the `AgentStateChanged` interface at the bottom of the file:

```ts
export interface AgentStateChanged extends AgentChange {
  readonly level: 'none' | 'info' | 'attention' | 'urgent';
  readonly alertReason: string;
  /**
   * Where it is running. Absent only if the session bound before this extension
   * woke AND the seed has not landed — a consumer keying by pane skips it rather
   * than guessing.
   */
  readonly pane?: string;
}
```

- [ ] **Step 7: Feed the map from all three sources**

In `extensions/agents-core/src/index.ts`, beside the existing `SESSION_EXIT_TOPIC` subscription, add:

```ts
  ctx.subscriptions.push(
    events.on(SESSION_BOUND_TOPIC, (payload) => {
      const bound = payload as { sessionId?: string; paneId?: string };
      if (typeof bound.sessionId !== 'string' || typeof bound.paneId !== 'string') return;
      // Not deferred behind `afterSeed`: this is a fact, not a transition, and a
      // later seed row for the same session carries the same pane. Holding it
      // back would leave the map empty for exactly the window it exists to cover.
      panes.set(bound.sessionId, bound.paneId);
    }),
  );
```

In the existing `SESSION_EXIT_TOPIC` handler, add the removal alongside the `registry.forget` call:

```ts
      panes.delete(exit.sessionId as string);
```

In the seed loop (`for (const row of await readSessions())`), add:

```ts
    if (row.paneId !== undefined) panes.set(row.id, row.paneId);
```

and add the identical line inside `tick()`'s loop, so the sweep refreshes it too.

- [ ] **Step 8: Put the pane on `agents.list`**

Change the `AGENTS_COMMANDS.list` handler to:

```ts
      handler: () => ({
        agents: registry.list().map((record) => {
          const pane = panes.get(record.sessionId);
          return { ...record, ...(pane === undefined ? {} : { pane }) };
        }),
      }),
```

The snapshot must key the same way the subscription does, or a mirror seeded from it seeds nothing.

- [ ] **Step 9: Run the full suite and commit**

```sh
env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add extensions/agents-core/
git commit -m "feat(v2): agents.stateChanged carries the pane it happened in

A consumer cannot re-derive it. \`tasks\` holds a \`pending-\` session id
for the first seconds after a spawn and only the pane is true, which is
exactly when an agent hits its trust prompt -- \`index.test.ts\` has
pinned that window for a while and says so.

Resolve once at the source and announce, which is what core's attention
store already does one layer down. \`agents.list\` grows the same field so
a mirror seeded from the snapshot can key it too.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The rollup, as a pure function

**Files:**
- Create: `extensions/tasks/src/model/agent-rollup.ts`
- Create: `extensions/tasks/src/model/agent-rollup.test.ts`

**Interfaces:**
- Produces: `ROLLUP_PRIORITY`; `type TaskAgentState = 'blocked' | 'error' | 'needsCheck' | 'working' | 'idle'`; `rollUp(states: readonly string[]): TaskAgentState`; `tintFor(state: TaskAgentState): string`

- [ ] **Step 1: Write the failing test**

Create `extensions/tasks/src/model/agent-rollup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ROLLUP_PRIORITY, rollUp, tintFor, type TaskAgentState } from './agent-rollup.ts';

/**
 * Loudest wins — v1's `Tab.attentionState()` priority, for its reason: anything
 * wanting you outranks anything merely busy. A blocked agent waits indefinitely
 * and burns nothing, so it is the fact worth surfacing even while four other
 * sessions make progress.
 */

describe('rollUp', () => {
  it('is idle for a task with no sessions at all', () => {
    expect(rollUp([])).toBe('idle');
  });

  it('folds shell to idle — a bare prompt is not an agent', () => {
    expect(rollUp(['shell', 'shell'])).toBe('idle');
  });

  it('folds an unrecognised word to idle rather than throwing', () => {
    // These values crossed a port from an extension this code has never seen.
    // A cast is not a check, and an unknown word is data.
    expect(rollUp(['sleeping', ''])).toBe('idle');
  });

  it('is the state itself when there is only one', () => {
    expect(rollUp(['working'])).toBe('working');
    expect(rollUp(['blocked'])).toBe('blocked');
  });

  it('lets blocked beat working, because working is not waiting on you', () => {
    expect(rollUp(['working', 'blocked', 'idle'])).toBe('blocked');
  });

  it('lets blocked beat error — you can act on one of them', () => {
    expect(rollUp(['error', 'blocked'])).toBe('blocked');
  });

  it('lets error beat a finished turn', () => {
    expect(rollUp(['needsCheck', 'error'])).toBe('error');
  });

  it('lets a finished turn beat working', () => {
    expect(rollUp(['working', 'needsCheck'])).toBe('needsCheck');
  });

  it('lets working beat idle', () => {
    expect(rollUp(['idle', 'working', 'idle'])).toBe('working');
  });

  it('is order-independent — a rollup is about the set, not the arrival order', () => {
    expect(rollUp(['idle', 'blocked', 'working'])).toBe(rollUp(['working', 'blocked', 'idle']));
  });

  it.each(ROLLUP_PRIORITY)('round-trips %s through itself', (state) => {
    expect(rollUp([state])).toBe(state);
  });
});

describe('tintFor', () => {
  /**
   * The words the renderer already resolves. `needsCheck` deliberately emits
   * `needs-you` and NOT `needs-check`: `TINT_ROLES` maps the latter to `success`,
   * which is green, and a finished turn you have not seen is amber.
   */
  it('maps every rollup state to a word view-dock already knows', () => {
    const expected: Record<TaskAgentState, string> = {
      blocked: 'blocked',
      error: 'error',
      needsCheck: 'needs-you',
      working: 'working',
      idle: 'idle',
    };
    for (const state of ROLLUP_PRIORITY) expect(tintFor(state)).toBe(expected[state]);
  });

  it('never emits needs-check, which the shell paints green', () => {
    expect([...ROLLUP_PRIORITY].map(tintFor)).not.toContain('needs-check');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- agent-rollup
```

Expected: FAIL — `Cannot find module './agent-rollup.ts'`.

- [ ] **Step 3: Write the module**

Create `extensions/tasks/src/model/agent-rollup.ts`:

```ts
/**
 * A task's sessions' agent states → the one state its dot shows.
 *
 * Loudest wins, which is v1's `Tab.attentionState()` priority arrived at for the
 * same reason: anything wanting you outranks anything merely busy. The accepted
 * cost is that one blocked workstream reads blocked while four others make
 * progress — correct, because a blocked agent waits indefinitely and burns
 * nothing, so it is the fact worth surfacing.
 *
 * Total over values, no IO, no host — the same shape as `lifecycle.ts` beside it.
 */

export const ROLLUP_PRIORITY = ['blocked', 'error', 'needsCheck', 'working', 'idle'] as const;

export type TaskAgentState = (typeof ROLLUP_PRIORITY)[number];

/**
 * Takes `readonly string[]` and NOT `readonly AgentState[]`, deliberately.
 *
 * These values crossed a port and came from an extension this code has never
 * seen: `ok` says the call succeeded, not that the value has a shape, and a cast
 * is not a check. An unrecognised word is data rather than a crash, and it folds
 * in with everything else that means nothing is happening.
 *
 * `shell` folds to `idle` for the same reason it is not a sixth state: a pane
 * that has dropped back to a bare prompt has no agent, and "no agent" is already
 * the grey case.
 */
export function rollUp(states: readonly string[]): TaskAgentState {
  const present = new Set(states);
  for (const candidate of ROLLUP_PRIORITY) {
    if (present.has(candidate)) return candidate;
  }
  return 'idle';
}

/**
 * The rollup → the design-token word the row carries.
 *
 * Every word here already resolves in `view-dock`'s `TINT_ROLES`, so this ships
 * without touching the renderer. Two of them are worth stating out loud:
 *
 *   - `needsCheck` emits **`needs-you`**, never `needs-check`. The shell maps
 *     `needs-check` to `success` — green — and a finished turn you have not seen
 *     is amber. That stale entry is a separate question and is deliberately not
 *     touched here.
 *   - `idle` emits `idle`, which `TINT_ROLES` does NOT contain. It resolves by
 *     falling through `statusRole`'s default, which is the behaviour any
 *     unrecognised word gets — so this is also the only real exercise that
 *     fallback has.
 */
export function tintFor(state: TaskAgentState): string {
  return state === 'needsCheck' ? 'needs-you' : state;
}
```

- [ ] **Step 4: Run it and watch it pass**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- agent-rollup
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```sh
git add extensions/tasks/src/model/agent-rollup.ts extensions/tasks/src/model/agent-rollup.test.ts
git commit -m "feat(v2): a task's sessions roll up to one agent state, loudest first

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `displayState` answers from agent state

`displayState` currently folds a lifecycle with a list of attention levels. It becomes the one place the rollup and the lifecycle meet, and the carve-out is exact: archived wins, everything else yields.

**Files:**
- Modify: `extensions/tasks/src/model/lifecycle.ts`
- Modify: `extensions/tasks/src/model/lifecycle.test.ts`

**Interfaces:**
- Consumes: `rollUp`, `TaskAgentState` from Task 3.
- Produces: `type TaskDisplayState = TaskLifecycle | TaskAgentState`; `displayState(lifecycle: TaskLifecycle, agentStates: readonly string[]): TaskDisplayState`

- [ ] **Step 1: Rewrite the `displayState` suite**

In `extensions/tasks/src/model/lifecycle.test.ts`, **leave the `describe('the stored vocabulary')` block exactly as it is** — it is still the D4 guard and must keep passing untouched. Replace only the `describe('displayState')` block with:

```ts
describe('displayState', () => {
  it('is the agents rollup for a running task, not the lifecycle', () => {
    // The whole point: `running` covered working AND idle, so both were blue.
    expect(displayState('running', ['working'])).toBe('working');
    expect(displayState('running', ['idle'])).toBe('idle');
  });

  it('is loudest-wins across the task’s sessions', () => {
    expect(displayState('running', ['working', 'blocked'])).toBe('blocked');
  });

  it('is idle for a running task whose sessions report nothing', () => {
    // A task whose panes have no plugin loaded is genuinely quiet, and saying
    // so is the honest answer. This is the case that will look like a regression.
    expect(displayState('running', [])).toBe('idle');
  });

  it('is idle for a draft, which has no sessions yet', () => {
    expect(displayState('draft', [])).toBe('idle');
  });

  it('is archived whatever the agents say, because archived is not an activity', () => {
    // A stale live session must not make an archived task report as live. In
    // practice they agree — an archived task's sessions are gone — and the
    // carve-out is what makes that a guarantee rather than a coincidence.
    expect(displayState('archived', ['working'])).toBe('archived');
    expect(displayState('archived', [])).toBe('archived');
  });

  it('yields to the rollup for every lifecycle except archived', () => {
    for (const lifecycle of ['draft', 'running', 'review', 'done'] as const) {
      expect(displayState(lifecycle, ['blocked'])).toBe('blocked');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- lifecycle
```

Expected: FAIL — the current `displayState` returns the lifecycle.

- [ ] **Step 3: Rewrite `displayState`**

In `extensions/tasks/src/model/lifecycle.ts`, replace the `AttentionLevel` import with:

```ts
import { rollUp, type TaskAgentState } from './agent-rollup.ts';
```

Replace the `TaskDisplayState` type and the `displayState` function with:

```ts
/** What the sidebar tints by: the lifecycle's one surviving value, or the rollup. */
export type TaskDisplayState = TaskLifecycle | TaskAgentState;

/**
 * The lifecycle and the agents, meeting in one place.
 *
 * It used to fold a lifecycle with the sessions' ATTENTION, and `needs-you` was
 * the only thing it could add. That was the bug: `running` covered a working
 * agent and a sleeping one, so both were blue, and `review`/`done` — the values
 * that would have been the other colours — are written by nothing.
 *
 * Archived is the one lifecycle value that still wins, because an archived task
 * is not a thing whose agents are doing anything and reporting `idle` for it
 * would answer a question nobody asked. In practice the two agree, since an
 * archived task's sessions are gone; the carve-out makes it a guarantee rather
 * than a coincidence a stale session could break.
 *
 * D4 is untouched and stronger: nothing here writes anything. It reads a fact
 * `agents-core` publishes, one topic further upstream than before.
 */
export function displayState(
  lifecycle: TaskLifecycle,
  agentStates: readonly string[],
): TaskDisplayState {
  if (lifecycle === 'archived') return 'archived';
  return rollUp(agentStates);
}
```

- [ ] **Step 4: Run it and watch it pass**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- lifecycle
```

Expected: PASS. `index.test.ts` will now fail — Task 5 fixes it.

- [ ] **Step 5: Commit**

```sh
git add extensions/tasks/src/model/lifecycle.ts extensions/tasks/src/model/lifecycle.test.ts
git commit -m "feat(v2): displayState answers from the agents, not the lifecycle

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Swap the mirror

One mirror out, one in — same key, same shape, one topic further upstream. Plus the seed, without which every row reads grey until its session's next transition.

**Files:**
- Modify: `extensions/tasks/src/index.ts`
- Modify: `extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `displayState` (Task 4), `tintFor` (Task 3), `AgentStateChanged`'s `pane` (Task 2), `agents.list` rows carrying `pane` (Task 2).

- [ ] **Step 1: Port the mirror suite onto the state topic**

In `extensions/tasks/src/index.test.ts`, replace the whole `describe('attention reaching the task tree')` block with the following. **Keep the `pending-1` session id exactly as it is** — it is the regression test for the keying decision, and it is why the mirror is keyed by pane.

```ts
/**
 * Agent state, end to end — the bus to the row.
 *
 * The session below carries a `pending-` id ON PURPOSE, and it is now load
 * bearing twice over: that is what a session looks like for the first seconds
 * after a spawn, it is exactly when an agent is most likely to ask something,
 * and a mirror keyed by session id would drop it. The mirror is keyed by PANE,
 * which is why `agents.stateChanged` carries one.
 */
describe('agent state reaching the task tree', () => {
  const spawned = task({ sessions: [{ id: 'pending-1', role: 'orchestrator', pane: 'p1' }] });
  const change = (to: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId: 's1',
    kindId: 'claude-code',
    pane: 'p1',
    from: 'idle',
    to,
    turnFinished: false,
    level: 'none',
    alertReason: '',
    ...over,
  });

  it('is idle before anything reports, however alive the task is', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    expect(await listedState(h)).toBe('idle');
    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('goes blue while an agent works, keyed by pane and not by the pending id', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('working'));

    expect(await listedState(h)).toBe('working');
    const row = await rowOf(h, 't1');
    expect(row?.tint).toBe('working');
    expect(row?.description).toBe('working');
  });

  it('turns a finished turn amber, spelled needs-you and never needs-check', async () => {
    // `needs-check` is mapped to `success` by the shell — green — and a turn you
    // have not seen is amber.
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('needsCheck', { turnFinished: true, level: 'attention' }));

    expect((await rowOf(h, 't1'))?.tint).toBe('needs-you');
  });

  it('goes back to idle when the agent is viewed, which rides the same topic', async () => {
    // `registry.observeViewed` writes needsCheck -> idle and emits it, so the
    // clear needs no second channel.
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('needsCheck', { turnFinished: true }));
    expect((await rowOf(h, 't1'))?.tint).toBe('needs-you');

    h.emit('agents.stateChanged', change('idle', { from: 'needsCheck' }));

    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('goes grey when the agent quits back to a shell', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('working'));
    h.emit('agents.stateChanged', change('shell', { from: 'working' }));

    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('ignores a pane no task is running in, rather than colouring the nearest one', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('blocked', { pane: 'p9' }));

    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('drops a change with no pane rather than keying the mirror on undefined', async () => {
    // A payload that crossed a port; an entry keyed on `undefined` could never
    // be cleared, because no later change can name that key.
    const h = (live = harness({ tasks: [spawned] }));
    const { pane: _dropped, ...noPane } = change('blocked');
    h.emit('agents.stateChanged', noPane);

    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('nudges the tree on a delta, because the host only re-reads when asked', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    let nudges = 0;
    h.tree().onDidChange?.(() => {
      nudges += 1;
    });

    h.emit('agents.stateChanged', change('blocked'));
    expect(nudges).toBe(1);

    // The same state again is not a delta — a state can be re-announced with a
    // new reason, and rebuilding the tree for that is work with no change in it.
    h.emit('agents.stateChanged', change('blocked', { reason: 'plan approval' }));
    expect(nudges).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- index
```

Expected: FAIL — nothing subscribes to `agents.stateChanged` yet, so every row stays at its lifecycle tint.

- [ ] **Step 3: Replace the mirror**

In `extensions/tasks/src/index.ts`:

Replace the `ATTENTION_TOPIC` constant and its `AttentionChanged` interface (~lines 130–145) with:

```ts
/**
 * `agents-core`'s topic and its payload, as a literal and a local shape.
 *
 * Extension code may import `@shepherd/sdk` and nothing else, so it cannot reach
 * `@shepherd/ext-agents-core` for either — the same reason `ext-host/api.ts`
 * keeps its own copy of a topic string. A topic name is public vocabulary, like
 * a command id, and this interface is a read of what the bus carries: narrower
 * than the emitter's, and every field optional at the type level because it
 * crossed a port.
 */
const AGENT_STATE_TOPIC = 'agents.stateChanged';

interface AgentStateChanged {
  readonly pane?: string;
  readonly to?: string;
}
```

Remove `type AttentionLevel` from the `@shepherd/sdk` import block at the top of the file.

Add to the imports beside `displayState`:

```ts
import { tintFor, type TaskAgentState } from './model/agent-rollup.ts';
```

Replace `const attention = new Map<string, AttentionLevel>();` (line 268) with:

```ts
/**
 * `paneId → agent state`, and the only copy of it this extension holds.
 *
 * A MIRROR, because `tasks` cannot ask: reads do not cross the port
 * (`attention.get` throws `ACROSS_A_PORT`), so an extension subscribes to an
 * announcement and keeps its own map. This replaces the attention mirror rather
 * than joining it — `needs-you` was always derived from state upstream, so
 * deriving it here removes a copy instead of adding one, and two mirrors of one
 * fact are two things that can disagree.
 *
 * Keyed by PANE, which is why `agents.stateChanged` carries one: a task's record
 * holds a `pending-` session id for the first seconds after a spawn, and only
 * its pane is true.
 */
const agentState = new Map<string, string>();
```

Replace the `attentionOf` helper (~line 288) with:

```ts
  /**
   * D4, made real: what a task's agents are doing is READ from the panes, never
   * written anywhere.
   *
   * A session whose pane never mounted contributes nothing rather than a guess,
   * and so does one the mirror has not heard from — both are "no signal", which
   * `rollUp` folds to idle.
   */
  const agentStatesOf = (task: TaskRecord): readonly string[] =>
    task.sessions.flatMap((session) => {
      const state = session.pane === undefined ? undefined : agentState.get(session.pane);
      return state === undefined ? [] : [state];
    });
```

Replace the whole `events.on(ATTENTION_TOPIC, ...)` subscription block with:

```ts
  ctx.subscriptions.push(
    events.on<AgentStateChanged>(AGENT_STATE_TOPIC, (payload) => {
      // Structural, not schematic: the payload crossed a port, and a malformed
      // one must be dropped rather than keying the mirror on `undefined` — which
      // could then never be cleared, since no later change can name that key.
      if (typeof payload?.pane !== 'string' || typeof payload.to !== 'string') return;
      const delta = agentState.get(payload.pane) !== payload.to;
      agentState.set(payload.pane, payload.to);
      // The tree is pull-based (ADR 0031): the host re-asks `children()` only
      // when nudged, so a mirror that changed and did not nudge is a sidebar
      // still showing the old state. Nudged on a real delta only, because a
      // state can be re-announced with a new reason and nothing here has moved.
      if (delta) changed();
    }),
  );
```

- [ ] **Step 4: Seed the mirror**

Immediately after that subscription, add:

```ts
  /**
   * Follow first, then pull, and merge the snapshot UNDER what has arrived.
   *
   * An extension that only subscribes misses everything published before it woke,
   * and every row would read grey until its session's next transition. The
   * renderer solved this the same way and for the same reason (`app.tsx`): a
   * transition landing between the two is newer than the snapshot by
   * construction, so the snapshot must never overwrite it.
   *
   * Failure is a warn, not a throw: a seed that did not land costs accuracy until
   * the next transition, which is the state this extension has always started in.
   */
  void commands
    .invoke<{ agents?: readonly { pane?: unknown; state?: unknown }[] }>('agents.list')
    .then((answer) => {
      if (!answer.ok || !Array.isArray(answer.value?.agents)) {
        ctx.log.warn('agents.list did not seed the agent-state mirror; rows stay idle until the next change');
        return;
      }
      let seeded = 0;
      for (const row of answer.value.agents) {
        if (typeof row?.pane !== 'string' || typeof row.state !== 'string') continue;
        if (agentState.has(row.pane)) continue;
        agentState.set(row.pane, row.state);
        seeded += 1;
      }
      if (seeded > 0) changed();
    })
    .catch((error: unknown) => {
      ctx.log.warn(`agents.list threw while seeding the agent-state mirror — ${String(error)}`);
    });
```

- [ ] **Step 5: Point the row and the command at it**

In `rowFor` (~line 1733), change:

```ts
            const state = displayState(task.lifecycle, agentStatesOf(task));
            return {
              id: task.id,
              label: task.title,
              description: state,
              tint: state === 'archived' ? 'wool-faint' : tintFor(state as TaskAgentState),
```

In the `tasks.list` handler (~line 1181), change the `displayState` call to:

```ts
          displayState: displayState(task.lifecycle, agentStatesOf(task)),
```

- [ ] **Step 6: Run everything and watch it pass**

```sh
env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test
```

Expected: PASS, including `vendor-boundary.test.ts` unchanged.

```sh
env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 7: Commit**

```sh
git add extensions/tasks/src/index.ts extensions/tasks/src/index.test.ts
git commit -m "feat(v2): the task dot shows what its agents are doing

One mirror out, one in -- same key, one topic further upstream. The
attention mirror is deleted rather than joined: needs-you was always
derived from state, so deriving it here removes a copy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Prove it in the running app

A green unit suite is not a working app, and this repo has the scars: the archive-on-close was wired to a pane id the layout regenerates, and every unit test passed because every one supplied *both halves* of the correlation. Tasks 1–5 are exactly that shape — a topic, a mirror, and a rollup, each tested with fixtures this plan also wrote.

**Files:** none.

- [ ] **Step 1: Run the end-to-end gate**

```sh
env -u NODE_OPTIONS pnpm smoke:m3
```

Expected: PASS.

- [ ] **Step 2: Ship to the night build, so the daily app is untouched**

```sh
env -u NODE_OPTIONS pnpm ship --dev
```

- [ ] **Step 3: Confirm the mirror is fed**

In a task pane in **Shep Night**, with an agent running:

```sh
curl -s --unix-socket ~/.shepherd/v2-dev/control.sock -X POST \
  -H 'content-type: application/json' \
  -d '{"command":"agents.list","args":{},"caller":{"kind":"device","deviceId":"local-cli"}}' \
  http://localhost/invoke
```

Expected: at least one agent, each row carrying **both** `sessionId` and `pane`. A row with no `pane` means Task 2's map is not being fed — check that `session.bound` is reaching the extension.

- [ ] **Step 4: Watch the four colours**

Confirm each transition on screen, because this is the only check that covers the wiring end to end:

| do this | expect |
| --- | --- |
| agent mid-turn | ● blue |
| let the turn finish, look at another root | ● amber |
| click back to the task | ○ grey |
| agent hits a permission prompt | ● amber, and it stays amber while you look at it |
| quit `claude`, leaving a shell | ○ grey |
| archive the task | moves to DONE |

- [ ] **Step 5: Expect the grey, and do not treat it as a bug**

Any task whose panes have no plugin loaded goes **blue → grey**. That is the design working. Confirm it is that and not a regression by checking the pane is genuinely untracked:

```sh
# its session should be absent from agents.list
```

Reload the plugin in that pane and it should come back to life.

- [ ] **Step 6: Commit nothing, report what you saw**

If every transition holds, the work is done. If one does not, the failure is in the wiring between the tested pieces — start at `agents.list` and walk outward.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Loudest-wins priority | 3 |
| No agent → grey | 3 (`shell`/unknown → idle), 4 (`[]` → idle) |
| Spinner stays task-level | none needed — `busy` is untouched by design |
| One mirror replaces another | 5 |
| The topic carries its own pane | 1, 2 |
| Rollup is pure, takes `string[]` | 3 |
| Vocabulary: `needs-you` not `needs-check` | 3 (`tintFor`, plus a test asserting it) |
| Archived still selects DONE | 4 (carve-out), 5 (`wool-faint` untouched) |
| `description` becomes the agent word | 5 |
| `tasks.list` `displayState` repointed | 5 |
| Seeding, follow-then-pull, merge under | 5 |
| Risk: dark panes go grey | 6, step 5 |

**Placeholder scan:** clean — no TBD, no "add error handling", every code step carries its code.

**Type consistency:** `rollUp(readonly string[]) → TaskAgentState` (Task 3) is what `displayState` calls (Task 4) with `agentStatesOf(task): readonly string[]` (Task 5). `tintFor(TaskAgentState) → string` is called in Task 5 only on the non-archived branch, which is exactly where `displayState`'s return narrows to `TaskAgentState`. `SessionRow.paneId?: string` (Task 2) matches `panes.set(row.id, row.paneId)` under its `!== undefined` guard.

**One thing left deliberately un-narrowed:** in Task 5 `tintFor(state as TaskAgentState)` casts. `displayState` returns `TaskLifecycle | TaskAgentState`, and the branch has only excluded `'archived'` — TypeScript cannot see that `review`/`done`/`draft` are unwritable, because the type still permits them. The honest alternatives are a runtime check for values nothing writes, or narrowing `displayState`'s return; both are bigger than the problem. If the implementer prefers, `ROLLUP_PRIORITY.includes(state) ? tintFor(state) : 'idle'` removes the cast at the cost of a branch — either is acceptable, and neither should hold up the task.
