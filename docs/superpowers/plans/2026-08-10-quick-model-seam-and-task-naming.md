# Quick-Model Seam and Task Naming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give extensions a one-line way to ask a cheap model something, and use it to name a task's worktree and branch without a ~6s model call ever being able to delay a `git worktree add`.

**Architecture:** `agents-core` grows `agents.complete` — a permission-gated command whose spawn is one file — plus a `headless` half on `AgentKind` that `claude-code` fills in with `claude -p --safe-mode --tools ""`. `tasks` asks it speculatively while the brief is being typed (`tasks.suggestName`), and provisioning overlaps the per-repo ref reads with the model, awaiting a name for at most 4s before falling back to a local heuristic. Nothing is ever renamed: the slug may change exactly once, before the first git write.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), Electron utility process for extensions, vitest, pnpm workspaces, ESLint boundaries as the architecture diagram.

**Spec:** [`docs/superpowers/specs/2026-08-10-quick-model-seam-and-task-naming-design.md`](../specs/2026-08-10-quick-model-seam-and-task-naming-design.md) — decisions D16–D25.

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before any of our code runs, and the symptom is every check failing at once with no output explaining why.
- **The gate for every task:** `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.
- **`pnpm smoke:m3` is required before any task/layout/composer work is called done.** A green unit suite is not a working app; see Task 11.
- **An extension never names a vendor.** No `claude`, no model id, no vendor flag outside `extensions/claude-code/`. `agents-core` and `tasks` must not contain the string `claude`.
- **Nothing an extension writes may call `Date.now()`.** Use `ctx.clock.now()`, and pass the clock into pure functions that need time.
- **`tooling/eslint/boundaries.js` IS the architecture diagram.** `node:os`, `child_process` and `node:process` are denied to extensions. `fs`, `path` and `url` are allowed.
- **A command's answer is `unknown`.** It crossed an IPC port from an extension this code has never seen. Read defensively; a cast is not a check.
- **`@shepherd/ui` is the design system; do not hand-roll a control.** Busy state is the braille spinner (`useBrailleFrame`); pulses and shimmer are banned.
- **A manifest lives in two places** — `src/manifest.ts` and `package.json`'s `shepherd` key — and `manifest.test.ts` asserts they are identical. Change both.
- **Model id:** `claude-haiku-4-5`, and it may appear only in `extensions/claude-code/`.
- **Measured argv:** `claude -p <prompt> --model <model> --safe-mode --tools ""`.
- **Measured child env allow-list:** exactly `{ HOME, USER }`. `PATH` is `runExec`'s. Without `USER` the CLI answers "Not logged in · Please run /login" in ~2s.
- **Deadlines:** the ask's own timeout is `15_000`ms; provisioning waits at most `4_000`ms for it. Two different clocks, deliberately.

---

## File Structure

**`packages/sdk/src/api.ts`** — `ExtensionContext.userName` (D25).
**`packages/app/src/main/ext-host.ts`, `packages/app/src/ext-host/api.ts`** — fill `userName` beside `homeDir`.

**`extensions/agents-core/src/`**
- `kind.ts` — gains `HeadlessHalf`, `HeadlessInput`, and `AgentKind.headless`.
- `quick-model.ts` *(new)* — pure: which kind and which model serve the quick tier.
- `complete.ts` *(new)* — the only file in the repo outside `platform/darwin` that spawns a model. Deadline, output cap, concurrency limit, env allow-list.
- `manifest.ts` — two command ids, one KV key, `process.exec` permission.
- `index.ts` — wires the two commands.

**`extensions/claude-code/src/kind.ts`** — the `headless` half. The only place a model id or a CLI flag appears.

**`extensions/tasks/src/`**
- `model/naming.ts` *(new)* — pure: `namingPrompt`, `readName`, `heuristicName`.
- `provision.ts` — `provisionRepo` splits into `readRepoRefs` + `addWorktree`.
- `manifest.ts` — `tasks.suggestName`, `agents` permission.
- `index.ts` — the command, the pending-name cache, the race, the one permitted slug change.

**`extensions/tasks/ui/composer.tsx`** — the ask on blur/idle and the preview line.
**`packages/ui/src/index.ts`** — export `useBrailleFrame`.
**`extensions/diagnostics/src/`** — a stub kind, dev-only, so smoke needs no network.
**`packages/app/src/main/smoke-m3.ts`** — the app-level assertion.
**`packages/cli/src/argv.ts`** — `shepherd agent quick-model`.

---

## Task 1: `ExtensionContext.userName`

**Files:**
- Modify: `packages/sdk/src/api.ts` (after `homeDir`, ~line 57)
- Modify: `packages/app/src/ext-host/api.ts:248` (the option) and `:269` (the context it builds)
- Modify: `packages/app/src/ext-host/runtime.ts:307` (passes `ask.homeDir` through)
- Modify: `packages/app/src/main/ext-host.ts:155` (the host-side field, where the value is resolved)
- Test: `packages/app/src/ext-host/runtime.test.ts:127` and `packages/app/src/main/ext-host.test.ts:153` — both already construct with `homeDir`. **There is no `api.test.ts`; do not create one.**

**Interfaces:**
- Consumes: nothing.
- Produces: `ctx.userName: string` on `ExtensionContext`.

- [ ] **Step 1: See the whole chain before touching it**

```bash
cd v2 && grep -rn "homeDir" packages/sdk/src packages/app/src
```

Four non-test hits, and they are the chain in order: `main/ext-host.ts` resolves
it, `ext-host/runtime.ts` passes it across, `ext-host/api.ts` puts it on the
context, `sdk/api.ts` declares it. `userName` follows the same four.

- [ ] **Step 2: Write the failing test**

Add to `packages/app/src/ext-host/runtime.test.ts`, beside the existing
`homeDir: '/tmp/shepherd-test/home'` fixture — extend that same fixture with
`userName: 'ada'` and assert what the extension receives:

```ts
it('hands the extension the user name, because node:os is denied to it', () => {
  // A program an extension runs gets an environment the extension BUILDS —
  // `ProcessAPI.exec` replaces rather than merges — and a child handed only HOME
  // cannot find the credentials a keychain lookup needs.
  expect(contextFor('shepherd.diagnostics').userName).toBe('ada');
});
```

Use the file's own helper for reaching a built context; if it asserts on
`homeDir` anywhere, mirror that assertion's shape exactly.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run packages/app/src/ext-host/runtime.test.ts
```

Expected: FAIL — `userName` does not exist on the options type.

- [ ] **Step 4: Add the field to the SDK**

In `packages/sdk/src/api.ts`, directly after the `homeDir` field:

```ts
  /**
   * The account name the app is running as — `USER`, not a display name.
   *
   * Here for the same reason `homeDir` is: `boundaries.js` denies `node:os` to
   * an extension, so it cannot compute one. It exists because a program an
   * extension runs may need it in an environment the extension builds from
   * nothing — `ProcessAPI.exec` REPLACES the environment rather than merging it,
   * and a child handed only `HOME` cannot find the credentials a keychain lookup
   * needs.
   */
  readonly userName: string;
```

- [ ] **Step 5: Fill it along the whole chain**

Add `userName` beside `homeDir` at all four sites from Step 1, resolving it in
`main/ext-host.ts` from `os.userInfo().username` — main may reach `node:os`, and
the extension host may not. Do **not** read `process.env` in the extension host:
this value is the host's to resolve, which is the entire reason the field exists.

- [ ] **Step 6: Run the gate**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: PASS. A missed construction site shows up as a typecheck error naming
the file, which is the point of making the field required rather than optional.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/api.ts packages/app/src
git commit -m "feat(v2): an extension is told the user name, because it may not ask the OS"
```

---

## Task 2: `AgentKind.headless` and the quick-model resolver

**Files:**
- Modify: `extensions/agents-core/src/kind.ts`
- Create: `extensions/agents-core/src/quick-model.ts`
- Test: `extensions/agents-core/src/quick-model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HeadlessHalf`, `HeadlessInput`, `AgentKind.headless?: HeadlessHalf`, `QuickOverride`, `QuickTarget`, `resolveQuick(kinds, override): QuickTarget | undefined`.

- [ ] **Step 1: Write the failing test**

Create `extensions/agents-core/src/quick-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentKind } from './kind.ts';
import { resolveQuick } from './quick-model.ts';

/**
 * Which kind and which model serve the quick tier.
 *
 * The case worth naming is the LAST one: a configured kind that is not present
 * resolves to nothing rather than to somebody else's vendor. Silently falling
 * back would spend the user's budget on a model they did not choose.
 */

const kind = (id: string, quickModel?: string): AgentKind => ({
  id,
  topics: [],
  reduce: () => ({ kind: 'ignore', why: 'not under test' }),
  ...(quickModel === undefined
    ? {}
    : { headless: { quickModel, argv: () => [], parse: (out: string) => out } }),
});

