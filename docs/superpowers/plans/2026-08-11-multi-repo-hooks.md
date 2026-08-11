# Multi-repo (set) hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worktree hook keyed on a **set** of repos, which fires only when all of them are on a task and runs once at the task root — plus parallel repo provisioning.

**Architecture:** `tasks` grows a second, task-level provisioning point (`tasks.taskProvisioned`), awaited once after every repo's worktree and the task root exist. Its fact lists only *ready* checkouts, so "does this set match?" is a plain subset test and every skip rule falls out of it. `worktree-hook` registers a second provider into that point, keyed `hook:set:<sorted paths>`. Separately, the repo loop inside `runProvision` becomes one concurrent chain per repo.

**Tech Stack:** TypeScript, Electron, vitest, pnpm workspaces. Extensions are `v2/extensions/*`; the SDK is `@shepherd/sdk`; UI primitives are `@shepherd/ui`.

**Spec:** [`docs/superpowers/specs/2026-08-10-multi-repo-hooks-design.md`](../specs/2026-08-10-multi-repo-hooks-design.md). Read it before Task 1 — it argues every decision this plan performs.

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before running a line of our code, and the symptom is every check failing at once with no output to explain why.
- **The check loop is** `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.
- **A fresh worktree needs `env -u NODE_OPTIONS pnpm install` before any of that.** There is no `node_modules` in a new worktree, and the first symptom is vitest resolving out of the *primary* checkout's `node_modules` and reporting something unrelated.
- **There is no root vitest workspace**, so there is no `--project` filter: `pnpm test` is `pnpm -r test` and each package runs its own vitest. One package's suite is `env -u NODE_OPTIONS pnpm --filter <pkg> exec vitest run [-t '<name>']`.
- **One extension may TYPE-import another and may never VALUE-import it** (`v2/tooling/eslint/boundaries.js`). Cross-extension ids are local string constants, pinned at compile time by a `typeof` assignment in `manifest.test.ts`.
- **`v2/tooling/eslint/boundaries.js` is the architecture diagram.** Do not widen it in this work; nothing here needs a new import edge.
- **An extension never names a vendor.** No `claude*` identifiers in any file this plan touches.
- **Answers from a command are `unknown`, and a cast is not a check.** Anything the editor reads back from `invoke` is validated defensively, following the `readHooks`/`readPaths`/`readScript` helpers already in `ui/editor.tsx`.
- **`erasableSyntaxOnly` is on.** No constructor parameter properties, no enums — node's type stripping can only erase.
- **Hook execution details are fixed and must not drift:** `/bin/bash -lc <script>` as an argv, `HOOK_TIMEOUT_MS` = `600_000`, output merged and passed through `tail(…, TAIL_LINES)`.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Work happens on the current branch, `support-multi-repo-hooks`. Commit after every task.

---

### Task 1: `tasks` defines the task-level provisioning point

The seam, on the existing serial loop. Parallelism is Task 2 — keeping them apart means a reviewer can reject one without losing the other.

**Files:**
- Modify: `v2/extensions/tasks/src/manifest.ts` (append after the `REPO_PROVISIONED_POINT` block, ~line 84-103)
- Modify: `v2/extensions/tasks/src/index.ts` (imports ~line 13; `hookIssue` ~line 202; point definition ~line 335; `runProvision` ~line 974-1043; `tasks.list` ~line 1176-1188; `rowFor` ~line 1732-1752)
- Test: `v2/extensions/tasks/src/index.test.ts` (new `describe` block after the existing `tasks.repoProvisioned` block, which ends ~line 1738)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `TASK_PROVISIONED_POINT: 'tasks.taskProvisioned'`
  - `interface TaskProvisionedFact { task: { slug: string; root: string }; branch: string; repos: readonly { path: string; name: string; worktree: string }[] }`
  - `type TaskProvisioned = (fact: TaskProvisionedFact) => Promise<{ ok: boolean; message?: string }>`
  - `tasks.list` answers gain a task-level `hookIssue?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `v2/extensions/tasks/src/index.test.ts`. Extend the existing import from `./manifest.ts` (which already imports `REPO_PROVISIONED_POINT` and the `RepoProvisioned` types) to also bring in `TASK_PROVISIONED_POINT` and `type TaskProvisioned, type TaskProvisionedFact`.

```ts
/**
 * `tasks.taskProvisioned` — the second and last provisioning seam.
 *
 * `repoProvisioned` is delivered once per repo and carries nothing about its
 * siblings, so a provider gated on a SET of repos cannot be built on it: it
 * would either fire N times or have to accumulate state across calls and guess
 * which delivery was the last, and nothing in that fact says how many are
 * coming. This one is delivered once for the whole task.
 *
 * `repos` carries only the checkouts that landed AND that no `repoProvisioned`
 * provider complained about. That single definition is the whole skip rule: a
 * repo that failed either step is simply absent from the set it would have
 * matched, so there is no second cascade to reason about.
 */
describe('tasks.taskProvisioned', () => {
  const API = { name: 'api', path: '/src/api' };
  const WEB = { name: 'web', path: '/src/web' };

  it('hands a provider the task, its branch and every ready repo', async () => {
    const h = (live = harness());
    const seen: TaskProvisionedFact[] = [];
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => seen.length > 0);

    expect(seen).toEqual([
      {
        task: { slug: 'fix-login', root: join(h.dataDir, 'fix-login') },
        branch: 'fix-login',
        repos: [
          { path: '/src/api', name: 'api', worktree: join(h.dataDir, 'fix-login', 'api') },
          { path: '/src/web', name: 'web', worktree: join(h.dataDir, 'fix-login', 'web') },
        ],
      },
    ]);
  });

  it('runs ONCE for the task, after the root is written and before any pane opens', async () => {
    // The mirror image of `repoProvisioned`'s ordering test, and deliberately
    // the opposite answer on the first assertion: a set hook works at the task
    // root, so the root has to exist and be finished — materialize replaces
    // stale links, and a hook that ran before it could have its work removed.
    const h = (live = harness());
    let calls = 0;
    let rootAtCallTime: boolean | undefined;
    let panesAtCallTime = 0;
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async () => {
      calls += 1;
      rootAtCallTime = existsSync(join(h.dataDir, 'fix-login', 'CLAUDE.md'));
      panesAtCallTime = h.invoked.filter((call) => call.id === 'layout.openRoot').length;
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => rootAtCallTime !== undefined);

    expect(calls).toBe(1);
    expect(rootAtCallTime).toBe(true);
    expect(panesAtCallTime).toBe(0);
  });

  it('waits for a slow provider rather than racing it', async () => {
    const h = (live = harness());
    let finished = false;
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    expect(finished).toBe(true);
  });

  it('leaves out a repo whose worktree never appeared', async () => {
    const h = (live = harness({
      git: (call) =>
        call.args[0] === 'worktree' && call.args[1] === 'add' && call.opts.cwd === '/src/web'
          ? { ok: false, code: 128, stdout: '', stderr: 'fatal: nope\n' }
          : OK,
    }));
    const seen: TaskProvisionedFact[] = [];
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => seen.length > 0);

    expect(seen[0]?.repos.map((repo) => repo.name)).toEqual(['api']);
  });

  it('leaves out a repo a repoProvisioned provider complained about', async () => {
    // The checkout exists, so it is not a failed repo — but something it needed
    // did not happen, and cross-repo wiring against a half-provisioned checkout
    // produces a second failure caused by the first.
    const h = (live = harness());
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async (fact) =>
      fact.repo.name === 'web' ? { ok: false, message: 'the repo hook failed — exited 3' } : { ok: true },
    );
    const seen: TaskProvisionedFact[] = [];
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => seen.length > 0);

    expect(seen[0]?.repos.map((repo) => repo.name)).toEqual(['api']);
  });

  it('degrades the task rather than failing it, and says so on its row', async () => {
    const warnings: string[] = [];
    const h = (live = harness({ onWarn: (line) => warnings.push(line) }));
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async () => ({
      ok: false,
      message: 'the set hook api + web failed — exited 3\nln: nope',
    }));

    const created = await h.run<{ id: string }>('tasks.create', { title: 'Fix login', repos: [API] });
    // Until the row is no longer BUSY: `whileBusy` wraps the whole of
    // provisioning and overwrites the description with `provisioning…` while it
    // holds, so asserting the description before then reads the spinner.
    await until(async () => (await rowOf(h, created.id))?.busy !== true);

    const listed = await h.run<{ hookIssue?: string }[]>('tasks.list');
    expect(listed[0]?.hookIssue).toBe('the set hook api + web failed — exited 3\nln: nope');
    expect((await rowOf(h, created.id))?.description).toContain('— set hook failed');
    expect(h.invoked.some((call) => call.id === 'layout.openRoot')).toBe(true);
    expect(warnings.some((line) => line.includes('ln: nope'))).toBe(true);
  });

  it('treats a throwing provider as a failure rather than losing the task', async () => {
    const h = (live = harness());
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async () => {
      throw new Error('boom');
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const listed = await h.run<{ hookIssue?: string }[]>('tasks.list');
    expect(listed[0]?.hookIssue).toContain('boom');
  });

  it('runs every provider in registration order and joins their messages', async () => {
    const h = (live = harness());
    const point = h.point<TaskProvisioned>(TASK_PROVISIONED_POINT);
    point.register(async () => ({ ok: false, message: 'first failed' }));
    point.register(async () => ({ ok: false, message: 'second failed' }));

    await h.run('tasks.create', { title: 'Fix login', repos: [API] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const listed = await h.run<{ hookIssue?: string }[]>('tasks.list');
    expect(listed[0]?.hookIssue).toBe('first failed\nsecond failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks exec vitest run -t 'tasks.taskProvisioned'`
Expected: FAIL. The first failures are typecheck/import errors — `TASK_PROVISIONED_POINT` is not exported from `./manifest.ts` — and once that exists, `h.point(...)` throws `no extension point "tasks.taskProvisioned" was defined`.

- [ ] **Step 3: Declare the point in the manifest**

Append to `v2/extensions/tasks/src/manifest.ts`, directly after the `RepoProvisioned` type:

```ts
/**
 * Every worktree this task asked for exists — is anything else needed before it
 * can be worked in?
 *
 * The point above answers that question for ONE repo, in that repo's worktree.
 * This one answers it for the task, once, at the task root — the only directory
 * that holds every checkout, and so the only place wiring that exists *between*
 * two repos can be written.
 *
 * That is why it is a second point rather than a wider `RepoProvisionedFact`,
 * which the comment above forbids. The rule there is against publishing finer
 * STEPS of one repo's provisioning; this publishes a different SUBJECT. And the
 * mechanism leaves no choice: that fact is delivered once per repo, so a
 * provider gated on a repo SET would either fire N times or have to accumulate
 * state across calls and guess which delivery was the last — and nothing in the
 * fact says how many are coming. See ADR 0037.
 *
 * `repos` carries only the checkouts that landed AND that no `repoProvisioned`
 * provider complained about. That one definition is the whole skip rule for
 * anything gated on a set: a repo that failed either step is absent from the set
 * it would have matched, so there is no second cascade rule to get wrong.
 */
export const TASK_PROVISIONED_POINT = 'tasks.taskProvisioned';

export interface TaskProvisionedFact {
  readonly task: { readonly slug: string; readonly root: string };
  /** The task's branch — the same slug every repo's worktree is on. */
  readonly branch: string;
  /** Ready checkouts, in the order the task lists its repos. */
  readonly repos: readonly {
    /** The SOURCE repo, as the user picked it. */
    readonly path: string;
    readonly name: string;
    readonly worktree: string;
  }[];
}

/**
 * `ok: false` DEGRADES the task; it does not fail it. The worktrees are kept,
 * the root is built and agents still spawn — the same trade `RepoProvisioned`
 * makes, for the same reason.
 */
export type TaskProvisioned = (
  fact: TaskProvisionedFact,
) => Promise<{ readonly ok: boolean; readonly message?: string }>;
```

- [ ] **Step 4: Define the point and hold the task-level issue**

In `v2/extensions/tasks/src/index.ts`:

Add to the existing `./manifest.ts` import list:

```ts
  TASK_PROVISIONED_POINT,
  type TaskProvisioned,
```

Beside `const hookIssue = new Map<string, string>();` (~line 202), add:

```ts
/**
 * A task-level provisioning complaint, keyed by task id — `hookIssue`'s
 * sibling, one scope up. Mirrors it deliberately, including not being swept on
 * delete: the two should be wrong or right together, not one each way.
 */
const taskIssue = new Map<string, string>();
```

After the `repoProvisioned` definition (~line 335-338), add:

```ts
/**
 * Registration order, for `repoProvisioned`'s reason: these are side effects on
 * a directory, so "which one wins" is not a question anybody is asking.
 */
const taskProvisioned = points.define<TaskProvisioned>(TASK_PROVISIONED_POINT, {
  order: 'registration',
});
ctx.subscriptions.push(taskProvisioned);
```

- [ ] **Step 5: Await the providers in `runProvision`**

In `runProvision`, add `taskIssue.delete(task.id);` as the first statement after `const root = rootOf(task);`.

Then insert this **after** the existing `ctx.log.info(\`task ${task.id}: ${landed.length}/…\`)` line (~line 1043) and **before** the `seedClaudeTrust` block:

```ts
    /**
     * The second seam: every worktree exists, the root is written, and nothing
     * has opened in any of it yet.
     *
     * After `materializeTaskRoot` rather than before, so the root is finished —
     * a provider can read the generated `CLAUDE.md`, and materialize's
     * stale-link `rmSync` cannot reach in behind it. Awaited for
     * `repoProvisioned`'s reason, one scope up: the orchestrator opens in these
     * directories moments later.
     */
    const ready = landed.filter((repo) => taskIssueFreeRepo(task.id, repo.name));
    const taskComplaints: string[] = [];
    for (const provider of taskProvisioned.all()) {
      try {
        const done = await provider({
          task: { slug: task.slug, root },
          branch: task.slug,
          repos: ready.map((repo) => ({ path: repo.path, name: repo.name, worktree: repo.worktree })),
        });
        if (!done.ok) taskComplaints.push(done.message ?? 'reported a failure with no message');
      } catch (error) {
        // Somebody else's extension must not be able to take a task down.
        taskComplaints.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskComplaints.length > 0) {
      const message = taskComplaints.join('\n');
      taskIssue.set(task.id, message);
      ctx.log.warn(`task ${task.id}: provisioned, but — ${message}`);
      changed();
    }
```

And beside `runProvision` — **inside `activate`**, because it closes over `hookIssue`, which is declared there and not at module scope — the predicate it reads, so the rule has one home:

```ts
  /**
   * Did this repo get through BOTH steps — `worktree add` and every
   * `repoProvisioned` provider?
   *
   * Named rather than inlined because it is the definition
   * `TaskProvisionedFact.repos` documents, and a second spelling of it would be
   * a second answer.
   */
  const taskIssueFreeRepo = (taskId: string, repo: string): boolean =>
    hookIssue.get(`${taskId}:${repo}`) === undefined;
```

- [ ] **Step 6: Surface it on the row and in `tasks.list`**

In the `tasks.list` handler (~line 1176), add the task-level field beside `root`:

```ts
        return store.list().map((task) => ({
          ...task,
          displayState: displayState(task.lifecycle, attentionOf(task)),
          root: rootOf(task),
          /** A task-level provisioning complaint — `repos[].hookIssue` one scope up. */
          hookIssue: taskIssue.get(task.id),
          repos: task.repos.map((repo) => ({
```

In `rowFor` (~line 1732), replace the opening of the returned object so the issue is appended rather than replacing the state:

```ts
          const rowFor = (task: TaskRecord): TreeItemOut => {
            const state = displayState(task.lifecycle, attentionOf(task));
            // Said on the row rather than in a log nobody has open — and
            // APPENDED, because the task really is in the state the tint shows.
            const issue = taskIssue.get(task.id);
            return {
              id: task.id,
              label: task.title,
              description: issue === undefined ? state : `${state} — set hook failed`,
              tint: state,
```

Leave the `busy` spread below exactly as it is: while provisioning holds, `provisioning…` is the truer thing for the row to say.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks exec vitest run`
Expected: PASS, all of them — including the existing `tasks.repoProvisioned` block, which this task must not have changed.

- [ ] **Step 8: Run the full check loop**

Run: `cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add v2/extensions/tasks/src/manifest.ts v2/extensions/tasks/src/index.ts v2/extensions/tasks/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): tasks publishes a second question — every worktree exists

`repoProvisioned` is delivered once per repo and says nothing about its
siblings, so a provider gated on a repo SET cannot be built on it. This one
is delivered once for the task, at the root, after materialize.

`repos` lists only checkouts that landed AND that no repoProvisioned provider
complained about — which is the entire skip rule for anything gated on a set.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Provision repos concurrently

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts` (`runProvision`'s repo loop, ~line 974-1022)
- Test: `v2/extensions/tasks/src/index.test.ts` (fix the order-dependent test ~line 1621; add a new `describe` block)

**Interfaces:**
- Consumes: `TASK_PROVISIONED_POINT`, `TaskProvisioned`, `TaskProvisionedFact` from Task 1.
- Produces: no new API. `landed` keeps its existing shape, `{ name: string; path: string; worktree: string }[]`, and its existing order guarantee is now explicit rather than incidental.

- [ ] **Step 1: Fix the existing test that asserts completion order**

`v2/extensions/tasks/src/index.test.ts`, in the `tasks.repoProvisioned` block, the test `runs once per repo, in its own worktree` currently asserts an exact array. Concurrent chains make provider *call* order nondeterministic, and that ordering was never the claim. Replace its final assertion:

```ts
    // Sorted: the chains run concurrently, so which repo's provider is called
    // first is a race. What this test is about is that each repo gets one call
    // in its OWN worktree — the ordering claim that does matter lives in
    // `provisioning repos concurrently` below, on `landed`.
    expect([...worktrees].sort()).toEqual(
      [join(h.dataDir, 'fix-login', 'api'), join(h.dataDir, 'fix-login', 'web')].sort(),
    );
```

- [ ] **Step 2: Write the failing tests**

Add a new `describe` block after `tasks.taskProvisioned`:

```ts
/**
 * Provisioning repos concurrently.
 *
 * Serially this was probe 2's ~2.5s of network per repo, spent one repo at a
 * time. Two things the serial loop got for free have to be asserted now: a
 * chain owns its failures, and `landed` is read back by INDEX rather than by
 * completion — it feeds `synthTaskRoot`, so a root ordered by whichever git
 * finished first would vary run to run for reasons nobody can see.
 */