describe('resolveQuick', () => {
  it('has no answer when nothing is registered', () => {
    expect(resolveQuick([], undefined)).toBeUndefined();
  });

  it('ignores a kind with no headless half', () => {
    expect(resolveQuick([kind('interactive-only')], undefined)).toBeUndefined();
  });

  it('takes the first capable kind, in the order the point handed them over', () => {
    const target = resolveQuick([kind('a', 'model-a'), kind('b', 'model-b')], undefined);
    expect(target?.kind.id).toBe('a');
    expect(target?.model).toBe('model-a');
  });

  it('skips an incapable kind ahead of a capable one', () => {
    const target = resolveQuick([kind('interactive-only'), kind('b', 'model-b')], undefined);
    expect(target?.kind.id).toBe('b');
  });

  it('lets the override name the model without naming the kind', () => {
    const target = resolveQuick([kind('a', 'model-a')], { model: 'something-cheaper' });
    expect(target?.kind.id).toBe('a');
    expect(target?.model).toBe('something-cheaper');
  });

  it('lets the override name the kind', () => {
    const target = resolveQuick([kind('a', 'model-a'), kind('b', 'model-b')], { kind: 'b' });
    expect(target?.kind.id).toBe('b');
    expect(target?.model).toBe('model-b');
  });

  it('answers nothing when the configured kind is absent, rather than another vendor', () => {
    expect(resolveQuick([kind('a', 'model-a')], { kind: 'gone' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/agents-core/src/quick-model.test.ts
```

Expected: FAIL — `Cannot find module './quick-model.ts'`.

- [ ] **Step 3: Add the headless half to `kind.ts`**

Append to `extensions/agents-core/src/kind.ts`, and add the field to `AgentKind`:

```ts
/**
 * What one non-interactive call to this vendor looks like (§7c).
 *
 * `argv` and `parse` are the whole vendor surface: the deadline, the output cap,
 * the concurrency limit and the child's environment belong to `complete.ts`,
 * because a kind that owned those would be a kind that reimplements them —
 * which is the failure the seam exists to prevent.
 */
export interface HeadlessInput {
  readonly prompt: string;
  readonly model: string;
  readonly system?: string;
}

export interface HeadlessHalf {
  /**
   * This vendor's cheap tier, and the ONLY place a model id may appear. A
   * consumer asks for the quick tier and never learns what served it — the same
   * rule `resumeTargetOf` follows (D11).
   */
  readonly quickModel: string;
  argv(input: HeadlessInput): readonly string[];
  /** stdout → the answer, or `undefined` if this output carries none. */
  parse(stdout: string): string | undefined;
}
```

Then, inside `interface AgentKind`, after `capabilities`:

```ts
  /**
   * Present iff this vendor can answer a one-shot prompt. A kind without it is
   * invisible to `agents.complete`, which is what makes `no-kind` an honest
   * answer rather than a hang.
   */
  readonly headless?: HeadlessHalf;
```

- [ ] **Step 4: Write `quick-model.ts`**

```ts
import type { AgentKind, HeadlessHalf } from './kind.ts';

/**
 * Which kind and which model serve the quick tier.
 *
 * The user's configuration is one optional record and the kind's own declaration
 * is the default, which is §7c's rule ("the consumer's choice or, omitted, the
 * user's configured default") with the consumer's half left out — no consumer
 * has asked to pick a vendor per call, and adding the parameter before one does
 * would be a public API shaped by nobody.
 */

export interface QuickOverride {
  /** A kind id. Absent means "the first capable one". */
  readonly kind?: string;
  /** A vendor's model id. Absent means the kind's own `quickModel`. */
  readonly model?: string;
}

export interface QuickTarget {
  readonly kind: AgentKind & { readonly headless: HeadlessHalf };
  readonly model: string;
}

export function resolveQuick(
  kinds: readonly AgentKind[],
  override: QuickOverride | undefined,
): QuickTarget | undefined {
  const capable = kinds.filter(
    (kind): kind is AgentKind & { headless: HeadlessHalf } => kind.headless !== undefined,
  );
  const wanted = override?.kind;
  /**
   * A configured kind that is not registered resolves to NOTHING — never to
   * whichever other vendor happens to be first. Falling back would spend the
   * user's model budget on a vendor they explicitly did not choose, and the only
   * evidence would be a bill.
   */
  const chosen = wanted === undefined ? capable[0] : capable.find((kind) => kind.id === wanted);
  if (chosen === undefined) return undefined;
  return { kind: chosen, model: override?.model ?? chosen.headless.quickModel };
}
```

- [ ] **Step 5: Run the test**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/agents-core/src/quick-model.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add extensions/agents-core/src/kind.ts extensions/agents-core/src/quick-model.ts extensions/agents-core/src/quick-model.test.ts
git commit -m "feat(v2): a kind may declare a headless half, and one of them serves the quick tier"
```

---

## Task 3: `complete.ts` — the spawn

**Files:**
- Create: `extensions/agents-core/src/complete.ts`
- Test: `extensions/agents-core/src/complete.test.ts`

**Interfaces:**
- Consumes: `QuickTarget` from Task 2.
- Produces: `CompleteAnswer`, `CompleteInput`, `QUICK_TIMEOUT_MS`, `MAX_STDOUT_BYTES`, `MAX_CONCURRENT`, `childEnv(homeDir, userName)`, `limiter(max)`, `runComplete(deps, target, input)`.

- [ ] **Step 1: Write the failing test**

Create `extensions/agents-core/src/complete.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Clock, ExecErr, ExecOk, ExecOptions, ProcessAPI } from '@shepherd/sdk';
import type { AgentKind, HeadlessHalf } from './kind.ts';
import { childEnv, limiter, runComplete, MAX_STDOUT_BYTES } from './complete.ts';

/**
 * The one file in this extension that runs a program.
 *
 * Every assertion here is about the mechanism rather than about a vendor: what
 * the child is handed, how long it may take, how much it may say, and how many
 * may run at once. What it SAYS is `claude-code`'s test.
 */

const headless = (over: Partial<HeadlessHalf> = {}): HeadlessHalf => ({
  quickModel: 'model-q',
  argv: ({ prompt, model }) => ['fake-agent', '-p', prompt, '--model', model],
  parse: (out) => out.trim(),
  ...over,
});

const target = (over: Partial<HeadlessHalf> = {}) => ({
  kind: { id: 'fake', topics: [], reduce: () => ({ kind: 'ignore' as const, why: 'x' }), headless: headless(over) },
  model: 'model-q',
});

function fakeProcess(answer: ExecOk | ExecErr, seen: { cmd?: readonly string[]; opts?: ExecOptions } = {}): ProcessAPI {
  return {
    exec: (cmd, opts) => {
      seen.cmd = cmd;
      seen.opts = opts;
      return Promise.resolve(answer);
    },
    gitRead: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }),
    gitWrite: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }),
  };
}

const clockAt = (times: number[]): Clock => {
  let i = 0;
  return { now: () => times[Math.min(i++, times.length - 1)] ?? 0 } as Clock;
};

const deps = (process_: ProcessAPI, clock: Clock = clockAt([0, 1])) => ({
  process: process_,
  clock,
  dataDir: '/tmp/shepherd-quick-test',
  homeDir: '/Users/ada',
  userName: 'ada',
});

describe('childEnv', () => {
  it('is an allow-list of exactly HOME and USER', () => {
    // Measured: PATH is runExec's, and without USER the CLI answers
    // "Not logged in · Please run /login" in ~2s — which reads exactly like a
    // machine that was never authenticated.
    expect(childEnv('/Users/ada', 'ada')).toEqual({ HOME: '/Users/ada', USER: 'ada' });
  });
});

describe('runComplete', () => {
  it('passes the kind its own argv, in the extension dataDir, with the allow-list env', async () => {
    const seen: { cmd?: readonly string[]; opts?: ExecOptions } = {};
    const answer = await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'a-good-name\n', stderr: '' }, seen)),
      target(),
      { prompt: 'name this' },
    );
    expect(answer).toEqual({ ok: true, text: 'a-good-name' });
    expect(seen.cmd).toEqual(['fake-agent', '-p', 'name this', '--model', 'model-q']);
    expect(seen.opts?.cwd).toBe('/tmp/shepherd-quick-test');
    expect(seen.opts?.env).toEqual({ HOME: '/Users/ada', USER: 'ada' });
    expect(seen.opts?.timeoutMs).toBe(15_000);
  });

  it('honours a caller deadline', async () => {
    const seen: { opts?: ExecOptions } = {};
    await runComplete(deps(fakeProcess({ ok: true, stdout: 'x', stderr: '' }, seen)), target(), {
      prompt: 'p',
      timeoutMs: 4_000,
    });
    expect(seen.opts?.timeoutMs).toBe(4_000);
  });

  it('calls a slow failure a timeout and a quick one a failure', async () => {
    // A timeout and a crash arrive as the same ExecErr, so elapsed time is the
    // only thing that can tell them apart.
    const slow = await runComplete(
      { ...deps(fakeProcess({ ok: false, code: -1, stdout: '', stderr: '' })), clock: clockAt([0, 15_000]) },
      target(),
      { prompt: 'p' },
    );
    expect(slow).toMatchObject({ ok: false, reason: 'timeout' });

    const quick = await runComplete(
      { ...deps(fakeProcess({ ok: false, code: 1, stdout: '', stderr: 'boom' })), clock: clockAt([0, 12]) },
      target(),
      { prompt: 'p' },
    );
    expect(quick).toMatchObject({ ok: false, reason: 'failed', message: 'boom' });
  });

  it('calls an unusable answer empty rather than returning it', async () => {
    const blank = await runComplete(deps(fakeProcess({ ok: true, stdout: '   \n', stderr: '' })), target(), {
      prompt: 'p',
    });
    expect(blank).toMatchObject({ ok: false, reason: 'empty' });

    const none = await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'anything', stderr: '' })),
      target({ parse: () => undefined }),
      { prompt: 'p' },
    );
    expect(none).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('caps what parse is shown, so a runaway answer cannot be held whole', async () => {
    let shown = -1;
    await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'x'.repeat(MAX_STDOUT_BYTES * 3), stderr: '' })),
      target({
        parse: (out) => {
          shown = out.length;
          return 'ok';
        },
      }),
      { prompt: 'p' },
    );
    expect(shown).toBe(MAX_STDOUT_BYTES);
  });
});

describe('limiter', () => {
  it('runs no more than the cap at once and still finishes everything', async () => {
    const gate = limiter(2);
    let active = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };
    await Promise.all([gate(job), gate(job), gate(job), gate(job), gate(job)]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it('releases its slot when a job throws', async () => {
    const gate = limiter(1);
    await expect(gate(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    await expect(gate(() => Promise.resolve('after'))).resolves.toBe('after');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/agents-core/src/complete.test.ts
```

Expected: FAIL — `Cannot find module './complete.ts'`.

- [ ] **Step 3: Write `complete.ts`**

```ts
import { mkdirSync } from 'node:fs';
import type { Clock, ProcessAPI } from '@shepherd/sdk';
import type { QuickTarget } from './quick-model.ts';

/**
 * Asking a model something — the `complete` half of §7c's headless seam, and the
 * only file in this extension that runs a program.
 *
 * It exists so that an extension author who wants one smart feature does not
 * write their own spawn plumbing. Everything the vendor knows is in its kind's
 * `headless` half; everything about *how a call is run* is here, because the
 * alternative — measured in §7c's own argument — is every kind reimplementing
 * the deadline, the cap and the environment, each of them differently.
 *
 * **The environment is an allow-list, and that is not a precaution.**
 * `runExec` REPLACES the environment rather than merging it (`platform/darwin`'s
 * `exec.ts`: "the caller's env is kept exactly as given except for PATH"), so a
 * child inherits nothing unless it is named here. Which is the safe direction:
 * `SHEPHERD_TAB_ID` and `SHEPHERD_SOCK` cannot leak into a nested agent and be
 * reported as some pane's lifecycle, because they are not there at all.
 */

/** Long enough for a cold vendor CLI; short enough that nothing waits forever. */
export const QUICK_TIMEOUT_MS = 15_000;

/** A quick answer is a handful of words. Anything more is a runaway. */
export const MAX_STDOUT_BYTES = 4_096;

/** Two at once: this spends the user's model budget, and nothing here is urgent. */
export const MAX_CONCURRENT = 2;

export type CompleteAnswer =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'no-kind' | 'timeout' | 'failed' | 'empty';
      readonly message: string;
    };

export interface CompleteInput {
  readonly prompt: string;
  readonly system?: string;
  /** The CALLER's deadline (ADR 0030). Defaults to `QUICK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface CompleteDeps {
  readonly process: ProcessAPI;
  readonly clock: Clock;
  /** This extension's own directory — a neutral cwd, never a repo. */
  readonly dataDir: string;
  readonly homeDir: string;
  readonly userName: string;
}

/**
 * Everything the child gets, and nothing else.
 *
 * `HOME` alone is not enough: measured, a vendor CLI handed only `HOME` and
 * `PATH` answers "Not logged in · Please run /login" in about two seconds, which
 * is indistinguishable from a machine nobody ever signed in on. `USER` is what
 * its credential lookup needs, and `LOGNAME` is not a substitute.
 */
export function childEnv(homeDir: string, userName: string): Record<string, string> {
  return { HOME: homeDir, USER: userName };
}

/** At most `max` at once, in arrival order. Frees its slot even on a throw. */
export function limiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export async function runComplete(
  deps: CompleteDeps,
  target: QuickTarget,
  input: CompleteInput,
): Promise<CompleteAnswer> {
  // `dataDir` is not created for you (`ExtensionContext`), and a cwd that does
  // not exist fails inside spawn with an errno rather than a sentence.
  mkdirSync(deps.dataDir, { recursive: true });

  const timeoutMs = input.timeoutMs ?? QUICK_TIMEOUT_MS;
  const argv = target.kind.headless.argv({
    prompt: input.prompt,
    model: target.model,
    ...(input.system === undefined ? {} : { system: input.system }),
  });

  const started = deps.clock.now();
  const run = await deps.process.exec([...argv], {
    cwd: deps.dataDir,
    timeoutMs,
    env: childEnv(deps.homeDir, deps.userName),
  });

  if (!run.ok) {
    // A killed-on-deadline child and a crashed one are the same `ExecErr`, so
    // elapsed time is the only thing left to tell them apart. Worth telling
    // apart: one means "the model is slow", the other "the binary is broken".
    const elapsed = deps.clock.now() - started;
    return {
      ok: false,
      reason: elapsed >= timeoutMs ? 'timeout' : 'failed',
      message: run.stderr.trim() || `${argv[0] ?? 'the agent'} exited ${run.code}`,
    };
  }

  const text = target.kind.headless.parse(run.stdout.slice(0, MAX_STDOUT_BYTES));
  if (text === undefined || text.trim() === '') {
    return { ok: false, reason: 'empty', message: 'the model returned nothing usable' };
  }
  return { ok: true, text: text.trim() };
}
```

- [ ] **Step 4: Run the test**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/agents-core/src/complete.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add extensions/agents-core/src/complete.ts extensions/agents-core/src/complete.test.ts
git commit -m "feat(v2): one place asks a model, and it hands the child an allow-list"
```

---

## Task 4: wire `agents.complete` and `agents.quickModel`

**Files:**
- Modify: `extensions/agents-core/src/manifest.ts`
- Modify: `extensions/agents-core/package.json` (the `shepherd` key)
- Modify: `extensions/agents-core/src/index.ts`
- Modify: `packages/cli/src/argv.ts`
- Test: `extensions/agents-core/src/index.test.ts` (create if absent), `packages/cli/src/argv.test.ts`

**Interfaces:**
- Consumes: `resolveQuick` (Task 2); `runComplete`, `limiter`, `MAX_CONCURRENT` (Task 3).
- Produces: command ids `agents.complete` and `agents.quickModel`; KV key `quick-model`.

- [ ] **Step 1: Write the failing tests**

Add to `extensions/agents-core/src/index.test.ts` (follow the file's existing
harness; if the file does not exist, model it on `extensions/tasks/src/index.test.ts`'s
`harness()` — a fake `CommandAPI` that keeps `registered` in a map, a `KV` over a
`Map`, and a fake `ProcessAPI`):

```ts
it('refuses to ask when no kind offers a headless half', async () => {
  const h = harness();
  const answer = await h.invoke('agents.complete', { prompt: 'hello' });
  expect(answer).toMatchObject({ ok: false, reason: 'no-kind' });
});

it('registers agents.complete behind the agents permission', () => {
  const h = harness();
  expect(h.specOf('agents.complete')?.permission).toBe('agents');
});

it('remembers a quick-model override and reports the effective answer', async () => {
  const h = harness();
  h.registerKind({ id: 'fake', topics: [], reduce: () => ({ kind: 'ignore', why: 'x' }),
    headless: { quickModel: 'model-q', argv: () => ['fake'], parse: (o: string) => o } });

  expect(await h.invoke('agents.quickModel', {})).toMatchObject({ kind: 'fake', model: 'model-q' });
  expect(await h.invoke('agents.quickModel', { model: 'model-cheap' })).toMatchObject({ model: 'model-cheap' });
  // Read back through a fresh activation: the override is storage, not memory.
  expect(await h.reactivate().invoke('agents.quickModel', {})).toMatchObject({ model: 'model-cheap' });
  expect(await h.invoke('agents.quickModel', { clear: true })).toMatchObject({ model: 'model-q' });
});
```

And in `packages/cli/src/argv.test.ts`:

```ts
it('maps the quick-model verb', () => {
  expect(parseArgv(['agent', 'quick-model', '--model', 'model-cheap'])).toMatchObject({
    ok: true,
    command: 'agents.quickModel',
    args: { model: 'model-cheap' },
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/agents-core packages/cli
```

Expected: FAIL — unknown command `agents.complete`, unknown verb `quick-model`.

- [ ] **Step 3: Extend the manifest (both copies)**

In `extensions/agents-core/src/manifest.ts`, add to `AGENTS_COMMANDS`:

```ts
  /**
   * Ask the quick tier something — §7c's `complete`, and the whole of the
   * headless seam this build ships.
   *
   * A COMMAND rather than a method on the API this extension exports, and that
   * is about enforcement: `CommandSpec.permission` is checked by `authorize()`
   * in the dispatcher before a handler runs, while an object handed over by
   * `extensions.get` has nothing in between. As a method, the `agents`
   * permission would be decorative.
   */
  complete: 'agents.complete',
  /** Read, set or clear which kind and model serve the quick tier. */
  quickModel: 'agents.quickModel',
```

Below the commands, add:

```ts
/**
 * The user's quick-tier choice, in this extension's own KV.
 *
 * One key rather than a settings system, because v2 has none — there is no
 * config API in core and no counterpart to v1's `SettingsView`. When one lands,
 * this becomes a row in it and no consumer changes.
 */
export const QUICK_MODEL_KEY = 'quick-model';
```

Then add `'process.exec'` to `permissions`, with the reason in place:

```ts
  /**
   * `process.exec` is here for the headless seam, and it is the heaviest grant
   * in the vocabulary (ADR 0037). The alternative — every kind spawning for
   * itself — is the failure §7c invoked to justify the seam. Confined by three
   * rules: the spawn lives in `complete.ts` alone, its argv comes only from a
   * registered kind, and a caller's influence stops at the prompt text.
   */
  permissions: ['sessions', 'storage', 'attention', 'process.exec'],
```

And add both commands to `contributes.commands`:

```ts
      { id: AGENTS_COMMANDS.complete, title: 'Agents: Ask the Quick Model' },
      { id: AGENTS_COMMANDS.quickModel, title: 'Agents: Quick Model' },
```

Mirror **all** of that into `extensions/agents-core/package.json`'s `shepherd`
key — `permissions` and `contributes.commands`. `manifest.test.ts` asserts the two
are identical and will fail loudly if you skip it.

- [ ] **Step 4: Wire the commands in `index.ts`**

Add the imports:

```ts
import { limiter, runComplete, MAX_CONCURRENT, type CompleteAnswer } from './complete.ts';
import { resolveQuick, type QuickOverride } from './quick-model.ts';
import { AGENTS_COMMANDS, QUICK_MODEL_KEY, ... } from './manifest.ts';
```

Then, inside `activate`, after the `kinds` point is defined:

```ts
  const overrideSchema = s.stored({ kind: s.optional(s.string()), model: s.optional(s.string()) });
  const readOverride = (): QuickOverride | undefined => ctx.storage.get(QUICK_MODEL_KEY, overrideSchema);
  /**
   * The cap is per host, not per caller: it exists because this spends the
   * user's model budget, and a caller that could have its own share would make
   * the total the number of extensions installed.
   */
  const quickLimit = limiter(MAX_CONCURRENT);

  ctx.subscriptions.push(
    commands.register(AGENTS_COMMANDS.complete, {
      title: 'Agents: Ask the Quick Model',
      permission: 'agents',
      schema: s.object({
        prompt: s.string(),
        system: s.optional(s.string()),
        timeoutMs: s.optional(s.int()),
      }),
      /**
       * Never throws and never hangs: every failure is one of four reasons, and
       * the deadline is the caller's. A model call is the most tempting place in
       * the app to forget both.
       */
      handler: async (args): Promise<CompleteAnswer> => {
        const target = resolveQuick(kinds.all(), readOverride());
        if (target === undefined) {
          const configured = readOverride()?.kind;
          return {
            ok: false,
            reason: 'no-kind',
            message:
              configured === undefined
                ? 'no registered agent kind offers a headless half'
                : `the configured kind "${configured}" is not registered`,
          };
        }
        const answer = await quickLimit(() =>
          runComplete(
            {
              process: api.proposed.process,
              clock: ctx.clock,
              dataDir: ctx.dataDir,
              homeDir: ctx.homeDir,
              userName: ctx.userName,
            },
            target,
            args,
          ),
        );
        // `info`, not `warn`: an unavailable model is not a fault of whoever
        // asked, and this extension's warn channel is for things a user can act
        // on.
        if (!answer.ok) ctx.log.info(`quick model: ${answer.reason} — ${answer.message}`);
        return answer;
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(AGENTS_COMMANDS.quickModel, {
      title: 'Agents: Quick Model',
      schema: s.object({
        kind: s.optional(s.string()),
        model: s.optional(s.string()),
        clear: s.optional(s.boolean()),
      }),
      /**
       * One verb for read, set and clear, because from a terminal they are one
       * question — `shepherd agent quick-model` shows it, the same line with a
       * flag changes it. It always answers the EFFECTIVE resolution rather than
       * the stored override, since what a user wants to know is which model will
       * actually run.
       */
      handler: (args) => {
        if (args.clear === true) ctx.storage.delete(QUICK_MODEL_KEY);
        else if (args.kind !== undefined || args.model !== undefined) {
          const current = readOverride() ?? {};
          ctx.storage.set(QUICK_MODEL_KEY, {
            ...current,
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(args.model === undefined ? {} : { model: args.model }),
          });
        }
        const target = resolveQuick(kinds.all(), readOverride());
        return {
          kind: target?.kind.id ?? null,
          model: target?.model ?? null,
          override: readOverride() ?? null,
          available: kinds.all().filter((kind) => kind.headless !== undefined).map((kind) => kind.id),
        };
      },
    }),
  );
```

- [ ] **Step 5: Add the CLI verb**

In `packages/cli/src/argv.ts`, change the `agent` entry:

```ts
  agent: { list: 'agents.list', 'quick-model': 'agents.quickModel' },
```

- [ ] **Step 6: Run the gate**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: PASS, including `manifest.test.ts` (which proves the two manifest
copies agree).

- [ ] **Step 7: Commit**

```bash
git add extensions/agents-core packages/cli
git commit -m "feat(v2): agents.complete, gated on the permission that has named it since M1"
```

---

## Task 5: `claude-code`'s headless half

**Files:**
- Modify: `extensions/claude-code/src/kind.ts`
- Test: `extensions/claude-code/src/kind.test.ts`

**Interfaces:**
- Consumes: `HeadlessHalf` (Task 2).
- Produces: `claudeKind().headless`, `QUICK_MODEL`, `quickArgv`, `parseQuick`.

- [ ] **Step 1: Write the failing test**

Add to `extensions/claude-code/src/kind.test.ts`:

```ts
import { parseQuick, quickArgv, QUICK_MODEL, claudeKind } from './kind.ts';

/**
 * The vendor's half of the quick tier: the flags, and the junk its answers
 * arrive wrapped in.
 *
 * Every flag below was measured on 2026-08-10 and each is load-bearing — see the
 * spec's measurement table. This test is the record, so that a later "why so
 * many flags?" has an answer that is not a guess.
 */
describe('quickArgv', () => {
  const argv = quickArgv({ prompt: 'name this task', model: QUICK_MODEL });

  it('runs the vendor binary in print mode with the prompt as an argument', () => {
    // An argument rather than stdin: `runExec` reaches `execFile` with an array,
    // so there is no shell and nothing to quote wrongly.
    expect(argv[0]).toBe('claude');
    expect(argv).toContain('-p');
    expect(argv).toContain('name this task');
    expect(argv).toContain('--model');
    expect(argv).toContain(QUICK_MODEL);
  });

  it('disables every customization, because the full CLI is expensive and chatty', () => {
    // --safe-mode: CLAUDE.md discovery (this repo's is ~46k tokens), skills,
    // plugins, hooks (including Shepherd's own report.sh), MCP servers, custom
    // agents and workflows. Worth ~2s and two whole classes of bug.
    expect(argv).toContain('--safe-mode');
  });

  it('disables every tool, because the job is to return six words', () => {
    // `--tools ""` is the documented form. NOT a --settings deny-list, which
    // would enumerate vendor tool names and rot as that set changes; and
    // --max-turns does not exist in the installed CLI.
    const at = argv.indexOf('--tools');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('');
  });

  it('never passes --bare, which cannot authenticate under a managed login pin', () => {
    expect(argv).not.toContain('--bare');
  });
});

describe('parseQuick', () => {
  it('takes a plain answer', () => {
    expect(parseQuick('add-a-cheap-model-seam\n')).toBe('add-a-cheap-model-seam');
  });

  it('unwraps backticks, which three of seven measured answers arrived in', () => {
    expect(parseQuick('`cheap-model-task-naming`')).toBe('cheap-model-task-naming');
  });

  it('takes the first line and drops a chatty preamble', () => {
    expect(parseQuick('Here is a name:\nadd-cheap-model-seam\n')).toBe('add-cheap-model-seam');
  });

  it('has no answer for empty output', () => {
    expect(parseQuick('   \n\n')).toBeUndefined();
  });
});

describe('claudeKind', () => {
  it('declares a headless half, so it can serve the quick tier', () => {
    expect(claudeKind().headless?.quickModel).toBe(QUICK_MODEL);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/claude-code/src/kind.test.ts
```

Expected: FAIL — `quickArgv` is not exported.

- [ ] **Step 3: Implement it in `kind.ts`**

```ts
import type { HeadlessInput } from '@shepherd/ext-agents-core';

/**
 * This vendor's cheap tier — the only model id in the repo, and it may only ever
 * live in this file (`vendor-boundary.test.ts` is the rule; this is the vendor).
 */
export const QUICK_MODEL = 'claude-haiku-4-5';

/**
 * The flags, and why there are exactly two beyond the prompt. All measured
 * 2026-08-10 on a subscription login; the spec carries the table.
 *
 * `--safe-mode` disables CLAUDE.md discovery, skills, plugins, hooks, MCP
 * servers, custom agents, commands and workflows while leaving auth, model
 * selection and policy settings working. It is worth ~2s, and it closes two
 * hazards outright: a repo's CLAUDE.md (~46k tokens here) being read on every
 * call, and OUR OWN hooks firing for a nested call and reporting its lifecycle
 * as some pane's.
 *
 * `--tools ""` is the documented way to disable all tools. `--max-turns` does
 * not exist in the installed CLI, and a `--settings` deny-list would enumerate
 * tool names that move when the vendor's set does.
 *
 * `--bare` is deliberately absent and must stay absent: it never reads OAuth or
 * the keychain, so under a managed `forceLoginMethod` pin it cannot authenticate
 * at all — it exits 1 in under a second, and no API key changes that, because a
 * non-OAuth credential is exactly what such a pin rejects.
 */
export function quickArgv(input: HeadlessInput): readonly string[] {
  return ['claude', '-p', input.prompt, '--model', input.model, '--safe-mode', '--tools', ''];
}

/**
 * The first usable line, unwrapped.
 *
 * Measured: three of seven answers came back wrapped in backticks, and one
 * arrived under a preamble line. A model asked for six words will sometimes
 * write a sentence about the six words, so the first non-empty line is taken and
 * the decoration is stripped. Judging whether the result is *usable* is the
 * consumer's — `parse` only reports what the vendor said.
 */
export function parseQuick(stdout: string): string | undefined {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const bare = last.replace(/^[`"'*\s]+|[`"'*\s]+$/g, '').trim();
  return bare === '' ? undefined : bare;
}
```

Then, in the object `claudeKind()` returns, add:

```ts
    headless: { quickModel: QUICK_MODEL, argv: quickArgv, parse: parseQuick },
```

Note `parseQuick` takes the **last** non-empty line, not the first: a preamble
comes before the answer, never after. The test above asserts exactly that case.

- [ ] **Step 4: Run the test**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/claude-code
```

Expected: PASS.

- [ ] **Step 5: Check the vendor boundary still holds**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/vendor-boundary.test.ts
grep -rn "claude" extensions/agents-core/src extensions/tasks/src | grep -v '\.test\.'
```

Expected: PASS, and the `grep` prints **nothing**. A hit means a vendor name
escaped into a vendor-blind extension.

- [ ] **Step 6: Commit**

```bash
git add extensions/claude-code
git commit -m "feat(v2): claude-code can answer a one-shot prompt, with every customization off"
```

---

## Task 6: `naming.ts` — the prompt, the sanitizer, the fallback

**Files:**
- Create: `extensions/tasks/src/model/naming.ts`
- Test: `extensions/tasks/src/model/naming.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `namingPrompt(brief): string`, `readName(answer): string | undefined`, `heuristicName(brief): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `extensions/tasks/src/model/naming.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { heuristicName, namingPrompt, readName } from './naming.ts';
import { slugify } from './slug.ts';

/**
 * The three pure decisions in task naming, and the most defect-prone code in the
 * feature. A model asked for six words returns junk often enough that this file
 * is the cheapest place to catch it: measured, three of seven answers came back
 * wrapped in backticks.
 */

const REAL_BRIEF =
  "#shepherd I wanna add a new feature / extension. It's something like a \"dumb\" model, that I can use for simple tasks, like commit messages, titling threads, etc, etc.";

describe('namingPrompt', () => {
  it('carries the brief and asks for one short line', () => {
    const prompt = namingPrompt('fix the login redirect loop');
    expect(prompt).toContain('fix the login redirect loop');
    expect(prompt.toLowerCase()).toContain('title');
  });

  it('caps a very long brief, because a paragraph is not a better question', () => {
    expect(namingPrompt('x'.repeat(10_000)).length).toBeLessThan(3_000);
  });
});

describe('readName', () => {
  it('takes a plain short title', () => {
    expect(readName('Add a cheap model seam')).toBe('Add a cheap model seam');
  });

  it('unwraps quotes, backticks and a trailing stop', () => {
    expect(readName('"Add a cheap model seam."')).toBe('Add a cheap model seam');
    expect(readName('`add-cheap-model-seam`')).toBe('add-cheap-model-seam');
  });

  it('collapses whitespace', () => {
    expect(readName('Add   a  cheap\tmodel seam')).toBe('Add a cheap model seam');
  });

  it('caps at eight words, because the answer becomes a directory name', () => {
    expect(readName('one two three four five six seven eight nine ten')).toBe(
      'one two three four five six seven eight',
    );
  });

  it('refuses a paragraph', () => {
    expect(readName('x'.repeat(200))).toBeUndefined();
  });

  it('refuses a refusal', () => {
    expect(readName("I'm sorry, I can't help with that")).toBeUndefined();
    expect(readName('I cannot name this task')).toBeUndefined();
  });

  it('refuses nothing at all', () => {
    expect(readName('')).toBeUndefined();
    expect(readName('   ')).toBeUndefined();
    expect(readName('`` ')).toBeUndefined();
  });

  it('cannot produce a name that escapes its directory', () => {
    // Belt and braces: `slugify` already makes traversal unrepresentable, and
    // this asserts the two compose rather than trusting either alone.
    expect(slugify(readName('../../etc/passwd') ?? '')).not.toContain('/');
    expect(slugify(readName('../../etc/passwd') ?? '')).not.toContain('..');
  });
});

describe('heuristicName', () => {
  it('strips the filler a real brief starts with', () => {
    // The fallback is what you SEE whenever the model is slow or off, so it is
    // held to the real input: this is the brief that produced the branch
    // `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`.
    const name = heuristicName(REAL_BRIEF);
    expect(name).toBeDefined();
    expect(slugify(name ?? '')).not.toContain('i-wanna');
    expect(slugify(name ?? '')).not.toContain('shepherd');
    expect(slugify(name ?? '').split('-').length).toBeLessThanOrEqual(6);
  });

  it('takes the first sentence, not the first 72 characters', () => {
    expect(heuristicName('Fix the login loop. Then also rewrite the router.')).toBe('Fix the login loop');
  });

  it('drops a leading please and a question form', () => {
    expect(heuristicName('Please can you fix the login loop')).toBe('fix the login loop');
  });

  it('has no answer for an empty brief, so the caller keeps its own title', () => {
    expect(heuristicName('')).toBeUndefined();
    expect(heuristicName('   \n  ')).toBeUndefined();
  });

  it('answers something for a brief that is only filler', () => {
    // Stripping everything must not produce an empty name — the caller would
    // then fall back to the untouched title, which is the bug being fixed.
    expect(heuristicName('I wanna')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/model/naming.test.ts
```

Expected: FAIL — `Cannot find module './naming.ts'`.

- [ ] **Step 3: Write `naming.ts`**

```ts
/**
 * Naming a task — the three pure decisions, kept away from anything that spawns.
 *
 * A task's name becomes a directory, a branch and a sidebar row, and until now it
 * was the brief's first line capped at 72 characters. That is how a branch came
 * to be called `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`:
 * the composer is deliberately ONE field, so the title IS the brief.
 *
 * The model returns a short TITLE rather than a slug (D18). `slugify` already
 * makes traversal unrepresentable and `uniqueSlug` already resolves collisions
 * once, so handing that pipeline a good six-word title gets a good branch for
 * free — and fixes the row label, which is the same string.
 */

/** More than this and the model is reading a paragraph rather than a task. */
const MAX_BRIEF_CHARS = 2_000;

/** A name is a directory: eight words is already generous. */
const MAX_WORDS = 8;

/** Past this, the answer is prose and not a title. */
const MAX_NAME_CHARS = 80;

/** Openings that carry no information about the work. */
const FILLER =
  /^(?:#\w+\s+)?(?:hey\s+|hi\s+|ok(?:ay)?\s+|so\s+)?(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+wanna\s+|i\s+want\s+to\s+|i'?d\s+like\s+to\s+|i\s+need\s+to\s+|we\s+should\s+|we\s+need\s+to\s+|let'?s\s+|lets\s+|help\s+me\s+)+/i;

/** How a model declines. Never a name, and it slugifies into something plausible. */
const REFUSAL = /^(?:i'?m\s+sorry|sorry|i\s+can(?:'?t|not)|i\s+am\s+unable|as\s+an\s+ai)/i;

export function namingPrompt(brief: string): string {
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  return [
    'Write a short title for this development task, for use as a git branch name.',
    'Rules: at most 6 words, imperative mood, no quotes, no backticks, no trailing period.',
    'Reply with the title alone and nothing else.',
    '',
    'Task:',
    trimmed,
  ].join('\n');
}

/**
 * The model's answer, or nothing.
 *
 * `undefined` means "use the fallback" and is a completely ordinary outcome — a
 * cheap model asked for six words will sometimes decline, sometimes explain
 * itself, and often wrap the answer in decoration.
 */
export function readName(answer: string): string | undefined {
  const first = answer.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (first === undefined) return undefined;

  const bare = first
    .replace(/^[`"'*\s]+/, '')
    .replace(/[`"'*\s]+$/, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (bare === '' || bare.length > MAX_NAME_CHARS) return undefined;
  if (REFUSAL.test(bare)) return undefined;
  return bare.split(' ').slice(0, MAX_WORDS).join(' ');
}

/**
 * The name you get when the model is slow, off, or unauthenticated — so it is
 * held to real briefs rather than to tidy ones.
 *
 * `undefined` means "I have nothing better", and the caller then keeps the title
 * it already had.
 */
export function heuristicName(brief: string): string | undefined {
  const firstLine = brief.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (firstLine === undefined) return undefined;

  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const withoutFiller = sentence.replace(FILLER, '').replace(/\s+/g, ' ').trim();
  const words = withoutFiller.replace(/[.!?]+$/, '').split(' ').filter((word) => word !== '');
  if (words.length === 0) return undefined;
  return words.slice(0, 6).join(' ');
}
```

- [ ] **Step 4: Run the test**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/model/naming.test.ts
```

Expected: PASS. If the `REAL_BRIEF` case fails on word count, the fix is in
`FILLER`, not in the test — the test encodes the requirement.

- [ ] **Step 5: Commit**

```bash
git add extensions/tasks/src/model/naming.ts extensions/tasks/src/model/naming.test.ts
git commit -m "feat(v2): a task's name, and the junk a cheap model wraps it in"
```

---

## Task 7: split `provisionRepo` into read-refs and add-worktree

**Files:**
- Modify: `extensions/tasks/src/provision.ts`
- Modify: `extensions/tasks/src/index.ts` (the one call site, ~line 981)
- Test: `extensions/tasks/src/provision.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `readRepoRefs(process_, repo, timeoutMs?): Promise<RepoRefs>` and `addWorktree(process_, repo, branch, dest, refs, timeoutMs?): Promise<RepoOutcome>`. `provisionRepo` stays, implemented as the two in sequence, so no caller has to change at once.

**This task changes no behaviour.** It is a pure refactor, committed on its own so
a reviewer can reject the split without rejecting the feature.

- [ ] **Step 1: Write the failing test**

Add to `extensions/tasks/src/provision.test.ts`:

```ts
import { addWorktree, readRepoRefs } from './provision.ts';

/**
 * The split exists so the model can think while git talks to the network: the
 * refs read needs only the repo path, and the branch name is not needed until
 * the worktree is added. Probe 2 sized the win — one fetch is ~2.5s and a
 * `worktree add` is 0.16s.
 */
describe('readRepoRefs', () => {
  it('needs only the repo path — no branch, no destination', async () => {
    const git = fakeGit({
      read: { ok: true, stdout: 'main\nfix-login\n', stderr: '' },
    });
    const refs = await readRepoRefs(git, { name: 'api', path: '/src/api' });
    expect(refs.localBranches).toContain('fix-login');
    // The fetch is opportunistic and comes first, so the model has the whole of
    // it to answer in.
    expect(git.calls[0]?.args).toEqual(['fetch', '--quiet', 'origin']);
    expect(git.calls.every((call) => call.opts.cwd === '/src/api')).toBe(true);
  });

  it('never writes', async () => {
    const git = fakeGit({});
    await readRepoRefs(git, { name: 'api', path: '/src/api' });
    expect(git.calls.filter((call) => call.fn === 'gitWrite')).toEqual([]);
  });
});

describe('addWorktree', () => {
  it('refuses a branch another worktree holds, without running git', async () => {
    const git = fakeGit({});
    const outcome = await addWorktree(git, { name: 'api', path: '/src/api' }, 'fix-login', '/d/fix-login/api', {
      localBranches: ['fix-login'],
      remoteBranches: [],
      checkedOutBranches: ['fix-login'],
      defaultBase: undefined,
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(git.calls).toEqual([]);
  });

  it('checks out a branch that exists locally', async () => {
    const git = fakeGit({});
    const outcome = await addWorktree(git, { name: 'api', path: '/src/api' }, 'fix-login', '/d/fix-login/api', {
      localBranches: ['fix-login'],
      remoteBranches: [],
      checkedOutBranches: [],
      defaultBase: undefined,
    });
    expect(outcome).toMatchObject({ ok: true, worktree: '/d/fix-login/api' });
    expect(git.calls[0]?.args).toEqual(['worktree', 'add', '/d/fix-login/api', 'fix-login']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/provision.test.ts
```

Expected: FAIL — `readRepoRefs` is not exported.

- [ ] **Step 3: Do the split**

Replace the body of `provisionRepo` in `extensions/tasks/src/provision.ts` with
the two halves, keeping every existing comment attached to the half it explains:

```ts
/**
 * Everything git knows about this repo's branches — the half that needs no name.
 *
 * Separated from adding the worktree so that a slow question elsewhere can be
 * asked concurrently with this: the fetch is ~2.5s of network per repo (probe 2)
 * and `worktree add` is 0.16s, so the name only has to arrive before the last
 * 0.16s rather than before the first call.
 *
 * The fetch is **opportunistic**: it improves the base ref when it works and is
 * ignored when it does not. v1 aborted when it failed, which makes a repo with
 * no remote — or an offline machine — unusable.
 */
export async function readRepoRefs(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  timeoutMs = 120_000,
): Promise<RepoRefs> {
  const opts = { cwd: repo.path, timeoutMs };
  const lines = async (args: string[]): Promise<string[]> => {
    const out = await process_.gitRead(args, opts);
    return out.ok ? out.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '') : [];
  };

  await process_.gitRead(['fetch', '--quiet', 'origin'], opts).catch(() => undefined);

  return {
    localBranches: await lines(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    remoteBranches: await lines(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    // Every branch some worktree of this repo already holds. A branch belongs to
    // one worktree, so this is what makes the refusal possible instead of a
    // `--force` that would give two worktrees one branch.
    checkedOutBranches: await lines(['worktree', 'list', '--porcelain']).then((rows) =>
      rows.filter((row) => row.startsWith('branch ')).map((row) => row.slice('branch refs/heads/'.length)),
    ),
    defaultBase: (await lines(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))[0],
  };
}

/** The 0.16s that needs the name. Everything it decides is in `resolveBranch`. */
export async function addWorktree(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  branch: string,
  dest: string,
  refs: RepoRefs,
  timeoutMs = 120_000,
): Promise<RepoOutcome> {
  const plan = resolveBranch(branch, dest, refs);
  if (!plan.ok) return { ok: false, name: repo.name, reason: plan.reason };

  const added = await process_.gitWrite([...plan.args], { cwd: repo.path, timeoutMs });
  if (!added.ok) return { ok: false, name: repo.name, reason: added.stderr.trim() || `git exited ${added.code}` };
  return { ok: true, name: repo.name, worktree: dest };
}

/**
 * Both halves, in order — what every caller wanted before the name became a
 * question that takes seconds to answer.
 */
export async function provisionRepo(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  branch: string,
  dest: string,
  timeoutMs = 120_000,
): Promise<RepoOutcome> {
  const refs = await readRepoRefs(process_, repo, timeoutMs);
  return addWorktree(process_, repo, branch, dest, refs, timeoutMs);
}
```

Keep the long doc comment currently above `provisionRepo` (the three-cases-plus-a-refusal
one) where it is — it explains the pair.

- [ ] **Step 4: Run the whole tasks suite**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks
```

Expected: PASS, including every pre-existing provisioning test. This refactor
must not change one assertion.

- [ ] **Step 5: Commit**

```bash
git add extensions/tasks/src/provision.ts extensions/tasks/src/provision.test.ts
git commit -m "refactor(v2): reading a repo's refs does not need to know the branch yet"
```

---

## Task 8: `tasks.suggestName` and the pending-name cache

**Files:**
- Modify: `extensions/tasks/src/manifest.ts`
- Modify: `extensions/tasks/package.json` (the `shepherd` key)
- Modify: `extensions/tasks/src/index.ts`
- Test: `extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `namingPrompt`, `readName` (Task 6); the `agents.complete` command id (Task 4).
- Produces: command `tasks.suggestName` answering `{ name: string | null }`; an internal `pendingName(brief): Promise<string | undefined>` that is single-flight per brief.

- [ ] **Step 1: Write the failing test**

Add to `extensions/tasks/src/index.test.ts`:

```ts
/**
 * The composer's speculative ask, and the cache that makes it provisioning's ask
 * too (D21). Without the cache, the exact case speculation exists for — Create
 * pressed a second before the answer lands — pays for the model twice and waits
 * ~6s from scratch.
 */
describe('tasks.suggestName', () => {
  const answering = (text: string, calls: { n: number }) => (id: string) =>
    id === 'agents.complete'
      ? ((calls.n += 1), { ok: true as const, value: { ok: true, text } })
      : undefined;

  it('asks the quick model and sanitizes what comes back', async () => {
    const calls = { n: 0 };
    const h = harness({ invoke: answering('`Add a cheap model seam`', calls) });
    expect(await h.invoke('tasks.suggestName', { brief: 'a brief long enough to ask about' })).toEqual({
      name: 'Add a cheap model seam',
    });
  });

  it('asks once per brief, however many callers want it', async () => {
    const calls = { n: 0 };
    const h = harness({ invoke: answering('Add a cheap model seam', calls) });
    const brief = 'a brief long enough to ask about';
    await Promise.all([h.invoke('tasks.suggestName', { brief }), h.invoke('tasks.suggestName', { brief })]);
    expect(calls.n).toBe(1);
  });

  it('does not ask about a brief too short to name', async () => {
    const calls = { n: 0 };
    const h = harness({ invoke: answering('whatever', calls) });
    expect(await h.invoke('tasks.suggestName', { brief: 'fix it' })).toEqual({ name: null });
    expect(calls.n).toBe(0);
  });

  it('answers null when the model cannot, and does not warn about it', async () => {
    const warnings: string[] = [];
    const h = harness({
      onWarn: (line) => warnings.push(line),
      invoke: (id) =>
        id === 'agents.complete'
          ? { ok: true as const, value: { ok: false, reason: 'failed', message: 'no binary' } }
          : undefined,
    });
    expect(await h.invoke('tasks.suggestName', { brief: 'a brief long enough to ask about' })).toEqual({
      name: null,
    });
    expect(warnings).toEqual([]);
  });

  it('answers null when the answer has a shape nobody expected', async () => {
    // A command's answer is `unknown` and came from an extension this code has
    // never seen. A cast is not a check.
    const h = harness({ invoke: (id) => (id === 'agents.complete' ? { ok: true as const, value: 42 } : undefined) });
    expect(await h.invoke('tasks.suggestName', { brief: 'a brief long enough to ask about' })).toEqual({
      name: null,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/index.test.ts -t suggestName
```

Expected: FAIL — unknown command `tasks.suggestName`.

- [ ] **Step 3: Add the manifest entries (both copies)**

In `extensions/tasks/src/manifest.ts`, add to `TASK_COMMANDS`:

```ts
  /**
   * What should this task be called? — asked while the brief is still being
   * typed, so a ~6s answer costs nothing.
   *
   * A command for the same reason `suggestRepos` is one: the composer is a page
   * and cannot reach an extension point or another extension's verb, so it asks
   * its own extension, which asks the model (D5).
   */
  suggestName: 'tasks.suggestName',
```

Add `'agents'` to `permissions` with the reason:

```ts
   * `agents` is what lets this extension ask a model to name a task. Its own
   * grant rather than a corollary of `process.exec`, because it spends the
   * user's model budget — which is not a consequence "can run programs"
   * prepares anybody for.
   */
  permissions: ['storage', 'process.exec', 'sessions', 'views', 'layout', 'agents'],
```

And to `contributes.commands`:

```ts
      { id: TASK_COMMANDS.suggestName, title: 'Tasks: Suggest a Name' },
```

Mirror both into `extensions/tasks/package.json`'s `shepherd` key.

- [ ] **Step 4: Implement the cache and the command in `index.ts`**

Add the import:

```ts
import { heuristicName, namingPrompt, readName } from './model/naming.ts';
```

Then, inside `activate` (near the other helpers, before the command registrations):

```ts
  /** Below this, there is nothing to name yet and asking spends budget for nothing. */
  const MIN_BRIEF_CHARS = 24;
  /** How long the ASK may take. Provisioning's patience is a different clock. */
  const NAME_ASK_TIMEOUT_MS = 15_000;

  /**
   * The last naming ask, keyed by the brief it was asked about.
   *
   * One entry, not a map: the composer asks about a brief that is growing, and
   * every earlier answer is about text nobody has on screen any more. Keeping
   * this is what makes the composer's ask and provisioning's ask the same ask
   * (D21) — Create pressed while one is in flight awaits it instead of starting
   * a second and paying for the model twice.
   */
  let pending: { brief: string; answer: Promise<string | undefined> } | undefined;

  const askForName = async (brief: string): Promise<string | undefined> => {
    const answer = await commands.invoke('agents.complete', {
      prompt: namingPrompt(brief),
      timeoutMs: NAME_ASK_TIMEOUT_MS,
    });
    if (!answer.ok) return undefined;
    /**
     * Read defensively. `ok` says the call succeeded, not that the value has a
     * shape — it crossed a port from an extension this code has never seen.
     */
    const value = answer.value as { ok?: unknown; text?: unknown } | null;
    if (typeof value !== 'object' || value === null || value.ok !== true) return undefined;
    if (typeof value.text !== 'string') return undefined;
    return readName(value.text);
  };

  const pendingName = (brief: string): Promise<string | undefined> => {
    const trimmed = brief.trim();
    if (trimmed.length < MIN_BRIEF_CHARS) return Promise.resolve(undefined);
    if (pending?.brief === trimmed) return pending.answer;
    // Never rejects: a naming failure is not a failure of whatever asked.
    const answer = askForName(trimmed).catch(() => undefined);
    pending = { brief: trimmed, answer };
    return answer;
  };

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.suggestName, {
      title: 'Tasks: Suggest a Name',
      schema: s.object({ brief: s.string() }),
      handler: async (args) => ({ name: (await pendingName(args.brief)) ?? null }),
    }),
  );
```

- [ ] **Step 5: Run the tests**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/src/manifest.ts extensions/tasks/package.json extensions/tasks/src/index.ts extensions/tasks/src/index.test.ts
git commit -m "feat(v2): a task can be named while its brief is still being written"
```

---

## Task 9: the race — `create` takes a name, and the slug changes once

**Files:**
- Modify: `extensions/tasks/src/index.ts`
- Test: `extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `pendingName` (Task 8); `readRepoRefs`, `addWorktree` (Task 7); `heuristicName` (Task 6).
- Produces: `tasks.create` accepts `name?: string`; `runProvision(task, images?, naming?)` where `naming` is `{ settle(task): Promise<TaskRecord> }`.

- [ ] **Step 1: Write the failing test**

Add to `extensions/tasks/src/index.test.ts`:

```ts
/**
 * The race, and the invariant that keeps it from becoming a rename: the slug may
 * change exactly once, before the first git write, and never after.
 */
describe('naming a task at create', () => {
  const REPO = { path: '/src/api', name: 'api' };

  it('uses a name the caller already has, and never asks', async () => {
    const calls = { n: 0 };
    const h = harness({
      invoke: (id) => (id === 'agents.complete' ? ((calls.n += 1), undefined) : undefined),
    });
    const task = (await h.invoke('tasks.create', {
      title: 'I wanna add a cheap model, something like a dumb one',
      brief: 'I wanna add a cheap model, something like a dumb one',
      name: 'Add a cheap model seam',
      repos: [REPO],
    })) as { slug: string; title: string };
    expect(task.slug).toBe('add-a-cheap-model-seam');
    expect(task.title).toBe('Add a cheap model seam');
    expect(calls.n).toBe(0);
  });

  it('falls back to the heuristic, not the whole first line', async () => {
    const h = harness({ invoke: () => undefined });
    const task = (await h.invoke('tasks.create', {
      title: "#shepherd I wanna add a new feature / extension. It's something like a dumb model",
      brief: "#shepherd I wanna add a new feature / extension. It's something like a dumb model",
      repos: [],
    })) as { slug: string };
    // The bug being fixed produced
    // `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`.
    expect(task.slug).not.toContain('i-wanna');
    expect(task.slug.split('-').length).toBeLessThanOrEqual(6);
  });

  it('adopts a name that lands before the first git write, exactly once', async () => {
    const h = harness({
      invoke: (id) =>
        id === 'agents.complete'
          ? { ok: true as const, value: { ok: true, text: 'Add a cheap model seam' } }
          : undefined,
    });
    const created = (await h.invoke('tasks.create', {
      title: 'I wanna add a cheap model for naming things',
      brief: 'I wanna add a cheap model for naming things',
      repos: [REPO],
    })) as { id: string; slug: string };

    await h.settled();
    const stored = h.tasksNow().find((task) => task.id === created.id);
    expect(stored?.slug).toBe('add-a-cheap-model-seam');
    // The worktree was added under the SETTLED name — one name for the lifetime
    // of the task, and no rename anywhere.
    const added = h.gitCalls().filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
    expect(added).toHaveLength(1);
    expect(added[0]?.args.join(' ')).toContain('add-a-cheap-model-seam');
    expect(h.gitCalls().some((call) => call.args.join(' ').includes('branch -m'))).toBe(false);
  });

  it('keeps the heuristic when the answer misses the deadline', async () => {
    const h = harness({
      invoke: (id) =>
        id === 'agents.complete'
          // Later than provisioning is willing to wait. The ask still finishes;
          // its answer is simply not what the branch is called.
          ? new Promise((resolve) =>
              setTimeout(() => resolve({ ok: true, value: { ok: true, text: 'Too Late Entirely' } }), 50),
            )
          : undefined,
      nameDeadlineMs: 5,
    });
    const created = (await h.invoke('tasks.create', {
      title: 'I wanna add a cheap model for naming things',
      brief: 'I wanna add a cheap model for naming things',
      repos: [REPO],
    })) as { id: string };
    await h.settled();
    const stored = h.tasksNow().find((task) => task.id === created.id);
    expect(stored?.slug).not.toBe('too-late-entirely');
  });

  it('does not rename a task that is being restored', async () => {
    // Restore provisions too, and a task with sessions and a history must never
    // have its directory renamed under it.
    const existing = {
      schemaVersion: 1 as const, id: 't1', slug: 'old-name', title: 'Old name', brief: 'a brief long enough to ask about',
      lifecycle: 'archived' as const, repos: [REPO], sessions: [], createdAt: 1, archivedAt: 2, archives: [],
    };
    const h = harness({
      tasks: [existing],
      invoke: (id) =>
        id === 'agents.complete' ? { ok: true as const, value: { ok: true, text: 'A Brand New Name' } } : undefined,
    });
    await h.invoke('tasks.restore', { id: 't1' });
    await h.settled();
    expect(h.tasksNow().find((task) => task.id === 't1')?.slug).toBe('old-name');
  });
});
```

The harness needs three small additions — `settled()` (await the in-flight
provisioning promise), `tasksNow()` (read the KV back), `gitCalls()`, and a
`nameDeadlineMs` option threaded to the code below. Add them in the style of the
existing helpers; if `settled()` already exists under another name, use that.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/src/index.test.ts -t "naming a task at create"
```

Expected: FAIL — `create` rejects the unknown `name` field.

- [ ] **Step 3: Accept `name` in `tasks.create`**

In the `create` schema, add:

```ts
        /**
         * A name the caller already has — the composer's speculative ask, landed
         * before Create was pressed. Absent is normal, and then the heuristic
         * names the task and the race below may improve it.
         */
        name: s.optional(s.string()),
```

In the handler, replace the slug derivation:

```ts
        // The slug is resolved ONCE against what is taken and then stored (D8).
        // What it is derived FROM is now, in order: a name the caller already
        // has, a filler-stripped heuristic, and finally the raw title.
        const named = args.name === undefined ? undefined : readName(args.name);
        const slugSource = named ?? heuristicName(args.brief ?? '') ?? args.title;
        const slug = uniqueSlug(slugify(slugSource), store.takenSlugs());
```

and set the title from the same answer, since one call answers both (D18):

```ts
          title: named ?? args.title,
```

Finally, pass the naming hook to provisioning — and only from here:

```ts
        void provision(task, args.images, named === undefined ? { settle: settleName } : undefined).catch(
          (error: unknown) => {
            ctx.log.error(`task ${task.id}: provisioning threw — ${String(error)}`);
          },
        );
```

- [ ] **Step 4: Implement `settleName` and the overlap**

Add above `runProvision`:

```ts
  /** How long provisioning will wait for a name. Not the ask's own timeout (D20). */
  const NAME_DEADLINE_MS = 4_000;

  /**
   * The slug's one permitted change — before the first git write, and never
   * after (D19).
   *
   * At this moment the record has no sessions, no archives, nothing on disk is
   * named after it and no pane has a cwd inside it. After the first
   * `worktree add`, changing it would mean `git branch -m`, `git worktree move`,
   * moving the task root and re-synthesizing its CLAUDE.md and symlinks, and
   * re-seeding trust — under an agent that is booting. So: once, here, or never.
   *
   * `takenSlugs` is re-checked because a concurrent create may have taken the
   * name in between.
   */
  async function settleName(task: TaskRecord): Promise<TaskRecord> {
    const named = await Promise.race([
      pendingName(task.brief),
      new Promise<undefined>((resolve) => setTimeout(resolve, nameDeadlineMs)),
    ]);
    if (named === undefined) return task;
    const slug = uniqueSlug(slugify(named), store.takenSlugs());
    if (slug === task.slug) return { ...task, title: named };
    const renamed: TaskRecord = { ...task, slug, title: named };
    store.put(renamed);
    changed();
    ctx.log.info(`task ${task.id}: named ${slug} before its first worktree`);
    return renamed;
  }
```

Then change `runProvision`'s signature and its first lines:

```ts
  async function runProvision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    naming?: { settle: (task: TaskRecord) => Promise<TaskRecord> },
  ): Promise<void> {
    /**
     * The refs read starts BEFORE the name is awaited, which is the whole reason
     * `provisionRepo` was split. Probe 2's numbers are why: one fetch is ~2.5s
     * and a `worktree add` is 0.16s, so the model gets the network's time for
     * free and only the last fraction of a second waits for it.
     */
    const first = task.repos[0];
    const prefetched =
      first === undefined ? undefined : readRepoRefs(api.proposed.process, first);

    const named = naming === undefined ? task : await naming.settle(task);
    const root = rootOf(named);
    ...
```

and inside the repo loop, use `named` in place of `task` throughout, and reuse
the prefetched refs for the first repo:

```ts
      const refs = index === 0 && prefetched !== undefined
        ? await prefetched
        : await readRepoRefs(api.proposed.process, repo);
      const outcome = await addWorktree(api.proposed.process, repo, named.slug, `${root}/${repo.name}`, refs);
```

Thread `nameDeadlineMs` in from the harness option (default `NAME_DEADLINE_MS`)
so the deadline case is testable without a real 4s wait.

- [ ] **Step 5: Run the tests**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks
```

Expected: PASS, including every pre-existing test. Watch for a pre-existing test
that asserted a slug derived from a filler-heavy title — if one fails, the
expectation is what changed, and the new value belongs in it.

- [ ] **Step 6: Run the gate**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add extensions/tasks
git commit -m "feat(v2): the model may name a worktree, and may never delay one"
```

---

## Task 10: the composer — ask while typing, and show the name

**Files:**
- Modify: `packages/ui/src/index.ts`
- Modify: `extensions/tasks/ui/composer.tsx`
- Test: `extensions/tasks/ui/composer.test.tsx`

**Interfaces:**
- Consumes: `tasks.suggestName` (Task 8); `name` on `tasks.create` (Task 9).
- Produces: nothing other extensions consume.

- [ ] **Step 1: Write the failing test**

Add to `extensions/tasks/ui/composer.test.tsx`, in the style of the file's
existing render helpers:

```ts
/**
 * The preview exists because the composer currently turns your paragraph into a
 * directory name and tells you afterwards. Adding a model in the middle of that
 * makes it less predictable, not more — unless the name is on screen.
 */
it('shows the name it will use, and swaps in the model’s when it lands', async () => {
  const view = render({
    invoke: async (id: string) =>
      id === 'tasks.suggestName' ? { ok: true, value: { name: 'Add a cheap model seam' } } : { ok: true, value: [] },
  });
  await view.type('composer-brief', 'I wanna add a cheap model for naming tasks');
  // Before any answer: the heuristic, so the line is never empty or a spinner
  // forever.
  expect(view.text('composer-name')).toContain('add-a-cheap-model');
  await view.blur('composer-brief');
  await view.settled();
  expect(view.text('composer-name')).toContain('add-a-cheap-model-seam');
});

it('sends the name it has to create', async () => {
  const sent: unknown[] = [];
  const view = render({
    invoke: async (id: string, args: unknown) => {
      sent.push({ id, args });
      return id === 'tasks.suggestName'
        ? { ok: true, value: { name: 'Add a cheap model seam' } }
        : { ok: true, value: { slug: 'add-a-cheap-model-seam' } };
    },
  });
  await view.type('composer-brief', 'I wanna add a cheap model for naming tasks');
  await view.blur('composer-brief');
  await view.settled();
  await view.click('composer-create');
  const create = sent.find((call) => (call as { id: string }).id === 'tasks.create') as { args: { name?: string } };
  expect(create.args.name).toBe('Add a cheap model seam');
});

it('creates without a name when none has landed', async () => {
  const sent: unknown[] = [];
  const view = render({
    invoke: async (id: string, args: unknown) => {
      sent.push({ id, args });
      // Never answers — the case where Create is pressed first.
      return id === 'tasks.suggestName' ? new Promise(() => {}) : { ok: true, value: { slug: 's' } };
    },
  });
  await view.type('composer-brief', 'I wanna add a cheap model for naming tasks');
  await view.click('composer-create');
  const create = sent.find((call) => (call as { id: string }).id === 'tasks.create') as { args: { name?: string } };
  expect(create.args.name).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks/ui/composer.test.tsx
```

Expected: FAIL — no `composer-name` element.

- [ ] **Step 3: Export the spinner hook**

In `packages/ui/src/index.ts`, extend the existing spinner export:

```ts
export { BRAILLE_FRAMES, SPINNER_TICK_MS, useBrailleFrame } from './spinner.ts';
```

- [ ] **Step 4: Add the ask and the preview to the composer**

Add to the imports:

```ts
import { Button, Composer, Field, PromptField, useBrailleFrame, type PromptFieldHandle } from "@shepherd/ui";
```

Add state beside the existing hooks:

```ts
  /**
   * The name the task will get, and whether an ask is out for a better one.
   *
   * The heuristic is shown immediately so the line is never empty — a preview
   * that appeared only when a model answered would be a spinner most of the time
   * and would teach nobody what the name is.
   */
  const [suggested, setSuggested] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  /** Which name ask is the newest, for the reason `asked` exists for repos. */
  const namingAsk = useRef(0);
  /** The brief the last ask was about, so a pause with no new words asks nothing. */
  const namedFor = useRef("");
```

Add the ask, next to `askForSuggestions`:

```ts
  /**
   * Ask for a name — on a pause and on blur, never per keystroke.
   *
   * Firing on every change would spend the user's model budget several times per
   * task for a question whose answer only matters once. The threshold is on
   * CONTENT rather than on time alone: a pause after twenty more characters is a
   * different brief, a pause after two is the same one.
   */
  const askForName = async (forBrief: string): Promise<void> => {
    const trimmed = forBrief.trim();
    if (trimmed.length < 24) return;
    if (Math.abs(trimmed.length - namedFor.current.length) < 20 && namedFor.current !== "") return;
    namedFor.current = trimmed;
    namingAsk.current += 1;
    const mine = namingAsk.current;
    setNaming(true);
    const answer = await invoke("tasks.suggestName", { brief: forBrief });
    if (mine !== namingAsk.current) return;
    setNaming(false);
    if (!answer.ok) return;
    const value = answer.value as { name?: unknown } | null;
    if (typeof value === "object" && value !== null && typeof value.name === "string") {
      setSuggested(value.name);
    }
  };
```

Wire it to the brief's existing `onBlur` and to an idle timer:

```ts
          onBlur={() => {
            void askForSuggestions(titleOf(brief), brief, path);
            void askForName(brief);
          }}
```

```ts
  // The idle pause. Cleared on every change, so it fires once the typing stops
  // rather than once per keystroke.
  useEffect(() => {
    if (brief.trim() === "") return undefined;
    const timer = setTimeout(() => void askForName(brief), 2_000);
    return () => clearTimeout(timer);
  }, [brief]);
```

Send it to `create`, and render the line. In `create`:

```ts
    const result = await invoke("tasks.create", {
      title: titleOf(brief),
      brief,
      ...(suggested === null ? {} : { name: suggested }),
      ...(pasted.current.length === 0 ? {} : { images: pasted.current }),
      repos: repos.map((repo) => ({ path: repo.path, name: repo.name })),
    });
```

and reset it with the rest on success:

```ts
    setSuggested(null);
    namedFor.current = "";
```

Then, between the `PromptField` and the controls row:

```tsx
        {/*
          What this will be called. Read-only: it shows a consequence the
          composer used to hide, and it is not a second title field — the one
          field stays one field.
        */}
        <output className="sh-composer-name" data-testid="composer-name">
          {naming && suggested === null ? `${frame} naming…` : previewName}
        </output>
```

with, above the return:

```ts
  const frame = useBrailleFrame(naming);
  /**
   * The slug as `tasks.create` will derive it — the same pipeline, so the line
   * cannot promise a name the extension would not produce.
   */
  const previewName = suggested ?? heuristicName(brief) ?? titleOf(brief);
```

Import `heuristicName` from the model — the composer may reach its own
extension's pure modules:

```ts
import { heuristicName } from "../src/model/naming.ts";
```

If `boundaries.js` refuses that import, do **not** widen the rule: move the
preview to a `slug` field on `tasks.suggestName`'s answer and render that
instead. The rule is the architecture.

- [ ] **Step 5: Style the line**

The composer's own rules live in `packages/app/src/renderer/styles.css`, not in
`packages/ui` — `.sh-composer .sh-ext-answer` is at line 971. Add the new rule
beside it, using **role tokens**:

```css
.sh-composer-name {
  font-family: var(--sh-font-mono);
  font-size: var(--sh-font-size-micro);
  color: var(--sh-text-faint);
  /* Reserved, so an answer landing does not shift the Create button. */
  min-height: 1.2em;
}
.sh-composer .sh-composer-name:empty { display: none; }
```

`--sh-text-faint` and not `--sh-wool-faint`, which the adjacent `.sh-ext-answer`
uses: `wool` is a palette hue (`palette.wool` in `design-tokens/src/contrast.ts`)
and the rule is that a component paints in role tokens, never a hue. That
neighbour is pre-existing; do not copy it and do not "fix" it here.

- [ ] **Step 6: Run the tests**

```bash
cd v2 && env -u NODE_OPTIONS pnpm vitest run extensions/tasks
```

Expected: PASS.

- [ ] **Step 7: Run the gate**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/index.ts extensions/tasks/ui
git commit -m "feat(v2): the composer shows what the task will be called"
```

---

## Task 11: a stub kind, and the smoke that proves the wiring

**Files:**
- Modify: `extensions/diagnostics/src/index.ts`, `extensions/diagnostics/src/manifest.ts`, `extensions/diagnostics/package.json`
- Modify: `packages/app/src/main/smoke-m3.ts` (**including the existing assertion at line 78**)
- Test: the smoke itself

**Interfaces:**
- Consumes: `AgentKind.headless` (Task 2); `agents.quickModel` (Task 4); `tasks.create` (Task 9).
- Produces: kind id `diagnostics.stub-agent`.

- [ ] **Step 1: Let `diagnostics` reach the kinds point**

`points.get(id)` **throws** for an owner the caller never declared — that is a
manifest bug reported as one, rather than an `undefined` an author would debug at
the seam. `extensions/diagnostics` currently declares no `dependencies` at all, so
add it, in both manifest copies:

```ts
  dependencies: [AGENTS_CORE_ID],
```

importing `AGENTS_CORE_ID` from `@shepherd/ext-agents-core/manifest`. Mirror it
into `extensions/diagnostics/package.json`'s `shepherd` key, and add
`@shepherd/ext-agents-core` to its `dependencies` in that same `package.json` so
the import resolves.

- [ ] **Step 2: Register a stub kind in `diagnostics`**

`diagnostics` is already dev-gated, which is what makes this safe: it must never
reach a user's app. Add `points` to the `api.proposed` destructure, then in its
`activate`:

```ts
  /**
   * A kind that answers instantly and offline — so the smoke can assert that a
   * model's name reaches a branch without depending on the network, an account,
   * or a ~6s call.
   *
   * Registered here rather than behind a test hook in production code, because
   * `agents.quickModel { kind }` is a real feature (§7c: "the user's configured
   * default") and using it is what proves it works.
   */
  if (ctx.isDev) {
    const agents = points.get<AgentKind>(AGENT_KINDS_POINT);
    agents?.register({
      id: 'diagnostics.stub-agent',
      topics: [],
      reduce: () => ({ kind: 'ignore', why: 'the stub agent tracks nothing' }),
      headless: {
        quickModel: 'stub',
        // `echo` rather than a script: it exists everywhere, needs no file, and
        // the answer arrives wrapped in nothing.
        argv: () => ['echo', 'Stub Named This'],
        parse: (stdout) => stdout.trim(),
      },
    });
  }
```

Add `process.exec` to the diagnostics manifest **only if** its own tests require
it — the kind supplies argv, it does not spawn, so it should not need the grant.
Verify with `pnpm test` rather than assuming.

- [ ] **Step 3: Fix the assertion the feature changes**

`packages/app/src/main/smoke-m3.ts:78` currently reads:

```ts
  check(created.slug === 'smoke-task', `the slug is derived once: ${created.slug}`);
```

With naming wired, that title now settles to the stub's answer. Select the stub
before creating anything, then assert the new truth:

```ts
  // --- 0b. the quick tier is the offline stub, so naming needs no network.
  await invoke('agents.quickModel', { kind: 'diagnostics.stub-agent', model: 'stub' });

  // --- 1. create a task with a real repo, through the real transport.
  const created = (await invoke('tasks.create', {
    title: 'Smoke task',
    brief: 'Provisioned by the m3 smoke, with a brief long enough to be named.',
    repos: [{ path: repo, name: 'api' }],
  })) as { id: string; slug: string };
  /**
   * The MODEL named it, and the name reached the slug before any git ran.
   *
   * This is the assertion no unit test can make: every one of them fakes
   * `ProcessAPI`, so they can only prove that the extension asked and stored the
   * answer. What is asserted here is that the answer travelled through a real
   * command, a real permission check, a real spawn and a real `git worktree add`
   * — and that it did so once, with no rename behind it.
   */
  check(created.slug === 'stub-named-this', `the quick model named the task: ${created.slug}`);
```

- [ ] **Step 4: Assert it on disk, where a rename would show**

After the existing worktree gate (which already waits for `listed.root`), add:

```ts
  const branch = (await status(worktree)).length >= 0
    ? (await gitIn(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    : '';
  check(branch === 'stub-named-this', `the branch carries the model's name: ${branch}`);
  check(listed.root.endsWith('stub-named-this'), `the worktree directory does too: ${listed.root}`);
```

Use whatever git helper the file already has (`status()` at line 537 shows the
pattern — a small `execFile` wrapper); add a `gitIn(cwd, args)` beside it if
there is none, rather than inventing a second style.

- [ ] **Step 5: Run the smoke**

```bash
cd v2 && env -u NODE_OPTIONS pnpm smoke:m3
```

Expected: PASS, with the new lines printing. If the branch is
`smoke-task`, the naming never reached provisioning — check that `tasks.create`
passes `{ settle: settleName }` and that the composer/CLI path being exercised
is the one you changed.

- [ ] **Step 6: Run everything**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test && env -u NODE_OPTIONS pnpm smoke:m3
```

- [ ] **Step 7: Commit**

```bash
git add extensions/diagnostics packages/app/src/main/smoke-m3.ts
git commit -m "test(v2): the smoke proves a model's name reaches the branch, offline"
```

---

## Task 12: the record — ADR 0037 and the docs that carry traps

**Files:**
- Create: `.claude/adr/0037-v2-agents-core-spawns-so-a-kind-does-not.md`
- Modify: `docs/control-cli.md`
- Modify: `CLAUDE.md` (the v2 section)

- [ ] **Step 1: Write ADR 0037**

Follow the shape of `.claude/adr/0036-*.md`. It must record: that `agents-core`
holds `process.exec`; that the alternative was each kind spawning for itself; that
§7c's own argument ("they each do it badly and differently") is what decided it;
and the three rules that confine it (one file, argv from a registered kind, a
caller influences only the prompt). Include the measured latency table — an ADR
that records a decision without its measurement is the kind this repo does not
write.

- [ ] **Step 2: Document the CLI verb**

In `docs/control-cli.md`, beside the other verbs:

```
shepherd agent quick-model                      # which kind and model serve the quick tier
shepherd agent quick-model --model <id>         # override the model
shepherd agent quick-model --kind <id>          # override the kind
shepherd agent quick-model --clear true         # back to the kind's own default
```

- [ ] **Step 3: Add the traps to `CLAUDE.md`**

In the v2 section's list of rules that will bite, add — kept short, because that
file is read at the start of every session:

```markdown
- **`agents-core` holds `process.exec`** (ADR 0037), and the spawn is
  `complete.ts` alone. `ProcessAPI.exec` **replaces** the child's environment
  rather than merging it, so a model call is handed exactly `{ HOME, USER }` —
  and **without `USER` the vendor CLI answers "Not logged in · Please run
  /login"** in two seconds, which looks exactly like a machine nobody signed in
  on. Measured; do not trim that allow-list.
- **A quick-model call is ~6s and that is the floor** (`--safe-mode` already
  strips everything strippable; ~5.5s is network). Nothing user-facing may wait
  on one. Task naming overlaps it with the per-repo `git fetch` and gives up
  after 4s, and **a task's slug may change exactly once, before its first git
  write, and never after** — that invariant is what keeps `git worktree move`
  and a moving task root out of the codebase.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/adr/0037-v2-agents-core-spawns-so-a-kind-does-not.md docs/control-cli.md CLAUDE.md
git commit -m "docs(v2): record why agents-core spawns, and the env that OAuth needs"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the seam (§1 → Tasks 2–4), the
argv (§2 → Task 5), the env allow-list and D25 (§2b → Tasks 1, 3), configuration
(§3 → Task 4), naming (§4 → Tasks 6, 8), the race (§5 → Task 9), the slug's one
change (§6 → Task 9), the late arrival (§7 → Task 9's `settleName` returning a
title), the fallback (§8 → Task 6), the composer preview (§4.2 → Task 10),
testing (→ every task, plus Task 11's smoke), docs (→ Task 12).

**Two things deliberately left to the implementer**, both marked in place: the
exact harness additions in `extensions/tasks/src/index.test.ts` (Task 9 Step 1)
and `composer.test.tsx` (Task 10 Step 1), because those files own their own
fixture style and inventing a second one is worse than matching theirs.

**One decision the implementer may hit and must not paper over**: if
`boundaries.js` refuses the composer's import of `model/naming.ts` (Task 10
Step 4), the fallback is to return the slug from `tasks.suggestName` — not to
widen the rule.