describe('provisioning repos concurrently', () => {
  const API = { name: 'api', path: '/src/api' };
  const WEB = { name: 'web', path: '/src/web' };

  it('runs the repos at the same time rather than one after another', async () => {
    // Deterministic, not timing-based: api's chain is HELD open on its fetch,
    // and web's chain has to reach `worktree add` while it is still parked.
    // Serially it never would, and `until` fails.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = (live = harness({
      git: async (call) => {
        if (call.opts.cwd === '/src/api' && call.args[0] === 'fetch') await held;
        return OK;
      },
    }));

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => h.git.some((call) => call.opts.cwd === '/src/web' && call.args[0] === 'worktree'));

    release?.();
  });

  it('lands them in the TASK’s order even when they finish in the other one', async () => {
    // api is the slow one, so completion order is the reverse of the task's.
    // An implementation that appended on completion answers ['web', 'api'].
    const h = (live = harness({
      git: async (call) => {
        if (call.opts.cwd === '/src/api') await new Promise((resolve) => setTimeout(resolve, 20));
        return OK;
      },
    }));
    const seen: TaskProvisionedFact[] = [];
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => seen.length > 0);

    expect(seen[0]?.repos.map((repo) => repo.name)).toEqual(['api', 'web']);
  });

  it('carries that order into the generated CLAUDE.md', async () => {
    // The reason the order matters at all: this file is the only thing loaded at
    // session start, and it is what namespaces a skill collision.
    const h = (live = harness({
      git: async (call) => {
        if (call.opts.cwd === '/src/api') await new Promise((resolve) => setTimeout(resolve, 20));
        return OK;
      },
    }));

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => existsSync(join(h.dataDir, 'fix-login', 'CLAUDE.md')));

    const claudeMd = readFileSync(join(h.dataDir, 'fix-login', 'CLAUDE.md'), 'utf8');
    expect(claudeMd.indexOf('api/')).toBeLessThan(claudeMd.indexOf('web/'));
  });

  it('does not let one repo’s throw abandon its sibling', async () => {
    // A rejection, not a non-zero exit: `Promise.all` over chains that do not
    // catch their own failures abandons every sibling mid-`worktree add`, and a
    // registered worktree whose directory is gone is the state nothing cleans
    // up later.
    const warnings: string[] = [];
    const h = (live = harness({
      onWarn: (line) => warnings.push(line),
      git: (call) =>
        call.opts.cwd === '/src/api' && call.args[0] === 'worktree' && call.args[1] === 'add'
          ? Promise.reject(new Error('spawn EACCES'))
          : OK,
    }));
    const seen: TaskProvisionedFact[] = [];
    h.point<TaskProvisioned>(TASK_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => seen.length > 0);

    expect(seen[0]?.repos.map((repo) => repo.name)).toEqual(['web']);
    expect(warnings.some((line) => line.includes('spawn EACCES'))).toBe(true);
  });

  it('still marks a repo that failed to provision as failed', async () => {
    const h = (live = harness({
      git: (call) =>
        call.args[0] === 'worktree' && call.args[1] === 'add' && call.opts.cwd === '/src/web'
          ? { ok: false, code: 128, stdout: '', stderr: 'fatal: nope\n' }
          : OK,
    }));

    await h.run('tasks.create', { title: 'Fix login', repos: [API, WEB] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const listed = await h.run<{ repos: { name: string; provisioning: string }[] }[]>('tasks.list');
    expect(listed[0]?.repos.find((repo) => repo.name === 'web')?.provisioning).toBe('failed');
    expect(listed[0]?.repos.find((repo) => repo.name === 'api')?.provisioning).toBe('ready');
  });
});
```

Check the file's existing imports from `node:fs` — add `readFileSync` if it is not already there.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks exec vitest run -t 'provisioning repos concurrently'`
Expected: FAIL. `runs the repos at the same time` fails with `the condition never held after 50 ticks` (the serial loop is parked on api's fetch), and `does not let one repo's throw abandon its sibling` fails with an unhandled rejection out of `provisionRepo`.

- [ ] **Step 4: Rewrite the loop as one chain per repo**

In `v2/extensions/tasks/src/index.ts`, replace the whole `for (const repo of task.repos) { … }` block (~line 977-1022) with:

```ts
    /**
     * One chain per repo — `worktree add`, then every `repoProvisioned` provider
     * in that repo's own worktree — and the chains run concurrently.
     *
     * A chain CATCHES ITS OWN failures and answers `undefined`, which is what
     * makes `Promise.all` safe here: a rejecting chain would otherwise abandon
     * its siblings part-way through `worktree add`, and a worktree git has
     * registered but whose directory is gone is the state nothing cleans up
     * later.
     *
     * The results are read back BY INDEX, never by completion. `landed` feeds
     * `synthTaskRoot`, which namespaces skill collisions and writes the repo
     * list into the generated `CLAUDE.md` — ordered by whichever git finished
     * first, the task root would vary run to run and nothing on screen would
     * say why.
     */
    const chains = task.repos.map(async (repo): Promise<LandedRepo | undefined> => {
      const key = `${task.id}:${repo.name}`;
      provisioning.set(key, 'working');
      hookIssue.delete(key);
      try {
        const outcome = await provisionRepo(api.proposed.process, repo, task.slug, `${root}/${repo.name}`);
        if (!outcome.ok) {
          provisioning.set(key, 'failed');
          changed();
          ctx.log.warn(`task ${task.id}: ${repo.name} did not provision — ${outcome.reason}`);
          return undefined;
        }

        provisioning.set(key, 'ready');
        changed();

        /**
         * The seam, here and nowhere else: after the worktree exists, before the
         * root is written and long before a session opens in it. A provider's
         * whole job is to finish a checkout somebody is about to work in, so
         * this is awaited — and its failure is collected rather than raised,
         * because somebody else's extension must not be able to take a task
         * down.
         */
        const complaints: string[] = [];
        for (const provider of repoProvisioned.all()) {
          try {
            const done = await provider({
              repo: { path: repo.path, name: repo.name },
              worktree: outcome.worktree,
              branch: task.slug,
              task: { slug: task.slug, root },
            });
            if (!done.ok) complaints.push(done.message ?? 'reported a failure with no message');
          } catch (error) {
            // A throwing provider is a bug in the provider. It is not a reason
            // to lose a worktree that already exists.
            complaints.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (complaints.length > 0) {
          const message = complaints.join('\n');
          hookIssue.set(key, message);
          ctx.log.warn(`task ${task.id}: ${repo.name} provisioned, but — ${message}`);
          changed();
        }

        return { name: repo.name, path: repo.path, worktree: outcome.worktree };
      } catch (error) {
        // `provisionRepo` reaching git through a transport that rejects. Its
        // siblings are mid-flight; this chain ends and they do not.
        provisioning.set(key, 'failed');
        changed();
        ctx.log.warn(
          `task ${task.id}: ${repo.name} did not provision — ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });

    const landed = (await Promise.all(chains)).filter((entry): entry is LandedRepo => entry !== undefined);
```

Delete the now-unused `const landed: { name: string; path: string; worktree: string }[] = [];` declaration above the loop, and add the named type beside `runProvision`:

```ts
/** A repo whose worktree exists — what the root synthesis and the task seam read. */
interface LandedRepo {
  readonly name: string;
  readonly path: string;
  readonly worktree: string;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks exec vitest run`
Expected: PASS. Watch specifically that `tasks.repoProvisioned` and `pre-trusting the directories it generates` still pass — both read `landed` indirectly.

- [ ] **Step 6: Run the full check loop and the real app gate**

Run: `cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS.

Run: `cd v2 && env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS — `smoke: OK m3`. This is the gate the root `CLAUDE.md` requires for task/layout work, and this task is the exact class of change a unit suite lies about.

- [ ] **Step 7: Commit**

```bash
git add v2/extensions/tasks/src/index.ts v2/extensions/tasks/src/index.test.ts
git commit -m "$(cat <<'EOF'
perf(v2): a task's repos provision at once, not one after another

Probe 2 measured ~2.5s of network per repo, and the loop spent it serially.

Two invariants the serial version got for free are now written down: a chain
catches its own failures, so a rejection cannot abandon a sibling mid-`worktree
add`, and `landed` is read back by index — it feeds the generated CLAUDE.md,
and completion order would vary the task root run to run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `matchSets` — which set hooks a task fires, in what order

**Files:**
- Modify: `v2/extensions/worktree-hook/src/model/plan.ts`
- Modify: `v2/extensions/worktree-hook/src/model/path.ts` (add `repoName`)
- Modify: `v2/extensions/worktree-hook/src/model/index.ts` (exports)
- Test: `v2/extensions/worktree-hook/src/model/plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type HookKind = 'global' | 'repo' | 'set'`
  - `HookRun` gains `readonly paths?: readonly string[]`
  - `interface SetRun extends HookRun { readonly kind: 'set'; readonly paths: readonly string[] }`
  - `interface HookSet { readonly paths: readonly string[]; readonly script: string }`
  - `HookOutcome` gains `readonly scope?: string`
  - `matchSets(sets: readonly HookSet[], ready: readonly string[]): readonly SetRun[]`
  - `repoName(path: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `v2/extensions/worktree-hook/src/model/plan.test.ts`, and add `matchSets` to the import from `./plan.ts`:

```ts
describe('matchSets', () => {
  const set = (paths: readonly string[], script = `echo ${paths.join('+')}`) => ({ paths, script });

  it('matches nothing when there are no sets', () => {
    expect(matchSets([], ['/src/alpha'])).toEqual([]);
  });

  it('fires a set whose every repo is on the task', () => {
    expect(matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha', '/src/beta'])).toEqual([
      { kind: 'set', script: 'echo /src/alpha+/src/beta', paths: ['/src/alpha', '/src/beta'] },
    ]);
  });

  it('is SUBSET, not exact — a third repo does not silence a pair', () => {
    // The whole reason subset was chosen: wiring between two checkouts is still
    // exactly as necessary when a third repo joins the task.
    const runs = matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha', '/src/beta', '/src/gamma']);
    expect(runs).toHaveLength(1);
  });

  it('does not fire a set with a repo the task does not have', () => {
    expect(matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha'])).toEqual([]);
  });

  it('fires every matching set — a task of three repos fires all four subsets', () => {
    const runs = matchSets(
      [
        set(['/src/alpha', '/src/beta']),
        set(['/src/alpha', '/src/gamma']),
        set(['/src/beta', '/src/gamma']),
        set(['/src/alpha', '/src/beta', '/src/gamma']),
      ],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs).toHaveLength(4);
  });

  it('orders by set SIZE first, so the basic wiring runs before what builds on it', () => {
    const runs = matchSets(
      [set(['/src/alpha', '/src/beta', '/src/gamma'], 'three'), set(['/src/alpha', '/src/beta'], 'two')],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs.map((run) => run.script)).toEqual(['two', 'three']);
  });

  it('breaks a size tie by key, so the order is reproducible', () => {
    const runs = matchSets(
      [set(['/src/beta', '/src/gamma'], 'bg'), set(['/src/alpha', '/src/beta'], 'ab')],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs.map((run) => run.script)).toEqual(['ab', 'bg']);
  });

  it('fires a one-repo set — it is not a spelling of the repo hook', () => {
    // Different cwd (the task root), different moment (after every repo), and
    // it runs once rather than per worktree.
    expect(matchSets([set(['/src/alpha'])], ['/src/alpha', '/src/beta'])).toHaveLength(1);
  });

  it('ignores a set with no repos, which would otherwise match everything', () => {
    // The store refuses to write one; this is the second line of defence, and
    // the one that holds for a key written by another build.
    expect(matchSets([set([], 'echo everywhere')], ['/src/alpha'])).toEqual([]);
  });

  it('ignores a whitespace-only script', () => {
    expect(matchSets([set(['/src/alpha'], '  \n ')], ['/src/alpha'])).toEqual([]);
  });

  it('matches nothing when the task has no ready repos at all', () => {
    // Every repo failed to provision. Every set hook is correctly silent.
    expect(matchSets([set(['/src/alpha'])], [])).toEqual([]);
  });
});
```

And extend the existing `describeOutcomes` block with the set wording:

```ts
  it('names WHICH set failed, because "the set hook failed" twice says nothing', () => {
    expect(
      describeOutcomes([{ kind: 'set', ok: false, detail: 'exited 1', scope: 'alpha + beta' }]),
    ).toEqual({ ok: false, message: 'the set hook alpha + beta failed — exited 1' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: FAIL — `matchSets` is not exported from `./plan.ts`.

- [ ] **Step 3: Implement the model**

In `v2/extensions/worktree-hook/src/model/plan.ts`, widen the kind and the run, add the outcome's scope, and add `matchSets`:

```ts
export type HookKind = 'global' | 'repo' | 'set';

export interface HookRun {
  readonly kind: HookKind;
  readonly script: string;
  /** The source repo paths a `set` run matched, in key order. Absent for the rest. */
  readonly paths?: readonly string[];
}

/** A `set` run, which always knows its repos — it was selected by them. */
export interface SetRun extends HookRun {
  readonly kind: 'set';
  readonly paths: readonly string[];
}

/** A stored set hook, as the store hands it over: paths already normalized and sorted. */
export interface HookSet {
  readonly paths: readonly string[];
  readonly script: string;
}

export interface HookOutcome {
  readonly kind: HookKind;
  readonly ok: boolean;
  /** Merged stdout+stderr, already tailed — or the wording for a hook that never ran. */
  readonly detail: string;
  /**
   * WHICH hook of this kind, when there can be several. A task fires as many set
   * hooks as it has matching subsets, and two failures both reading "the set
   * hook failed" name neither of them.
   */
  readonly scope?: string;
}
```

Then, below `planHooks`:

```ts
/**
 * Which set hooks a task fires, and in what order.
 *
 * **Subset, not exact match.** A set hook fires when every repo in it is ready,
 * whatever else is on the task — so wiring written for a pair stays valid when a
 * third repo joins, which an exact match would silently drop.
 *
 * **Size ascending, then key.** Set hooks share one cwd, the task root, so they
 * run sequentially and the order has to be somebody's decision: a smaller set is
 * the more basic wiring that a larger one plausibly builds on, and the key
 * tie-break makes the whole thing reproducible.
 *
 * `ready` is the SOURCE repo paths of the ready checkouts. It is the source path
 * and not the worktree because the source path is what a hook is keyed on — the
 * only stable identity a repo has in v2.
 *
 * A set with no paths is dropped. It would be a subset of every task, i.e. a
 * second global hook; the store refuses to write one and this is the line that
 * holds when a key arrives from another build.
 */
export function matchSets(sets: readonly HookSet[], ready: readonly string[]): readonly SetRun[] {
  const have = new Set(ready);
  const keyOf = (set: HookSet): string => set.paths.join('\n');
  return sets
    .filter(
      (set) =>
        set.paths.length > 0 && set.script.trim() !== '' && set.paths.every((path) => have.has(path)),
    )
    .sort((a, b) => a.paths.length - b.paths.length || keyOf(a).localeCompare(keyOf(b)))
    .map((set) => ({ kind: 'set', script: set.script, paths: set.paths }));
}
```

And in `describeOutcomes`, name the scope:

```ts
  const lines = failed.map(
    (outcome) =>
      `the ${outcome.kind} hook${outcome.scope === undefined ? '' : ` ${outcome.scope}`} failed — ${outcome.detail}`,
  );
```

- [ ] **Step 4: Add `repoName` and export everything**

In `v2/extensions/worktree-hook/src/model/path.ts`, append:

```ts
/**
 * `/Users/x/dev/alpha` → `alpha`.
 *
 * The same basename rule `tasks` uses to name a worktree's directory and the CLI
 * uses to name a picked repo, so a set labelled `alpha + beta` names the two
 * directories that are actually under the task root. A local copy for
 * `expandHome`'s reason: one extension may not value-import another, and this is
 * one line of string handling.
 */
export function repoName(path: string): string {
  return path.split('/').filter((part) => part !== '').pop() ?? path;
}
```

In `v2/extensions/worktree-hook/src/model/index.ts`:

```ts
export { expandHome, repoName } from './path.ts';
export {
  describeOutcomes,
  matchSets,
  planHooks,
  tail,
  TAIL_LINES,
  type HookKind,
  type HookOutcome,
  type HookRun,
  type HookSet,
  type SetRun,
} from './plan.ts';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS, including every pre-existing `planHooks`/`describeOutcomes`/`tail` test — the new optional fields must not change any of their answers.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/worktree-hook/src/model/
git commit -m "$(cat <<'EOF'
feat(v2): matchSets — which repo-set hooks a task fires, in what order

Subset rather than exact match, so wiring written for a pair survives a third
repo joining the task. Size-ascending then by key, because set hooks share one
cwd and the order therefore has to be a decision rather than a coincidence.

An outcome can name WHICH set failed: a task fires as many set hooks as it has
matching subsets, and two messages both reading "the set hook failed" name
neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The store learns set keys

**Files:**
- Modify: `v2/extensions/worktree-hook/src/store.ts`
- Test: `v2/extensions/worktree-hook/src/store.test.ts`

**Interfaces:**
- Consumes: `expandHome` (existing), `HookSet` from Task 3.
- Produces, on `HookStore`:
  - `forSet(paths: readonly string[]): string | undefined`
  - `setForSet(paths: readonly string[], script: string): void` — **throws** on an empty set
  - `listSets(): readonly StoredSet[]` where `StoredSet = { paths: readonly string[]; script: string }`

- [ ] **Step 1: Write the failing tests**

Append to `v2/extensions/worktree-hook/src/store.test.ts`, inside the existing `describe('the hook store', …)`:

```ts
  it('round-trips a set hook, keyed by its repos', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/alpha', '/src/beta'], 'ln -sf alpha/dist beta/vendor');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBe('ln -sf alpha/dist beta/vendor');
  });

  it('treats {a,b} and {b,a} as ONE set', () => {
    // Sorted before the key is built. Two orders of the same repos are one hook,
    // or the editor and the CLI would disagree about what exists.
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/beta', '/src/alpha'], 'echo hi');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBe('echo hi');
  });

  it('expands ~ in every member, so two spellings are one set', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['~/dev/alpha', '/src/beta'], 'echo hi');
    expect(store.forSet(['/Users/x/dev/alpha', '/src/beta'])).toBe('echo hi');
  });

  it('collapses a repeated repo to one member', () => {
    // After expansion, not before — `~/dev/alpha` and `/Users/x/dev/alpha` are
    // the same repo typed twice, and a two-member set of one repo would key
    // differently from the one-member set that means the same thing.
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['~/dev/alpha', '/Users/x/dev/alpha'], 'echo hi');
    expect(store.forSet(['/Users/x/dev/alpha'])).toBe('echo hi');
    expect(store.listSets()).toEqual([{ paths: ['/Users/x/dev/alpha'], script: 'echo hi' }]);
  });

  it('clears a set hook on an empty script', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/alpha', '/src/beta'], 'echo hi');
    store.setForSet(['/src/alpha', '/src/beta'], '  \n ');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBeUndefined();
    expect(store.listSets()).toEqual([]);
  });

  it('refuses a set with no repos', () => {
    // It would be a subset of every task — a second global hook, with a key
    // indistinguishable from the prefix itself.
    const store = createStore(fakeKv(), '/Users/x');
    expect(() => store.setForSet([], 'echo everywhere')).toThrow(/at least one repo/);
  });

  it('answers undefined for a read of no repos rather than throwing', () => {
    // Asymmetric on purpose: a WRITE forms an identity and must be refused, but
    // this read runs inside somebody's provisioning and "there is no hook" is
    // the honest degradation.
    const store = createStore(fakeKv(), '/Users/x');
    expect(store.forSet([])).toBeUndefined();
  });

  it('keeps repo hooks and set hooks in separate namespaces', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('/src/alpha', 'echo repo');
    store.setForSet(['/src/alpha'], 'echo set');
    expect(store.forRepo('/src/alpha')).toBe('echo repo');
    expect(store.forSet(['/src/alpha'])).toBe('echo set');
    expect(store.listRepos()).toEqual([{ path: '/src/alpha', script: 'echo repo' }]);
    expect(store.listSets()).toEqual([{ paths: ['/src/alpha'], script: 'echo set' }]);
  });

  it('lists sets by size then key, and never a repo or the global hook', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo global');
    store.setForRepo('/src/alpha', 'echo repo');
    store.setForSet(['/src/beta', '/src/gamma'], 'bg');
    store.setForSet(['/src/alpha', '/src/beta'], 'ab');
    store.setForSet(['/src/alpha'], 'a');
    expect(store.listSets()).toEqual([
      { paths: ['/src/alpha'], script: 'a' },
      { paths: ['/src/alpha', '/src/beta'], script: 'ab' },
      { paths: ['/src/beta', '/src/gamma'], script: 'bg' },
    ]);
  });

  it('drops a stored set that no longer parses rather than crashing', () => {
    const store = createStore(fakeKv({ 'hook:set:/src/alpha': { script: 42 } }), '/Users/x');
    expect(store.forSet(['/src/alpha'])).toBeUndefined();
    expect(store.listSets()).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run store`
Expected: FAIL — `store.setForSet is not a function`.

- [ ] **Step 3: Implement it**

In `v2/extensions/worktree-hook/src/store.ts`, add the prefix beside the others:

```ts
const GLOBAL_KEY = 'hook:global';
const REPO_PREFIX = 'hook:repo:';
/**
 * A hook for a SET of repos, run once at the task root.
 *
 * `hook:set:` and not `hook:repos:` — the latter is one character away from
 * being caught by `startsWith(REPO_PREFIX)`, and a prefix scheme that survives
 * only by arithmetic is one rename away from `listRepos()` returning set keys.
 *
 * The members are joined by `\n`, which cannot appear in any path a repo picker
 * can produce, so the key round-trips by `split('\n')`.
 */
const SET_PREFIX = 'hook:set:';
const SET_SEPARATOR = '\n';
```

Add the type and the interface members:

```ts
export interface StoredSet {
  readonly paths: readonly string[];
  readonly script: string;
}

export interface HookStore {
  global(): string | undefined;
  setGlobal(script: string): void;
  forRepo(path: string): string | undefined;
  setForRepo(path: string, script: string): void;
  /** Every repo that has a hook, sorted by path. Never includes the global one. */
  listRepos(): readonly StoredHook[];
  /** The script for exactly this set of repos, or `undefined`. */
  forSet(paths: readonly string[]): string | undefined;
  /** Empty script clears. **Throws** on an empty set — see `keyForSet`. */
  setForSet(paths: readonly string[], script: string): void;
  /** Every stored set, by size then key. Never a repo hook or the global one. */
  listSets(): readonly StoredSet[];
}
```

Inside `createStore`, beside `keyFor`:

```ts
  /**
   * The members, expanded, deduped, sorted, joined — in that order.
   *
   * Deduping AFTER expansion is what makes `~/dev/alpha` and
   * `/Users/x/dev/alpha` one member rather than two, and sorting is what makes
   * `{a,b}` and `{b,a}` one hook. Both are identity, not tidiness: this string
   * IS the hook.
   */
  const membersOf = (paths: readonly string[]): readonly string[] =>
    [...new Set(paths.map((path) => expandHome(path.trim(), home)))].sort();

  const keyForSet = (paths: readonly string[]): string => `${SET_PREFIX}${membersOf(paths).join(SET_SEPARATOR)}`;
```

And the three members on the returned object:

```ts
    forSet: (paths) => (paths.length === 0 ? undefined : read(keyForSet(paths))),
    setForSet: (paths, script) => {
      // A write forms the identity, so this one is refused rather than
      // degraded: an empty set is a subset of every task — a second global hook
      // — and its key would be the bare prefix.
      if (membersOf(paths).length === 0) throw new Error('a set hook needs at least one repo');
      write(keyForSet(paths), script);
    },
    listSets: () =>
      kv
        .keys()
        .filter((key) => key.startsWith(SET_PREFIX))
        .map((key) => ({ paths: key.slice(SET_PREFIX.length).split(SET_SEPARATOR), script: read(key) }))
        .filter((set): set is StoredSet => set.script !== undefined)
        .sort(
          (a, b) =>
            a.paths.length - b.paths.length ||
            a.paths.join(SET_SEPARATOR).localeCompare(b.paths.join(SET_SEPARATOR)),
        ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/worktree-hook/src/store.ts v2/extensions/worktree-hook/src/store.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): the hook store keys a set of repos

`hook:set:` + the members expanded, deduped, sorted and newline-joined — in
that order, because the string IS the hook: dedupe after expansion so one repo
typed two ways is one member, sort so {a,b} and {b,a} are one hook.

`hook:set:` rather than `hook:repos:`, which is one character from being caught
by the repo prefix. An empty set is refused on write and answers undefined on
read: a write forms an identity, a read runs inside provisioning.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The runner runs set hooks at the task root

**Files:**
- Modify: `v2/extensions/worktree-hook/src/manifest.ts` (add `TASK_PROVISIONED_POINT_ID`)
- Modify: `v2/extensions/worktree-hook/src/runner.ts`
- Test: `v2/extensions/worktree-hook/src/runner.test.ts`
- Test: `v2/extensions/worktree-hook/src/manifest.test.ts` (pin the new id at compile time)

**Interfaces:**
- Consumes: `SetRun`, `HookOutcome`, `repoName`, `describeOutcomes`, `tail`, `TAIL_LINES` from Task 3; `TaskProvisionedFact` (type-only) from Task 1.
- Produces:
  - `TASK_PROVISIONED_POINT_ID = 'tasks.taskProvisioned'`
  - `setHookEnv(fact: TaskProvisionedFact, worktrees: readonly string[]): Record<string, string>`
  - `runSetHooks(process_: ProcessAPI, input: { sets: readonly SetRun[]; fact: TaskProvisionedFact }): Promise<{ ok: boolean; message?: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `v2/extensions/worktree-hook/src/runner.test.ts`. Extend its imports:

```ts
import type { RepoProvisionedFact, TaskProvisionedFact } from '@shepherd/ext-tasks/manifest';
import { HOOK_TIMEOUT_MS, hookEnv, runHooks, runSetHooks, setHookEnv } from './runner.ts';
import type { SetRun } from './model/index.ts';
```

```ts
const TASK_FACT: TaskProvisionedFact = {
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
  branch: 'fix-thing',
  repos: [
    { path: '/src/alpha', name: 'alpha', worktree: '/tasks/fix-thing/alpha' },
    { path: '/src/beta', name: 'beta', worktree: '/tasks/fix-thing/beta' },
  ],
};

const setRun = (paths: readonly string[], script: string): SetRun => ({ kind: 'set', paths, script });

describe('setHookEnv', () => {
  it('carries the task and the matched worktrees, and NOTHING that names one repo', () => {
    // `WORKTREE_DIR`/`WORKTREE_SRC`/`WORKTREE_NAME`/`REPO_NAME` would each have
    // to name a single repo, and this hook has no single repo. Inherited from
    // whichever path sorted first they would mean something different than they
    // do one scope up, and the failure is a script that runs successfully
    // against the wrong checkout.
    expect(setHookEnv(TASK_FACT, ['/tasks/fix-thing/alpha', '/tasks/fix-thing/beta'])).toEqual({
      TASK_ROOT: '/tasks/fix-thing',
      TASK_SLUG: 'fix-thing',
      WORKTREE_BRANCH: 'fix-thing',
      HOOK_REPOS: '/tasks/fix-thing/alpha\n/tasks/fix-thing/beta',
    });
  });
});

describe('runSetHooks', () => {
  it('spawns nothing when no set matched', async () => {
    const { api, calls } = fakeProcess();
    expect(await runSetHooks(api, { sets: [], fact: TASK_FACT })).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('runs bash -lc at the TASK ROOT, with the set env and the hook timeout', async () => {
    const { api, calls } = fakeProcess();
    await runSetHooks(api, { sets: [setRun(['/src/alpha', '/src/beta'], 'ln -sf a b')], fact: TASK_FACT });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual(['/bin/bash', '-lc', 'ln -sf a b']);
    // The whole point of the scope: the only directory that holds both checkouts.
    expect(calls[0]?.opts.cwd).toBe('/tasks/fix-thing');
    expect(calls[0]?.opts.timeoutMs).toBe(HOOK_TIMEOUT_MS);
    expect(calls[0]?.opts.env).toEqual(
      setHookEnv(TASK_FACT, ['/tasks/fix-thing/alpha', '/tasks/fix-thing/beta']),
    );
  });

  it('gives each set only ITS OWN repos in HOOK_REPOS', async () => {
    const { api, calls } = fakeProcess();
    await runSetHooks(api, { sets: [setRun(['/src/beta'], 'echo b')], fact: TASK_FACT });
    expect(calls[0]?.opts.env?.HOOK_REPOS).toBe('/tasks/fix-thing/beta');
  });

  it('runs the matched sets in the order it was given, one at a time', async () => {
    // They share one cwd, so concurrency here is racing writes to a single
    // directory. `matchSets` decided the order; this preserves it.
    const running: string[] = [];
    const { api } = fakeProcess((call) => {
      running.push(call.cmd[2] ?? '');
      return OK;
    });
    await runSetHooks(api, {
      sets: [setRun(['/src/alpha'], 'first'), setRun(['/src/alpha', '/src/beta'], 'second')],
      fact: TASK_FACT,
    });
    expect(running).toEqual(['first', 'second']);
  });

  it('names which set failed, by the directories under the task root', async () => {
    const { api } = fakeProcess(() => ({ ok: false, code: 3, stdout: '', stderr: 'ln: nope' }));
    const result = await runSetHooks(api, {
      sets: [setRun(['/src/alpha', '/src/beta'], 'ln -sf a b')],
      fact: TASK_FACT,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('the set hook alpha + beta failed');
    expect(result.message).toContain('ln: nope');
  });

  it('keeps running the other sets when one fails — they are siblings, not a chain', async () => {
    // The global→repo skip exists because the second depends on the first. Two
    // unrelated repo sets have no such relationship.
    const { api, calls } = fakeProcess((call) =>
      call.cmd[2] === 'first' ? { ok: false, code: 1, stdout: '', stderr: 'nope' } : OK,
    );
    const result = await runSetHooks(api, {
      sets: [setRun(['/src/alpha'], 'first'), setRun(['/src/beta'], 'second')],
      fact: TASK_FACT,
    });

    expect(calls.map((call) => call.cmd[2])).toEqual(['first', 'second']);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('alpha');
  });

  it('joins the messages when two sets fail', async () => {
    const { api } = fakeProcess(() => ({ ok: false, code: 1, stdout: '', stderr: 'nope' }));
    const result = await runSetHooks(api, {
      sets: [setRun(['/src/alpha'], 'first'), setRun(['/src/beta'], 'second')],
      fact: TASK_FACT,
    });
    expect(result.message?.split('\n').filter((line) => line.startsWith('the set hook'))).toHaveLength(2);
  });

  it('says the timeout out loud when a set hook fails with no output', async () => {
    const { api } = fakeProcess(() => ({ ok: false, code: 143, stdout: '', stderr: '' }));
    const result = await runSetHooks(api, { sets: [setRun(['/src/alpha'], 'sleep 999')], fact: TASK_FACT });
    expect(result.message).toContain('600s');
  });

  it('keeps only the last 20 lines of output', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const { api } = fakeProcess(() => ({ ok: false, code: 1, stdout: long, stderr: '' }));
    const result = await runSetHooks(api, { sets: [setRun(['/src/alpha'], 'noisy')], fact: TASK_FACT });
    expect(result.message).toContain('earlier line(s)');
    expect(result.message).toContain('line 40');
  });

  it('reports a throw from exec as a failure rather than throwing', async () => {
    const api: ProcessAPI = {
      exec: () => Promise.reject(new Error('spawn EACCES')),
      gitRead: () => Promise.resolve(OK),
      gitWrite: () => Promise.resolve(OK),
    };
    const result = await runSetHooks(api, { sets: [setRun(['/src/alpha'], 'anything')], fact: TASK_FACT });
    expect(result).toEqual({ ok: false, message: expect.stringContaining('spawn EACCES') });
  });
});
```

Also append to `v2/extensions/worktree-hook/src/manifest.test.ts`:

```ts
  it('spells the task point id exactly as tasks defines it', () => {
    // Same compensation as the test above, for the second seam: a local constant
    // because one extension may not value-import another, and a compile-time pin
    // so a rename in `tasks` breaks the build rather than going quiet.
    const declaredByTasks: TasksTaskPointId = TASK_PROVISIONED_POINT_ID;
    expect(declaredByTasks).toBe('tasks.taskProvisioned');
  });
```

with, beside the existing `TasksPointId` type alias:

```ts
type TasksTaskPointId = typeof TasksManifest.TASK_PROVISIONED_POINT;
```

and `TASK_PROVISIONED_POINT_ID` added to the `./manifest.ts` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: FAIL — `runSetHooks` and `setHookEnv` are not exported from `./runner.ts`, and `TASK_PROVISIONED_POINT_ID` is not exported from `./manifest.ts`.

- [ ] **Step 3: Add the point id**

In `v2/extensions/worktree-hook/src/manifest.ts`, beside `REPO_PROVISIONED_POINT_ID`:

```ts
/**
 * `tasks.taskProvisioned`, spelled out for `REPO_PROVISIONED_POINT_ID`'s reason
 * and pinned the same way in `manifest.test.ts`.
 */
export const TASK_PROVISIONED_POINT_ID = 'tasks.taskProvisioned';
```

- [ ] **Step 4: Implement the runner half**

In `v2/extensions/worktree-hook/src/runner.ts`, extend the imports:

```ts
import type { RepoProvisionedFact, TaskProvisionedFact } from '@shepherd/ext-tasks/manifest';
import {
  describeOutcomes,
  planHooks,
  repoName,
  tail,
  TAIL_LINES,
  type HookOutcome,
  type SetRun,
} from './model/index.ts';
```

Then append:

```ts
/**
 * The environment a SET hook is handed, on top of the one it inherits.
 *
 * Four names, and the absences are the design: `WORKTREE_DIR`, `WORKTREE_SRC`,
 * `WORKTREE_NAME` and `REPO_NAME` would each have to name a single repo, and
 * this hook has no single repo. A script wanting one checkout says
 * `$TASK_ROOT/alpha` — the worktree's directory name is the repo's name, and a
 * set hook knows its own repos by construction, because it was selected by them.
 *
 * `HOOK_REPOS` exists so a generic loop is writable without hardcoding names:
 * `readarray -t repos <<< "$HOOK_REPOS"`.
 */
export function setHookEnv(fact: TaskProvisionedFact, worktrees: readonly string[]): Record<string, string> {
  return {
    TASK_ROOT: fact.task.root,
    TASK_SLUG: fact.task.slug,
    WORKTREE_BRANCH: fact.branch,
    HOOK_REPOS: worktrees.join('\n'),
  };
}

/**
 * Every matched set hook, at the task root, one at a time.
 *
 * Sequential because they share a cwd: concurrency here is racing writes to a
 * single directory, and there are never many. The order is `matchSets`' — size
 * ascending, then key — and this only preserves it.
 *
 * A failure does not stop the next set. The global→repo skip exists because the
 * second depends on the first; two unrelated repo sets have no such
 * relationship, so each reports independently and the messages join.
 */
export async function runSetHooks(
  process_: ProcessAPI,
  input: {
    readonly sets: readonly SetRun[];
    readonly fact: TaskProvisionedFact;
  },
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  if (input.sets.length === 0) return { ok: true };

  const worktreeOf = new Map(input.fact.repos.map((repo) => [repo.path, repo.worktree]));
  const outcomes: HookOutcome[] = [];

  for (const set of input.sets) {
    // `matchSets` selected these against the same `repos`, so every path
    // resolves; `flatMap` is how that is expressed without an unreachable
    // branch or a silent empty string in the middle of `HOOK_REPOS`.
    const worktrees = set.paths.flatMap((path) => {
      const worktree = worktreeOf.get(path);
      return worktree === undefined ? [] : [worktree];
    });
    // The directories under the task root, which is what a person reading the
    // failure is looking at.
    const scope = set.paths.map((path) => repoName(path)).join(' + ');
    const opts = {
      cwd: input.fact.task.root,
      env: setHookEnv(input.fact, worktrees),
      timeoutMs: HOOK_TIMEOUT_MS,
    };

    try {
      const result = await process_.exec([BASH, '-lc', set.script], opts);
      if (result.ok) {
        outcomes.push({ kind: 'set', ok: true, detail: '', scope });
        continue;
      }

      const merged = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
      outcomes.push({
        kind: 'set',
        ok: false,
        scope,
        detail: tail(
          merged.trim() === ''
            ? `exited ${result.code} with no output (a hook that hangs is killed after ${HOOK_TIMEOUT_MS / 1000}s)`
            : `exited ${result.code}\n${merged}`,
          TAIL_LINES,
        ),
      });
    } catch (error) {
      // A hook that cannot even be launched is still the hook's problem, and it
      // must not become the task's.
      outcomes.push({
        kind: 'set',
        ok: false,
        scope,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return describeOutcomes(outcomes);
}
```

Note `runHooks` above already imports `describeOutcomes`/`planHooks`/`tail`/`TAIL_LINES` from `./model/plan.ts`; switch that import to `./model/index.ts` so both functions read from the one barrel.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/worktree-hook/src/runner.ts v2/extensions/worktree-hook/src/runner.test.ts v2/extensions/worktree-hook/src/manifest.ts v2/extensions/worktree-hook/src/manifest.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): run a set hook at the task root

Four env names, and the four absences are the design: WORKTREE_DIR, _SRC,
_NAME and REPO_NAME would each have to name one repo, and a set hook has none
— inherited from whichever path sorted first they would mean something other
than they do one scope up, and the failure is a script that succeeds against
the wrong checkout.

Sequential, because the sets share a cwd. A failure does not skip the next one:
sets are siblings, and the global→repo skip exists only because the second
depends on the first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The commands take a set

**Files:**
- Modify: `v2/extensions/worktree-hook/src/index.ts` (the four `commands.register` calls, ~line 58-124)
- Test: `v2/extensions/worktree-hook/src/index.test.ts`

**Interfaces:**
- Consumes: `store.forSet`/`setForSet`/`listSets` from Task 4; `setHookEnv`/`runSetHooks` from Task 5.
- Produces:
  - `worktreeHook.get` / `.set` / `.clear` accept `repos?: string[]` beside `repo?: string`. Both present is an error.
  - `.get` answers `{ scope, script, repos, sets }`.
  - `.testRun` accepts `repos?: string[]`; given it, the script runs as a set hook at `at`.

- [ ] **Step 1: Write the failing tests**

Append to `v2/extensions/worktree-hook/src/index.test.ts`, in the `describe('the commands', …)` block or a new one:

```ts
describe('naming a set of repos', () => {
  it('round-trips a set hook and lists it', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/beta'], script: 'ln -sf a b' });

    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repos: ['/src/beta', '/src/alpha'] })).toMatchObject({
      scope: 'alpha + beta',
      script: 'ln -sf a b',
      sets: [{ paths: ['/src/alpha', '/src/beta'], script: 'ln -sf a b' }],
    });
    h.dispose();
  });

  it('fills the whole editor from one call — global, repos AND sets', async () => {
    // One round-trip, for the reason `repos` was always returned: a second call
    // to list what exists is a second chance to draw a stale one.
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { script: 'echo global' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'echo repo' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/beta'], script: 'echo set' });

    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({
      scope: 'global',
      script: 'echo global',
      repos: [{ path: '/src/alpha', script: 'echo repo' }],
      sets: [{ paths: ['/src/alpha', '/src/beta'], script: 'echo set' }],
    });
    h.dispose();
  });

  it('reports clearing a set as clearing, not as saving', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha'], script: 'echo hi' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha'], script: '  ' })).toEqual({
      scope: 'alpha',
      cleared: true,
    });
    expect(await h.run<{ sets: unknown[] }>(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ sets: [] });
    h.dispose();
  });

  it('clears a set through the clear verb', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/beta'], script: 'echo hi' });
    await h.run(WORKTREE_HOOK_COMMANDS.clear, { repos: ['/src/alpha', '/src/beta'] });
    expect(await h.run<{ sets: unknown[] }>(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ sets: [] });
    h.dispose();
  });

  it('refuses a repo AND a set in one call rather than picking one', async () => {
    // Three scopes on two optional fields, so the illegal fourth combination has
    // to be refused here — the schema cannot say it, and a precedence rule for
    // `--repo x --repos y` is a rule nobody would remember.
    const h = harness();
    await expect(
      h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', repos: ['/src/beta'], script: 'echo hi' }),
    ).rejects.toThrow(/not both/);
    h.dispose();
  });

  it('refuses a set with no repos', async () => {
    const h = harness();
    await expect(h.run(WORKTREE_HOOK_COMMANDS.set, { repos: [], script: 'echo hi' })).rejects.toThrow(
      /at least one repo/,
    );
    h.dispose();
  });

  it('keeps a repo hook and a one-repo set apart', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'echo repo' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha'], script: 'echo set' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repo: '/src/alpha' })).toMatchObject({ script: 'echo repo' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repos: ['/src/alpha'] })).toMatchObject({ script: 'echo set' });
    h.dispose();
  });
});

describe('test-run', () => {
  it('runs the script alone, as a repo hook, in the directory named', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.testRun, { script: 'ls', at: '/tmp/throwaway' });
    expect(h.execs[0]?.cmd).toEqual(['/bin/bash', '-lc', 'ls']);
    expect(h.execs[0]?.opts.cwd).toBe('/tmp/throwaway');
    expect(h.execs[0]?.opts.env?.WORKTREE_DIR).toBe('/tmp/throwaway');
    h.dispose();
  });

  it('runs as a SET hook when repos are named, so $TASK_ROOT is not empty', async () => {
    // Without this, a set script tested through the repo path runs with
    // TASK_ROOT unset — `cp "$TASK_ROOT/alpha/.env" .` becomes `cp /alpha/.env .`
    // and the test reports a bug that does not exist.
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.testRun, {
      repos: ['/src/alpha', '/src/beta'],
      script: 'echo "$HOOK_REPOS"',
      at: '/tmp/throwaway',
    });

    expect(h.execs[0]?.opts.cwd).toBe('/tmp/throwaway');
    expect(h.execs[0]?.opts.env).toEqual({
      TASK_ROOT: '/tmp/throwaway',
      TASK_SLUG: 'test-run',
      WORKTREE_BRANCH: 'test-run',
      HOOK_REPOS: '/tmp/throwaway/alpha\n/tmp/throwaway/beta',
    });
    h.dispose();
  });

  it('does not save what it runs', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.testRun, { repos: ['/src/alpha'], script: 'ls', at: '/tmp/throwaway' });
    expect(await h.run<{ sets: unknown[] }>(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ sets: [] });
    h.dispose();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run -t 'naming a set'`
Expected: FAIL — the `set` handler ignores `repos`, so `get` answers no `sets` key.

- [ ] **Step 3: Implement the target resolver and rewrite the four handlers**

In `v2/extensions/worktree-hook/src/index.ts`, replace the `target` schema and the four `commands.register` calls. Extend the imports first:

```ts
import { matchSets, repoName, type SetRun } from './model/index.ts';
import { runHooks, runSetHooks, setHookEnv } from './runner.ts';
```

Then:

```ts
  /**
   * Which hook the caller means — three scopes on two optional fields.
   *
   * Optional fields rather than a `--global`/`--set` switch, for the reason the
   * one-field version already gave: two flags can disagree, and
   * `--global --repo ~/x` has no meaning and would need a rule nobody would
   * remember. The one combination the schema cannot refuse is BOTH, so
   * `targetOf` refuses it.
   */
  const target = s.object({
    repo: s.optional(s.string()),
    repos: s.optional(s.array(s.string())),
  });

  type Target =
    | { readonly kind: 'global' }
    | { readonly kind: 'repo'; readonly path: string }
    | { readonly kind: 'set'; readonly paths: readonly string[] };

  const targetOf = (args: { readonly repo?: string; readonly repos?: readonly string[] }): Target => {
    if (args.repo !== undefined && args.repos !== undefined) {
      throw new Error('name one repo with `repo` or a set with `repos`, not both');
    }
    if (args.repos !== undefined) return { kind: 'set', paths: args.repos };
    if (args.repo !== undefined) return { kind: 'repo', path: args.repo };
    return { kind: 'global' };
  };

  /** How a scope is named back to the caller, and in the editor's rows. */
  const scopeName = (at: Target): string => {
    if (at.kind === 'global') return 'global';
    if (at.kind === 'repo') return at.path;
    return at.paths.map((path) => repoName(path)).join(' + ');
  };

  const scriptAt = (at: Target): string | undefined => {
    if (at.kind === 'global') return store.global();
    if (at.kind === 'repo') return store.forRepo(at.path);
    return store.forSet(at.paths);
  };

  const writeAt = (at: Target, script: string): void => {
    if (at.kind === 'global') store.setGlobal(script);
    else if (at.kind === 'repo') store.setForRepo(at.path, script);
    else store.setForSet(at.paths, script);
  };

  ctx.subscriptions.push(
    commands.register(WORKTREE_HOOK_COMMANDS.get, {
      title: 'Worktree Hook: Show',
      schema: target,
      handler: (args) => {
        const at = targetOf(args);
        return {
          scope: scopeName(at),
          script: scriptAt(at),
          // Always, so ONE call fills the whole editor: the thing it draws is
          // every hook there is, and a second round-trip to list them would be
          // a second chance to show a stale one.
          repos: store.listRepos(),
          sets: store.listSets(),
        };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.set, {
      title: 'Worktree Hook: Set',
      schema: s.object({
        repo: s.optional(s.string()),
        repos: s.optional(s.array(s.string())),
        script: s.string(),
      }),
      handler: (args) => {
        const at = targetOf(args);
        writeAt(at, args.script);
        // Reported, because setting a hook to nothing is how you delete one and
        // the caller should be told that is what just happened.
        return { scope: scopeName(at), cleared: args.script.trim() === '' };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.clear, {
      title: 'Worktree Hook: Clear',
      schema: target,
      handler: (args) => {
        const at = targetOf(args);
        writeAt(at, '');
        return { scope: scopeName(at), cleared: true };
      },
    }),

    /**
     * v1's "Test run" (`spike/seam1/Sources/SettingsView.swift:373-396`).
     *
     * It exists because a hook is otherwise only testable by creating a task,
     * and what it catches — a typo, a path that is not there on this machine —
     * is what you want to find before a worktree exists rather than after.
     *
     * `repos` picks which KIND of hook is being tested. Without it the script
     * runs as a repo hook, which is what it has always done. With it the script
     * runs as a set hook at `at`, because a set script tested as a repo hook
     * runs with `TASK_ROOT` unset — `cp "$TASK_ROOT/alpha/.env" .` becomes
     * `cp /alpha/.env .` and the test reports a bug that does not exist.
     *
     * Either way the script is run ALONE: a test run is about the script in
     * front of you, and quietly running the global one first would make a
     * passing test say nothing about what you typed.
     *
     * The directory is the CALLER's to make and to remove. An extension that
     * created temp directories would acquire a cleanup problem, and `os.tmpdir`
     * is exactly the OS API `boundaries.js` keeps out of here.
     */
    commands.register(WORKTREE_HOOK_COMMANDS.testRun, {
      title: 'Worktree Hook: Test Run',
      schema: s.object({
        repo: s.optional(s.string()),
        repos: s.optional(s.array(s.string())),
        script: s.string(),
        at: s.string(),
      }),
      handler: async (args) => {
        if (args.repos !== undefined) {
          const paths = [...args.repos];
          return runSetHooks(process_, {
            sets: [{ kind: 'set', paths, script: args.script } satisfies SetRun],
            fact: {
              task: { slug: 'test-run', root: args.at },
              branch: 'test-run',
              // The set's own repos, stood up under the directory named —
              // `repoName` is the same basename rule `tasks` uses for a
              // worktree's directory, so `$TASK_ROOT/alpha` resolves the way it
              // would in a real task.
              repos: paths.map((path) => ({
                path,
                name: repoName(path),
                worktree: `${args.at}/${repoName(path)}`,
              })),
            },
          });
        }

        return runHooks(process_, {
          scripts: { repo: args.script },
          fact: {
            repo: { path: args.repo ?? args.at, name: 'test-run' },
            worktree: args.at,
            branch: 'test-run',
            task: { slug: 'test-run', root: args.at },
          },
        });
      },
    }),
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS, including the pre-existing command tests — `get`'s existing answer gains a key and loses none.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/worktree-hook/src/index.ts v2/extensions/worktree-hook/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): the hook commands take a set of repos

Three scopes on two optional fields — neither is global, `repo` is one repo,
`repos` is a set — and the fourth combination is refused in the handler, which
is the one thing the schema cannot say. A precedence rule for both-at-once is a
rule nobody would remember.

test-run gains `repos` so a set script is testable at all: run as a repo hook
it has no TASK_ROOT, so `cp "$TASK_ROOT/alpha/.env" .` becomes `cp /alpha/.env .`
and the test reports a bug that does not exist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Register the provider — set hooks actually run

**Files:**
- Modify: `v2/extensions/worktree-hook/src/index.ts` (the point lookup, ~line 31-49)
- Test: `v2/extensions/worktree-hook/src/index.test.ts` (the `harness` gains the second point; new `describe`)

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4, 5, 6.
- Produces: nothing new. This is the wiring that makes the feature real.

- [ ] **Step 1: Teach the harness about the second point**

In `v2/extensions/worktree-hook/src/index.test.ts`:

Extend the imports with `type TaskProvisioned, type TaskProvisionedFact` from `@shepherd/ext-tasks/manifest` and `TASK_PROVISIONED_POINT_ID` from `./manifest.ts`.

Add the fact fixture beside `FACT`:

```ts
const TASK_FACT: TaskProvisionedFact = {
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
  branch: 'fix-thing',
  repos: [
    { path: '/src/alpha', name: 'alpha', worktree: '/tasks/fix-thing/alpha' },
    { path: '/src/beta', name: 'beta', worktree: '/tasks/fix-thing/beta' },
  ],
};
```

Add to the `Harness` interface:

```ts
  /** The providers registered into the TASK point, as `tasks` would see them. */
  taskProviders(): readonly TaskProvisioned[];
```

In `harness`, define the second point beside the first and return it:

```ts
  const taskPoint =
    opts.withPoint === false
      ? undefined
      : registry.define<TaskProvisioned>(TASK_PROVISIONED_POINT_ID, {
          order: 'registration',
          owner: 'shepherd.tasks',
        });
```

```ts
    taskProviders: () => taskPoint?.all() ?? [],
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('the set-hook provider it registers', () => {
  it('lands exactly one provider in tasks.taskProvisioned', () => {
    const h = harness();
    expect(h.taskProviders()).toHaveLength(1);
    h.dispose();
  });

  it('spawns nothing when no set hook matches this task', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/gamma'], script: 'echo hi' });

    expect(await h.taskProviders()[0]?.(TASK_FACT)).toEqual({ ok: true });
    expect(h.execs).toHaveLength(0);
    h.dispose();
  });

  it('runs a set hook whose repos are all on the task, at the task root', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/beta'], script: 'ln -sf a b' });

    expect(await h.taskProviders()[0]?.(TASK_FACT)).toEqual({ ok: true });
    expect(h.execs[0]?.cmd).toEqual(['/bin/bash', '-lc', 'ln -sf a b']);
    expect(h.execs[0]?.opts.cwd).toBe('/tasks/fix-thing');
    expect(h.execs[0]?.opts.env?.HOOK_REPOS).toBe('/tasks/fix-thing/alpha\n/tasks/fix-thing/beta');
    h.dispose();
  });

  it('runs every matching subset, smallest first', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha', '/src/beta'], script: 'both' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha'], script: 'alpha only' });

    await h.taskProviders()[0]?.(TASK_FACT);
    expect(h.execs.map((call) => call.cmd[2])).toEqual(['alpha only', 'both']);
    h.dispose();
  });

  it('finds a set stored under ~ when the task names expanded paths', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['~/dev/alpha', '~/dev/beta'], script: 'echo hi' });

    await h.taskProviders()[0]?.({
      ...TASK_FACT,
      repos: [
        { path: `${HOME}/dev/alpha`, name: 'alpha', worktree: '/tasks/fix-thing/alpha' },
        { path: `${HOME}/dev/beta`, name: 'beta', worktree: '/tasks/fix-thing/beta' },
      ],
    });
    expect(h.execs.map((call) => call.cmd[2])).toEqual(['echo hi']);
    h.dispose();
  });

  it('reports a failing set hook as a VALUE, never a throw', async () => {
    const h = harness();
    h.reply = () => ({ ok: false, code: 3, stdout: '', stderr: 'ln: nope' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repos: ['/src/alpha'], script: 'ln -sf nope' });

    const result = await h.taskProviders()[0]?.(TASK_FACT);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('the set hook alpha failed');
    h.dispose();
  });

  it('warns and stays up when nothing defines the task point', () => {
    const h = harness({ withPoint: false });
    expect(h.warnings.some((line) => line.includes(TASK_PROVISIONED_POINT_ID))).toBe(true);
    expect(h.viewTypes().has(WORKTREE_HOOK_VIEW)).toBe(true);
    h.dispose();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run -t 'set-hook provider'`
Expected: FAIL — `expect(h.taskProviders()).toHaveLength(1)` gets `0`.

- [ ] **Step 4: Register the provider**

In `v2/extensions/worktree-hook/src/index.ts`, after the existing `repoProvisioned` block, add:

```ts
  /**
   * The second seam: every worktree exists and the root is written, so this is
   * where a hook that wires two checkouts TOGETHER can run.
   *
   * `fact.repos` is already only the ready checkouts, so `matchSets` is the
   * whole gate — a repo that failed to provision, or whose own hook failed, is
   * absent, and every set containing it correctly does not match.
   */
  const taskPoint = points.get<TaskProvisioned>(TASK_PROVISIONED_POINT_ID);
  if (taskPoint === undefined) {
    ctx.log.warn(`nothing defines ${TASK_PROVISIONED_POINT_ID} — set hooks will not run`);
  } else {
    ctx.subscriptions.push(
      taskPoint.register(async (fact: TaskProvisionedFact) =>
        runSetHooks(process_, {
          sets: matchSets(
            store.listSets(),
            fact.repos.map((repo) => repo.path),
          ),
          fact,
        }),
      ),
    );
  }
```

Extend the `./manifest.ts` import with `TASK_PROVISIONED_POINT_ID`, and the `@shepherd/ext-tasks/manifest` type import with `TaskProvisioned, TaskProvisionedFact`.

Finally, widen the closing log line so it says what is configured:

```ts
  ctx.log.info(
    `ready — ${store.listRepos().length} repo hook(s), ${store.listSets().length} set hook(s), ` +
      `global hook ${store.global() === undefined ? 'unset' : 'set'}`,
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS.

- [ ] **Step 6: Run the full check loop**

Run: `cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS. The feature is now end-to-end in the unit suite; Task 11 proves it under a real shell.

- [ ] **Step 7: Commit**

```bash
git add v2/extensions/worktree-hook/src/index.ts v2/extensions/worktree-hook/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): set hooks run — the provider lands in tasks.taskProvisioned

`fact.repos` is already only the ready checkouts, so matchSets is the entire
gate: a repo that failed to provision, or whose own hook failed, is absent, and
every set containing it correctly does not match.

Warns and stays up when nothing defines the point, for the reason the repo
provider does: a hook nobody can run is a degraded feature, and a throwing
activate is a startup failure.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `shepherd worktree-hook … --repos`

**Files:**
- Modify: `v2/packages/cli/src/argv.ts` (~line 49-62, and `parseFlags` ~line 99-131)
- Test: `v2/packages/cli/src/argv.test.ts` (~line 93-118)

**Interfaces:**
- Consumes: the command schemas from Task 6.
- Produces: `--repos` under the `worktree-hook` noun accumulates into `args.repos: string[]`, always an array.

- [ ] **Step 1: Write the failing tests**

Append to the `worktree-hook` describe block in `v2/packages/cli/src/argv.test.ts`:

```ts
  it('accumulates --repos into an array, so a set is a set', () => {
    expect(
      parseArgv([
        'worktree-hook',
        'set',
        '--repos',
        '~/dev/alpha',
        '--repos',
        '~/dev/beta',
        '--script',
        'ln -sf a b',
      ]),
    ).toMatchObject({
      ok: true,
      command: 'worktreeHook.set',
      args: { repos: ['~/dev/alpha', '~/dev/beta'], script: 'ln -sf a b' },
    });
  });

  it('accumulates a SINGLE --repos into a one-element array', () => {
    // The shape of an argument must not depend on how many were given — the same
    // rule that keeps `--repo` a string. A one-repo set is a real scope, and it
    // must not arrive as a bare string that names the repo hook instead.
    expect(parseArgv(['worktree-hook', 'clear', '--repos', '~/dev/alpha'])).toMatchObject({
      ok: true,
      args: { repos: ['~/dev/alpha'] },
    });
  });

  it('leaves --repo a string, so the repo hook is unchanged', () => {
    expect(parseArgv(['worktree-hook', 'get', '--repo', '~/dev/alpha'])).toMatchObject({
      ok: true,
      args: { repo: '~/dev/alpha' },
    });
  });

  it('does not accumulate --repos for a noun that does not declare it', () => {
    // `task new` accumulates `--repo` into `{path, name}` objects; `--repos`
    // there is an ordinary flag and must stay a string rather than silently
    // becoming a second way to name repos.
    expect(parseArgv(['task', 'new', '--title', 'x', '--repos', 'a'])).toMatchObject({
      ok: true,
      args: { repos: 'a' },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/cli exec vitest run`
Expected: FAIL — `args.repos` is the string `'~/dev/beta'` (last flag wins), not an array.

- [ ] **Step 3: Implement it**

In `v2/packages/cli/src/argv.ts`, beside `REPO_REPEATS`:

```ts
/**
 * Flags that ALWAYS accumulate into an array, per noun — even given once.
 *
 * `--repos` names a SET of repos, which is a different scope from `--repo`'s one
 * repo: a set hook runs once at the task root, a repo hook runs in each
 * worktree. Two flags one letter apart is not lovely, and the alternatives are
 * worse: making `--repo` repeat for this noun would change the shape of the
 * existing one-repo call, and a `set-group`/`clear-group`/`get-group` verb
 * triple doubles the verb table for one concept.
 *
 * Always an array, never "an array once it repeats", for the reason the comment
 * on `REPO_REPEATS` gives: the shape of an argument must not depend on how many
 * were given.
 */
const ACCUMULATES: Readonly<Record<string, readonly string[]>> = {
  'worktree-hook': ['repos'],
};
```

Change the call site from `parseFlags(rest, noun === REPO_REPEATS)` to `parseFlags(rest, noun)`, and the function:

```ts
function parseFlags(
  rest: readonly string[],
  noun: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = {};
  const repos: { path: string; name: string }[] = [];
  const accumulates = ACCUMULATES[noun] ?? [];

  for (let i = 0; i < rest.length; i += 1) {
    // … the existing token/name/value parsing is unchanged …

    if (name === REPO_FLAG && noun === REPO_REPEATS) {
      // The name is the basename, which is what the task root calls it and what
      // namespaces a skill collision.
      repos.push({ path: value, name: value.split('/').filter((p) => p !== '').pop() ?? value });
    } else if (accumulates.includes(name)) {
      const seen = args[name];
      args[name] = Array.isArray(seen) ? [...(seen as string[]), value] : [value];
    } else {
      args[name] = value;
    }
  }

  if (repos.length > 0) args.repos = repos;
  return { ok: true, value: args };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/cli exec vitest run`
Expected: PASS, including the existing `worktree-hook set --repo … --script …` test.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/cli/src/argv.ts v2/packages/cli/src/argv.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): shepherd worktree-hook takes --repos, repeatably

`--repo` is one repo and a hook in each worktree; `--repos` is a set and one
hook at the task root. It accumulates even when given once, because the shape
of an argument must not depend on how many were given — the rule that keeps
--repo a string.

Per noun, so `task new --repos` stays an ordinary flag rather than becoming a
second way to name repos.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The editor grows a set section

**Files:**
- Modify: `v2/extensions/worktree-hook/ui/editor.tsx`
- Modify: `v2/extensions/worktree-hook/vitest.config.ts` (include `ui/**/*.test.tsx`)
- Create: `v2/extensions/worktree-hook/ui/editor.test.tsx`

**Interfaces:**
- Consumes: `worktreeHook.get` answering `{ scope, script, repos, sets }` and `worktreeHook.set` accepting `{ repos, script }` from Task 6; `tasks.suggestRepos` (unchanged).
- Produces: nothing other components consume.

- [ ] **Step 1: Let the config see the view's test**

`v2/extensions/worktree-hook/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-worktree-hook',
    // `ui/` is the other half of this package (ADR 0033) and it draws, so it is
    // tested too. node stays the default because the service half is the bulk
    // of it; the view opts into jsdom with a `// @vitest-environment jsdom`
    // docblock — the shape `extensions/tasks` already uses.
    include: ['src/**/*.test.ts', 'ui/**/*.test.tsx'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `v2/extensions/worktree-hook/ui/editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeHookEditor } from './editor.tsx';
import { WORKTREE_HOOK_COMMANDS } from '../src/manifest.ts';

/**
 * The chip field, which is the half a smoke cannot see.
 *
 * A set hook's identity is its repos, so the two claims worth pinning are that
 * the field ACCUMULATES (⏎ adds one and stays, so several are several ⏎s) and
 * that saving sends the whole set rather than whatever is in the input.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const answers = new Map<string, unknown>();
const invoke = vi.fn(async (command: string) => ({ ok: true as const, value: answers.get(command) }));

beforeEach(() => {
  answers.clear();
  answers.set(WORKTREE_HOOK_COMMANDS.get, { scope: 'global', script: '', repos: [], sets: [] });
  answers.set(WORKTREE_HOOK_COMMANDS.set, { scope: 'global', cleared: false });
  answers.set('tasks.suggestRepos', []);
  invoke.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<WorktreeHookEditor invoke={invoke as never} />);
  });
};

const byTestId = (id: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no [data-testid="${id}"]`);
  return found;
};

const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    // React tracks the DOM value it last wrote, so setting `.value` directly is
    // ignored as a no-change. The native setter is how a test writes one.
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const enter = async (input: HTMLInputElement): Promise<void> => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};

describe('the set section', () => {
  it('turns each ⏎ into a chip and keeps the field open for the next one', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;

    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/beta');
    await enter(field);

    expect([...byTestId('worktree-hook-set-picked').querySelectorAll('li')].map((li) => li.dataset.path)).toEqual([
      '~/dev/alpha',
      '~/dev/beta',
    ]);
    expect(field.value).toBe('');
  });

  it('does not add the same repo twice', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/alpha');
    await enter(field);

    expect(byTestId('worktree-hook-set-picked').querySelectorAll('li')).toHaveLength(1);
  });

  it('removes a chip', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);

    await act(async () => {
      byTestId('worktree-hook-set-picked').querySelector('button')?.click();
    });
    expect(byTestId('worktree-hook-set-picked').querySelectorAll('li')).toHaveLength(0);
  });

  it('sends the whole set and the script, not the input', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/beta');
    await enter(field);
    await type(byTestId('worktree-hook-set-script') as HTMLTextAreaElement, 'ln -sf a b');

    await act(async () => {
      byTestId('worktree-hook-save-set').click();
    });

    expect(invoke).toHaveBeenCalledWith(WORKTREE_HOOK_COMMANDS.set, {
      repos: ['~/dev/alpha', '~/dev/beta'],
      script: 'ln -sf a b',
    });
  });

  it('cannot be saved with no repos', async () => {
    await render();
    expect((byTestId('worktree-hook-save-set') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists a stored set by its repo names and loads it back on click', async () => {
    answers.set(WORKTREE_HOOK_COMMANDS.get, {
      scope: 'global',
      script: '',
      repos: [],
      sets: [{ paths: ['/src/alpha', '/src/beta'], script: 'ln -sf a b' }],
    });
    await render();

    const row = byTestId('worktree-hook-set-row');
    expect(row.textContent).toContain('alpha + beta');

    await act(async () => {
      row.click();
    });
    expect([...byTestId('worktree-hook-set-picked').querySelectorAll('li')].map((li) => li.dataset.path)).toEqual([
      '/src/alpha',
      '/src/beta',
    ]);
    expect((byTestId('worktree-hook-set-script') as HTMLTextAreaElement).value).toBe('ln -sf a b');
  });

  it('drops a malformed set rather than taking the overlay down', async () => {
    // A command's answer is `unknown`, and a cast is not a check.
    answers.set(WORKTREE_HOOK_COMMANDS.get, {
      scope: 'global',
      script: '',
      repos: [],
      sets: [{ paths: 'not an array', script: 'x' }, null, { paths: ['/src/alpha'], script: 'ok' }],
    });
    await render();

    expect(host.querySelectorAll('[data-testid="worktree-hook-set-row"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run editor`
Expected: FAIL — `no [data-testid="worktree-hook-set-path"]`.

- [ ] **Step 4: Add the section to the editor**

In `v2/extensions/worktree-hook/ui/editor.tsx`:

Add the reader beside `readHooks`:

```tsx
interface StoredSet {
  readonly paths: readonly string[];
  readonly script: string;
}

/**
 * A set, out of an answer that crossed an IPC boundary. Anything not
 * well-formed is dropped rather than drawn — reading `.length` off whatever
 * arrived is how a malformed answer takes the whole overlay down.
 */
function readSets(value: unknown): readonly StoredSet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { paths, script } = entry as { paths?: unknown; script?: unknown };
    if (!Array.isArray(paths) || paths.length === 0 || typeof script !== 'string') return [];
    if (!paths.every((path: unknown) => typeof path === 'string' && path !== '')) return [];
    return [{ paths: paths as readonly string[], script }];
  });
}

/** `/src/alpha` → `alpha`, so a set reads as the directories under the task root. */
function nameOf(path: string): string {
  return path.split('/').filter((part) => part !== '').pop() ?? path;
}
```

Add state beside the existing hooks. Note `suggestions` is **shared** with the one-repo field above, deliberately: `complete()` is one completion query and both fields draw it through their own `<datalist>`, which the browser only shows for the focused input. Two copies of the same list would be two things to keep in step for no visible gain.

```tsx
  const [sets, setSets] = useState<readonly StoredSet[]>([]);
  const [setPaths, setSetPaths] = useState<readonly string[]>([]);
  const [setPath, setSetPath] = useState('');
  const [setScript, setSetScript] = useState('');
  const setPathId = useId();
  const setScriptId = useId();
  const setListId = useId();
```

In `refresh`, read them back:

```tsx
    setHooks(readHooks((shown.value as { repos?: unknown }).repos));
    setSets(readSets((shown.value as { sets?: unknown }).sets));
```

Add the save and the chip helpers:

```tsx
  const saveSet = async (): Promise<void> => {
    const done = await invoke(WORKTREE_HOOK_COMMANDS.set, { repos: [...setPaths], script: setScript });
    if (!done.ok) {
      setStatus(`${done.error.code}: ${done.error.message}`);
      return;
    }
    const label = setPaths.map((path) => nameOf(path)).join(' + ');
    setStatus(setScript.trim() === '' ? `cleared ${label}` : `saved ${label}`);
    await refresh();
  };

  const addSetPath = (candidate: string): void => {
    const trimmed = candidate.trim();
    // A set is a SET: the same repo twice is one member, and the store would
    // collapse it anyway — showing two chips for one member would be the
    // editor disagreeing with what it just saved.
    if (trimmed === '' || setPaths.includes(trimmed)) return;
    setSetPaths([...setPaths, trimmed]);
    setSetPath('');
    setSuggestions([]);
  };
```

And the section itself, between the `one repo` block and the `hooked repos` list:

```tsx
      <SectionLabel>a set of repos</SectionLabel>
      <label className="sh-ext-label" htmlFor={setPathId}>
        Repos
      </label>
      <Field
        id={setPathId}
        data-testid="worktree-hook-set-path"
        value={setPath}
        list={setListId}
        placeholder="+ repo"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setSetPath(event.target.value);
          void complete(event.target.value);
        }}
        onKeyDown={(event) => {
          // ⏎ adds the repo rather than submitting: a set with the field
          // half-typed is a set with the wrong repos. The composer's gesture,
          // and the one this field's chips are borrowed from.
          if (event.key !== 'Enter') return;
          event.preventDefault();
          addSetPath(setPath);
        }}
      />
      <datalist id={setListId}>
        {suggestions.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>
      {/*
        The composer's own chip list, by class. `sh-composer-picked` lives in the
        renderer's shared stylesheet rather than in `tasks`, which is why this
        borrows the LOOK without borrowing the component — the composer's picker
        is woven into its own path-completion state, one extension may not
        value-import another, and this view's README says to delete it when the
        settings page lands.
      */}
      <ul className="sh-composer-picked" data-testid="worktree-hook-set-picked">
        {setPaths.map((path) => (
          <li key={path} data-path={path} title={path}>
            {nameOf(path)}
            <button
              type="button"
              aria-label={`remove ${nameOf(path)}`}
              title={`remove ${nameOf(path)}`}
              onClick={() => setSetPaths(setPaths.filter((candidate) => candidate !== path))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <label className="sh-ext-label" htmlFor={setScriptId}>
        Runs once at the task root, when all of them are present
      </label>
      <TextArea
        id={setScriptId}
        data-testid="worktree-hook-set-script"
        value={setScript}
        onChange={(event) => setSetScript(event.target.value)}
        minLines={4}
        maxLines={14}
        placeholder='ln -sf "$TASK_ROOT/alpha/dist" "$TASK_ROOT/beta/vendor/alpha"'
      />
      <div className="sh-composer-controls">
        <span className="sh-composer-spacer" />
        <Button
          variant="primary"
          type="button"
          data-testid="worktree-hook-save-set"
          disabled={setPaths.length === 0}
          onClick={() => void saveSet()}
        >
          save set hook
        </Button>
      </div>

      {sets.length > 0 && (
        <>
          <SectionLabel count={sets.length}>hooked sets</SectionLabel>
          <div data-testid="worktree-hook-set-list">
            {sets.map((hook) => (
              <Row
                key={hook.paths.join('\n')}
                data-testid="worktree-hook-set-row"
                // Loads it into the fields above, for the reason the repo rows
                // do: there is one editor, and two would be two places for the
                // same script to disagree about itself.
                onClick={() => {
                  setSetPaths(hook.paths);
                  setSetScript(hook.script);
                  setSetPath('');
                  setSuggestions([]);
                }}
                actions={
                  <Button
                    type="button"
                    data-testid="worktree-hook-set-clear"
                    onClick={(event) => {
                      event.stopPropagation();
                      void invoke(WORKTREE_HOOK_COMMANDS.set, { repos: [...hook.paths], script: '' }).then(
                        () => refresh(),
                      );
                    }}
                  >
                    clear
                  </Button>
                }
              >
                {hook.paths.map((path) => nameOf(path)).join(' + ')}
              </Row>
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook exec vitest run`
Expected: PASS.

- [ ] **Step 6: See it, because a passing jsdom test is not a drawn overlay**

Run: `cd v2 && env -u NODE_OPTIONS pnpm ship --dev`
Then in **Shep Night**: ⌘⇧H, and check by eye that the three sections read as a hierarchy, the chips sit where the mock puts them, and the save button is the only loud thing in its row. Fix spacing here rather than in the test.

- [ ] **Step 7: Run the full check loop and commit**

Run: `cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS.

```bash
git add v2/extensions/worktree-hook/ui/ v2/extensions/worktree-hook/vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(v2): the hook editor takes a set of repos

A third section: ⏎ adds a chip and the field stays open, × removes one, and
saving sends the whole set rather than whatever is in the input.

It borrows the composer's chip LOOK by class — `sh-composer-picked` is in the
renderer's shared stylesheet — and not its component: that picker is woven into
its own path-completion state, one extension may not value-import another, and
this view's README says to delete it when the settings page lands.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The docs, and the ADR the second point owes

**Files:**
- Create: `.claude/adr/0037-v2-a-task-is-a-second-provisioning-subject-not-a-finer-step.md`
- Modify: `v2/extensions/worktree-hook/README.md`
- Modify: `docs/control-cli.md` (the "The worktree hook in v2" section, ~line 93-118)
- Modify: `CLAUDE.md` (the v2 handoff pointer list, so ADR 0037 is named where 0021–0036 are)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write ADR 0037**

Read two existing ADRs first for the house shape (`.claude/adr/0032-v2-tasks-uses-the-same-kv-a-third-party-gets.md` and `0034-…`). Then create `.claude/adr/0037-v2-a-task-is-a-second-provisioning-subject-not-a-finer-step.md` covering:

- **Context.** `tasks/manifest.ts` says of `REPO_PROVISIONED_POINT`: *"It is the ONLY provisioning point… If a later need wants a different moment, widen this fact; do not add `tasks.repoAboutToProvision` beside it."* A hook gated on a set of repos needs a moment that fact cannot express.
- **Decision.** Add `tasks.taskProvisioned`. The rule forbids publishing finer **steps** of one repo's provisioning; this publishes a different **subject**, and it is still a question rather than a step.
- **Why widening cannot work.** `RepoProvisionedFact` is delivered N times. A provider gated on a set would either fire N times or accumulate state across calls and guess which delivery was the last — and nothing in the fact says how many are coming. The guess is what makes it wrong.
- **What keeps the rule's teeth.** `repos` lists only ready checkouts, which is the one definition that makes every skip rule fall out of a subset test — so this point does not need a third one beside it either. The bar for a fourth is the same: a new **subject**, not a new moment.
- **Consequences.** Two seams to keep in step; `worktree-hook` now pins two point ids at compile time in `manifest.test.ts`.

- [ ] **Step 2: Update the extension README**

In `v2/extensions/worktree-hook/README.md`:

Add `hook:set:<sorted source paths>` to the **Where a hook lives** table — *once, at the task root, after every worktree is ready* — with the sorted/deduped/newline-joined key rule and the `hook:set:` vs `hook:repos:` note.

Add a **How a set hook runs** section: cwd is the task root; the four env names; the four deliberately absent ones and why; matching is subset; ordering is size-then-key and sequential; a one-repo set is allowed and is not the repo hook; the empty set is refused.

Add to **How it runs** the sentence the parallelism now requires, because nothing warns about it today:

> The global hook runs **once per worktree, and the worktrees provision
> concurrently** — so a global hook doing machine-wide setup (`mise install`,
> warming a shared cache) can run several copies of itself at once and has to
> guard itself with a lockfile or a sentinel. A per-repo or per-set hook has one
> invocation per task and needs no such guard.

Extend **When a hook fails** with the set case: a non-match is silent on screen and named in the log; a failure puts `<state> — set hook failed` on the **task** row and the message on `tasks.list`'s task-level `hookIssue`; sets are siblings, so one failing does not skip the rest.

Extend **Using it** with the CLI lines from `docs/control-cli.md` below.

In **Not done yet**, remove nothing and add: no dedupe of identical scripts and no "every task, once" scope (the empty set) — both considered and declined; see the spec's *Rejected* section.

- [ ] **Step 3: Update `docs/control-cli.md`**

Retitle the v2 section to cover both scopes and extend its table:

```markdown
| `shepherd worktree-hook get [--repo <path>] [--repos <path> …]` | The script for that repo or that set, or the global one, plus every repo and every set that has a hook. |
| `shepherd worktree-hook set [--repo <path>] [--repos <path> …] --script <sh>` | Set it. An empty script clears. |
| `shepherd worktree-hook clear [--repo <path>] [--repos <path> …]` | Clear it. |
| `shepherd worktree-hook test-run [--repos <path> …] --script <sh> --at <dir>` | Run a script against a directory you nominate, without saving it. With `--repos` it runs as a set hook. |
```

Then a paragraph: `--repo` is one repo and a hook in **each** worktree; `--repos` repeats and names a **set**, whose hook runs **once at the task root** when every one of them is on the task (subset — a third repo does not silence a pair). `--repo` and `--repos` together is an error. Set hooks get `TASK_ROOT` (also the cwd), `TASK_SLUG`, `WORKTREE_BRANCH` and `HOOK_REPOS`, and deliberately none of the `WORKTREE_*`/`REPO_NAME` names, which would each have to name one repo. A failure reads `— set hook failed` on the **task** row.

With the worked example:

```sh
shepherd worktree-hook set \
  --repos ~/Home/dev/alpha --repos ~/Home/dev/beta \
  --script 'ln -sf "$TASK_ROOT/alpha/dist" "$TASK_ROOT/beta/vendor/alpha"'
```

- [ ] **Step 4: Name the ADR in `CLAUDE.md`**

In the numbered v2 pointer list, extend the ADR range to `0021–0037` and add one sentence: **0037** is why a second provisioning point is a different *subject* rather than the finer *step* `tasks/manifest.ts` forbids, and why widening a fact delivered N times cannot answer a question about a set.

- [ ] **Step 5: Verify and commit**

Run: `cd v2 && env -u NODE_OPTIONS pnpm lint`
Expected: PASS (markdown is not linted here, but the run confirms nothing in the tree was touched by accident).

Re-read each edited section once for a claim the code does not support — particularly the env table and the failure wording, which must match `setHookEnv` and `describeOutcomes` exactly.

```bash
git add .claude/adr/0037-v2-a-task-is-a-second-provisioning-subject-not-a-finer-step.md v2/extensions/worktree-hook/README.md docs/control-cli.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(v2): ADR 0037, and the set hook in the README and the CLI reference

tasks/manifest.ts forbids adding a point beside repoProvisioned. 0037 records
why this one is a different SUBJECT rather than the finer STEP that rule is
about, and why widening a fact delivered N times cannot answer a question about
a set.

Also says the thing nothing said before: the global hook runs once per worktree
and the worktrees now provision concurrently, so a global hook doing
machine-wide setup has to guard itself.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `smoke:m3` proves it under a real shell

The part a green unit suite lies about. Every unit test above fakes `ProcessAPI`, so none of them can say a real `/bin/bash` ran at a real task root — and parallel provisioning is exactly the class of change where every test supplies both halves of the ordering it asserts.

**Files:**
- Modify: `v2/tooling/scripts/smoke-m3.mjs` (build a second repo, pass it, assert the new lines)
- Modify: `v2/packages/app/src/main/smoke-m3.ts` (set a set hook, create a two-repo task, assert)

**Interfaces:**
- Consumes: everything. This is the end-to-end gate.
- Produces: a second CLI flag, `--shepherd-m3-repo2`.

- [ ] **Step 1: Build and pass a second repo**

In `v2/tooling/scripts/smoke-m3.mjs`:

The existing `git` helper hardcodes `cwd: repo`, so it has to take a directory before there can be a second repo. Add the second temp dir beside the first (~line 25):

```js
const repo = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-repo-'));
const repo2 = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-repo2-'));
```

Then replace the helper and the setup below it (~line 37-48) with:

```js
// `-c user.*` per command: an unset user.name fails the commit, and gpgsign
// would block it on a passphrase prompt with no UI to answer (v1's lesson).
const gitIn = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.email=smoke@shepherd', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
const git = (...args) => gitIn(repo, ...args);

git('init', '-q', '.');
writeFileSync(join(repo, 'README.md'), 'hello\n');
writeFileSync(join(repo, 'gone.txt'), 'delete me\n');
git('add', '-A');
git('commit', '-qm', 'init');

// A second repo, so the smoke can create a task of TWO repos and assert that one
// set hook ran once in the directory holding both. Only what `worktree add`
// needs: a commit, so the branch it forks has somewhere to start.
gitIn(repo2, 'init', '-q', '.');
writeFileSync(join(repo2, 'README.md'), 'hello from web\n');
gitIn(repo2, 'add', '-A');
gitIn(repo2, 'commit', '-qm', 'init');
```

Add `` `--shepherd-m3-repo2=${repo2}`, `` to the argv list beside `--shepherd-m3-repo` (~line 62), add `rmSync(repo2, { recursive: true, force: true });` to the `finally` teardown beside the first (~line 79), and add this output assertion beside the existing hook one:

```js
check(
  output.includes('ok — both repos provisioned and the set hook ran at the task root'),
  'the set hook ran at the task root, under a real shell',
);
```

- [ ] **Step 2: Extend the in-app smoke**

In `v2/packages/app/src/main/smoke-m3.ts`, after the existing `--shepherd-m3-repo` read:

```ts
  const repo2 = flagValue(process.argv, '--shepherd-m3-repo2');
  if (repo2 === undefined) die('no --shepherd-m3-repo2');
```

After the existing `worktreeHook.set` call, set a set hook over both repos:

```ts
  /**
   * --- 0b. a SET hook over both repos, through the same transport.
   *
   * The unit tests own matching, ordering and failure. What no unit test can say
   * is that a real `/bin/bash` ran at a real task root with both worktrees
   * beside it — every one of them fakes `ProcessAPI`. The script writes a file
   * naming what it found, so the check below cannot pass by accident.
   */
  await invoke('worktreeHook.set', {
    repos: [repo, repo2],
    script: 'echo "$HOOK_REPOS" > WIRED.txt',
  });
```

Then a second task, after the first one's assertions are done:

```ts
  /**
   * --- 2c. two repos, provisioned concurrently, wired by one set hook.
   *
   * The set hook runs AFTER `materializeTaskRoot`, so — unlike the repo hook
   * above — the task-root gate does not already prove it has run and this needs
   * its own wait.
   */
  const pair = (await invoke('tasks.create', {
    title: 'Smoke pair',
    brief: 'Two repos, one set hook.',
    repos: [
      { path: repo, name: 'api' },
      { path: repo2, name: 'web' },
    ],
  })) as { id: string; slug: string };

  const pairListed = (await until(
    'both worktrees and the set hook to land',
    async () => ((await invoke('tasks.list')) as { id: string; root: string }[]).find((t) => t.id === pair.id),
    (task) =>
      task !== undefined &&
      existsSync(join(task.root, 'api', '.git')) &&
      existsSync(join(task.root, 'web', '.git')) &&
      existsSync(join(task.root, 'WIRED.txt')),
  )) as { root: string };

  const wired = readFileSync(join(pairListed.root, 'WIRED.txt'), 'utf8').trim().split('\n');
  check(
    wired.length === 2 && wired[0] === join(pairListed.root, 'api') && wired[1] === join(pairListed.root, 'web'),
    `HOOK_REPOS named both worktrees, in key order: ${wired.join(', ')}`,
  );
  const pairClaudeMd = readFileSync(join(pairListed.root, 'CLAUDE.md'), 'utf8');
  check(
    pairClaudeMd.includes('api/') && pairClaudeMd.includes('web/'),
    'the generated CLAUDE.md carries both repos',
  );
  check(
    pairClaudeMd.indexOf('api/') < pairClaudeMd.indexOf('web/'),
    'the repo map is in the TASK’s order, not whichever git finished first',
  );
  say('ok — both repos provisioned and the set hook ran at the task root');
```

`HOOK_REPOS` is in the **key's** sorted order, which is the source paths sorted — not `task.repos` order. Both temp dirs come from `mkdtempSync` under the same prefix pattern, so if the assertion above ever fails on ordering, sort the two expected worktrees by their **source** path rather than loosening the check.

- [ ] **Step 3: Run it**

Run: `cd v2 && env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS, ending `smoke: OK m3`, with the new `ok — both repos provisioned and the set hook ran at the task root` line in the output.

If it fails, read the failure before changing the assertion: this is the gate, and the two things it is most likely to catch for real are the task root being materialized after the set hook (ordering) and `landed` coming back in completion order (the `CLAUDE.md` check).

- [ ] **Step 4: Run everything one more time**

Run: `cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test && env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/tooling/scripts/smoke-m3.mjs v2/packages/app/src/main/smoke-m3.ts
git commit -m "$(cat <<'EOF'
test(v2): the m3 smoke provisions two repos and wires them with a set hook

Every unit test fakes ProcessAPI, so none can say a real /bin/bash ran at a real
task root with both worktrees beside it. This one does, and it asserts the two
things a green unit suite would lie about: HOOK_REPOS naming both worktrees, and
the generated CLAUDE.md carrying them in the TASK's order rather than whichever
git finished first.

Its own `until` gate, because a set hook runs AFTER materialize — the task-root
wait that proves the repo hook ran does not transfer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage.** §1 the second point → Task 1. §2 ordering in `runProvision` → Task 1 Step 5, pinned by Task 1's ordering test. §3 parallel repos, deterministic `landed`, no fail-fast → Task 2. §4 matching and ordering → Task 3. §5 storage → Task 4. §6 execution and env → Task 5. §7 failure, non-match logging, `taskIssue`, row, `tasks.list` → Task 1 (surfaces) + Task 5 (wording) + Task 7 (the log line). §8 surfaces: commands → Task 6, test-run → Task 6, CLI → Task 8, editor → Task 9. §9 restore needs no work — `tasks.restore` already routes through `provision()`; Task 1's point sits inside `runProvision`, so it is covered by construction and no task adds code for it. §10 Rejected → recorded in Task 10's README edit. §11 testing → distributed, with the smoke as Task 11.

**One deliberate gap.** The spec's non-match `log.info` line lives in the extension, not in `tasks` — `matchSets` returning nothing is silent, so Task 7's provider is where a line would go. It is **not** implemented by any step above and is the one spec requirement this plan does not carry. Add it in Task 7 if it is wanted: the provider knows `store.listSets()` and `fact.repos`, so the sets that did not match are a `filter` away, and `ctx.log.info` is already in scope. It is left out because a task with three repos and a dozen stored sets writes a dozen lines nobody asked for, and the useful subset — "a set that would have matched but for one repo" — is a different, narrower predicate than the spec describes. Decide it at Task 7 rather than discovering it at Task 10.
