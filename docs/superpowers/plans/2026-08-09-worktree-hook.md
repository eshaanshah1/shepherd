# Worktree Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a task provisions a repo's worktree, run a user-supplied bash script inside that worktree before any agent opens in it.

**Architecture:** `tasks` defines one coarse extension point, `tasks.repoProvisioned`, and awaits its providers per repo between `provisionRepo` succeeding and the task root being materialized. A new extension, `shepherd.worktree-hook`, stores a global script and a per-repo-path script in its own KV and registers the provider that runs them. Failure never blocks: the worktree survives, agents spawn, and the message reaches the task tree and the log.

**Tech Stack:** TypeScript (ESM, `.ts` extensions on relative imports), vitest, React 19 for the one view, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-09-worktree-hook-design.md`

## Global Constraints

- Relative imports carry the `.ts` / `.tsx` extension. This is the repo's ESM convention — see any file in `v2/extensions/tasks/src`.
- Extensions import `@shepherd/sdk` and nothing else from the workspace. One extension may **type**-import another (`import type`) and may never value-import it — `tooling/eslint/boundaries.js:434-461`. The point id string is therefore re-declared as a local constant in `worktree-hook`, not imported.
- No `child_process`, no `electron`, no `node-pty` in an extension. Spawning goes through `api.proposed.process`. `node:fs` and `node:path` are allowed.
- No React in an extension's `src/`. UI lives in `<extension>/ui/` and is mounted by the renderer.
- `ExecOptions.timeoutMs` is **required** by the SDK (`v2/packages/sdk/src/api-kernel.ts:117-123`). The hook timeout is `600_000`.
- Every extension's `src/manifest.ts` must equal the `shepherd` key of its own `package.json`, asserted by a `manifest.test.ts`. Copy the shape from `v2/extensions/diagnostics/src/manifest.test.ts`.
- Hook env var names are **unprefixed** and match v1 exactly for the first five: `WORKTREE_DIR`, `WORKTREE_SRC`, `WORKTREE_BRANCH`, `WORKTREE_NAME`, `REPO_NAME`. Then `TASK_SLUG`, `TASK_ROOT`.
- Run everything from `v2/`. Per-package: `pnpm --filter @shepherd/ext-worktree-hook test`, `pnpm --filter @shepherd/ext-worktree-hook typecheck`.

---

## File Structure

**Created — `v2/extensions/worktree-hook/`:**

| File | Responsibility |
|---|---|
| `package.json` | Workspace package `@shepherd/ext-worktree-hook`, four export subpaths (`.`, `./manifest`, `./model`, `./ui`), the `shepherd` manifest key |
| `tsconfig.json` | Copy of diagnostics' — `rootDir: "."`, includes `src/**/*.ts` and `ui/**/*.tsx` |
| `vitest.config.ts` | Copy of diagnostics', named `@shepherd/ext-worktree-hook` |
| `src/manifest.ts` | Id, commands, view id, permissions, dependency on `shepherd.tasks`, and the local copy of the point id |
| `src/manifest.test.ts` | manifest ≡ package.json |
| `src/model/index.ts` | Re-exports the pure layer |
| `src/model/path.ts` | `expandHome` — local copy, because a value import from `tasks` is banned |
| `src/model/plan.ts` | Pure. Which scripts run, in what order; how outcomes become one message |
| `src/model/plan.test.ts` | Table tests for the above |
| `src/store.ts` | KV read/write for `hook:global` and `hook:repo:<path>` |
| `src/store.test.ts` | Round-trip, clearing, `~` normalization |
| `src/runner.ts` | Turns a plan into `process.exec` calls |
| `src/runner.test.ts` | Against a fake `ProcessAPI` |
| `src/index.ts` | `activate`: registers the provider, the four commands, the view |
| `src/index.test.ts` | The provider end to end against fakes |
| `ui/editor.tsx` | The `worktree-hook.editor` component |
| `README.md` | What it is, where the settings page must eventually live |

**Modified:**

| File | Change |
|---|---|
| `v2/extensions/tasks/src/manifest.ts` | Add `REPO_PROVISIONED_POINT` and the `RepoProvisioned` type |
| `v2/extensions/tasks/src/index.ts:271`, `:813-828`, `:991`, `:1444` | Define the point, await it, expose the hook issue |
| `v2/extensions/tasks/src/index.test.ts` | Provider is awaited; a failing provider does not block |
| `v2/packages/app/src/main/index.ts:24`, `:710`, `:725` | Register and activate the new built-in |
| `v2/packages/app/package.json`, `v2/packages/app/tsconfig.json` | Dependency + project reference |
| `v2/packages/app/src/renderer/extension-ui.ts:30` | `'worktree-hook.editor': WorktreeHookEditor` |
| `v2/packages/cli/src/argv.ts:20-40` | The `worktree-hook` noun |
| `v2/packages/cli/src/argv.test.ts` | Parsing tests |
| `docs/control-cli.md` | A v2 section for the new verbs |

---

### Task 1: `tasks` publishes the point and awaits it

**Files:**
- Modify: `v2/extensions/tasks/src/manifest.ts` (append after `REPO_SUGGESTIONS_POINT`)
- Modify: `v2/extensions/tasks/src/index.ts:271-275`, `:813-828`, `:989-993`, `:1440-1448`
- Test: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `REPO_PROVISIONED_POINT = 'tasks.repoProvisioned'` and `type RepoProvisioned` from `@shepherd/ext-tasks/manifest`; a `hookIssue` string on each repo of `tasks.list`.

- [ ] **Step 1: Write the failing test**

Append to `v2/extensions/tasks/src/index.test.ts`, following the harness the existing provisioning tests in that file already use (a fake `ProcessAPI` whose `gitWrite` returns `{ok: true}`, and an `activate` against the test host):

```ts
it('awaits a repoProvisioned provider before the task root is materialized', async () => {
  const seen: { worktree: string; repo: string; branch: string; slug: string }[] = [];
  const point = points.get<RepoProvisioned>(REPO_PROVISIONED_POINT);
  point!.register(async (fact) => {
    seen.push({
      worktree: fact.worktree,
      repo: fact.repo.name,
      branch: fact.branch,
      slug: fact.task.slug,
    });
    return { ok: true };
  });

  await invoke('tasks.create', { title: 'hooked', repos: [{ path: '/src/alpha', name: 'alpha' }] });
  await settled();

  expect(seen).toEqual([
    { worktree: expect.stringMatching(/\/alpha$/), repo: 'alpha', branch: expect.any(String), slug: expect.any(String) },
  ]);
});

it('lets agents spawn when a provider fails, and reports the message on the repo', async () => {
  const point = points.get<RepoProvisioned>(REPO_PROVISIONED_POINT);
  point!.register(async () => ({ ok: false, message: 'hook exited 3\ncp: no such file' }));

  await invoke('tasks.create', { title: 'hooked', repos: [{ path: '/src/alpha', name: 'alpha' }] });
  await settled();

  const listed = await invoke('tasks.list', {});
  const repo = listed.value[0].repos[0];
  expect(repo.provisioning).toBe('ready');
  expect(repo.hookIssue).toBe('hook exited 3\ncp: no such file');
  expect(spawnedSessions()).toHaveLength(1);
});

it('survives a provider that throws', async () => {
  const point = points.get<RepoProvisioned>(REPO_PROVISIONED_POINT);
  point!.register(async () => {
    throw new Error('boom');
  });

  await invoke('tasks.create', { title: 'hooked', repos: [{ path: '/src/alpha', name: 'alpha' }] });
  await settled();

  const listed = await invoke('tasks.list', {});
  expect(listed.value[0].repos[0].hookIssue).toContain('boom');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test -- index.test.ts`
Expected: FAIL — `REPO_PROVISIONED_POINT` is not exported, `points.get(...)` is `undefined`.

- [ ] **Step 3: Declare the point in the manifest module**

Append to `v2/extensions/tasks/src/manifest.ts`:

```ts
/**
 * A worktree exists — is anything else needed to make it usable?
 *
 * The motivating provider copies gitignored files a fresh `worktree add` cannot
 * carry (a `.env`, a vendored directory), which is why this is AWAITED rather
 * than announced on the bus: an agent opens in this checkout moments later, and
 * a fire-and-forget event would race it.
 *
 * It is deliberately the ONLY provisioning point, and it publishes a question
 * rather than a step (see `REPO_SUGGESTIONS_POINT` for the same rule). Providers
 * are handed paths and nothing else, so a provider cannot reach this extension's
 * internals. If a future need wants a different moment, widen this fact — do not
 * add a second point.
 */
export const REPO_PROVISIONED_POINT = 'tasks.repoProvisioned';

export interface RepoProvisionedFact {
  readonly repo: { readonly path: string; readonly name: string };
  /** The worktree that now exists. */
  readonly worktree: string;
  /** The task branch it was created on. */
  readonly branch: string;
  readonly task: { readonly slug: string; readonly root: string };
}

/**
 * `ok: false` degrades the repo, it does not fail the task — the worktree is
 * kept and agents still spawn. `message` is what the tree row and the log say.
 */
export type RepoProvisioned = (
  fact: RepoProvisionedFact,
) => Promise<{ readonly ok: boolean; readonly message?: string }>;
```

- [ ] **Step 4: Define the point and await it**

In `v2/extensions/tasks/src/index.ts`, extend the import on line 10:

```ts
import {
  REPO_PROVISIONED_POINT,
  REPO_SUGGESTIONS_POINT,
  TASK_COMMANDS,
  TASK_VIEWS,
  type RepoProvisioned,
} from './manifest.ts';
```

After the `suggestions` point (line 271-273), add:

```ts
/**
 * Registration order, not priority: these are side effects on a directory, and
 * "which one wins" is not a question — every provider runs.
 */
const repoProvisioned = points.define<RepoProvisioned>(REPO_PROVISIONED_POINT, { order: 'registration' });
ctx.subscriptions.push(repoProvisioned);
```

Beside the `provisioning` map (line 174), add:

```ts
/**
 * A repo that provisioned but whose `repoProvisioned` providers complained.
 * Separate from `provisioning` because the repo IS ready — the worktree is
 * there and an agent is about to open in it — and collapsing the two would
 * either hide the complaint or lie about the state.
 */
const hookIssue = new Map<string, string>();
```

Replace the loop body at lines 816-828 with:

```ts
for (const repo of task.repos) {
  provisioning.set(`${task.id}:${repo.name}`, 'working');
  const outcome = await provisionRepo(api.proposed.process, repo, task.slug, `${root}/${repo.name}`);
  if (outcome.ok) {
    provisioning.set(`${task.id}:${repo.name}`, 'ready');
    hookIssue.delete(`${task.id}:${repo.name}`);
    changed();
    landed.push({ name: repo.name, path: repo.path, worktree: outcome.worktree });

    // Before the root is materialized and long before a session spawns: a
    // provider's whole job is to finish the checkout an agent is about to open.
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
        // A throwing provider is a bug in the provider, not a reason to lose a
        // worktree that already exists.
        complaints.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (complaints.length > 0) {
      const message = complaints.join('\n');
      hookIssue.set(`${task.id}:${repo.name}`, message);
      ctx.log.warn(`task ${task.id}: ${repo.name} provisioned, but — ${message}`);
      changed();
    }
  } else {
    provisioning.set(`${task.id}:${repo.name}`, 'failed');
    hookIssue.delete(`${task.id}:${repo.name}`);
    changed();
    ctx.log.warn(`task ${task.id}: ${repo.name} did not provision — ${outcome.reason}`);
  }
}
```

In `tasks.list` (line 989-993):

```ts
repos: task.repos.map((repo) => ({
  ...repo,
  provisioning: provisioning.get(`${task.id}:${repo.name}`) ?? 'ready',
  hookIssue: hookIssue.get(`${task.id}:${repo.name}`),
})),
```

In the tree's repo rows (line 1440-1447):

```ts
(task?.repos ?? []).map((repo) => {
  const key = `${parent}:${repo.name}`;
  const issue = hookIssue.get(key);
  return {
    id: key,
    label: repo.name,
    description: issue === undefined ? (provisioning.get(key) ?? 'ready') : 'ready — hook failed',
    tint: issue === undefined ? undefined : 'warning',
  };
}),
```

- [ ] **Step 5: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test`
Expected: PASS, including the existing suite.

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks typecheck`
Expected: no output.

If `tint: 'warning'` is rejected, check the token names the renderer accepts (`packages/app/src/renderer` view row rendering) and use the nearest existing one — the tint is cosmetic and must not hold up the task.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/tasks/src/manifest.ts v2/extensions/tasks/src/index.ts v2/extensions/tasks/src/index.test.ts
git commit -m "feat(tasks): publish tasks.repoProvisioned and await it per repo"
```

---

### Task 2: The extension package and its store

**Files:**
- Create: `v2/extensions/worktree-hook/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/manifest.ts`, `src/manifest.test.ts`, `src/model/path.ts`, `src/model/index.ts`, `src/store.ts`, `src/store.test.ts`
- Test: `src/manifest.test.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WORKTREE_HOOK_ID`, `WORKTREE_HOOK_COMMANDS`, `WORKTREE_HOOK_VIEW`, `worktreeHookManifest`, `REPO_PROVISIONED_POINT_ID`; `expandHome(path, home)`; `createStore(kv, home)` returning `{ global(), setGlobal(script), forRepo(path), setForRepo(path, script), listRepos() }` where a hook is `{ path: string; script: string }` and an unset hook is `undefined`.

- [ ] **Step 1: Write the failing tests**

`v2/extensions/worktree-hook/src/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { createStore } from './store.ts';

function fakeKv(): KV {
  const map = new Map<string, unknown>();
  return {
    get: <T,>(key: string, _schema: Schema<T>) => map.get(key) as T | undefined,
    set: (key, value) => void map.set(key, value),
    delete: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

describe('the hook store', () => {
  it('round-trips the global hook', () => {
    const store = createStore(fakeKv(), '/Users/x');
    expect(store.global()).toBeUndefined();
    store.setGlobal('echo hi');
    expect(store.global()).toBe('echo hi');
  });

  it('clears on an empty or whitespace-only script', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo hi');
    store.setGlobal('   \n  ');
    expect(store.global()).toBeUndefined();

    store.setForRepo('/src/alpha', 'echo hi');
    store.setForRepo('/src/alpha', '');
    expect(store.forRepo('/src/alpha')).toBeUndefined();
  });

  it('treats a ~ path and its expansion as one repo', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('~/dev/alpha', 'echo hi');
    expect(store.forRepo('/Users/x/dev/alpha')).toBe('echo hi');
    expect(store.listRepos()).toEqual([{ path: '/Users/x/dev/alpha', script: 'echo hi' }]);
  });

  it('lists repos with hooks, sorted by path, and never the global one', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo global');
    store.setForRepo('/src/beta', 'echo b');
    store.setForRepo('/src/alpha', 'echo a');
    expect(store.listRepos()).toEqual([
      { path: '/src/alpha', script: 'echo a' },
      { path: '/src/beta', script: 'echo b' },
    ]);
  });
});
```

`v2/extensions/worktree-hook/src/manifest.test.ts` — copy `v2/extensions/diagnostics/src/manifest.test.ts` verbatim, then change the import to `./manifest.ts`, the identifiers to `worktreeHookManifest` / `WORKTREE_HOOK_COMMANDS`, drop the diagnostics-specific "does NOT declare attention" case, and add:

```ts
it('declares tasks as a dependency — the point it registers into is theirs', () => {
  expect(worktreeHookManifest.dependencies).toEqual(['shepherd.tasks']);
});

it('declares process.exec, which is the whole feature', () => {
  expect(worktreeHookManifest.permissions).toContain('process.exec');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test`
Expected: FAIL — the package does not exist yet (`No projects matched the filter`). That failure is the signal to write the package; once `package.json` exists, the failure becomes the missing modules.

- [ ] **Step 3: Write the package scaffolding**

`v2/extensions/worktree-hook/package.json`:

```json
{
  "name": "@shepherd/ext-worktree-hook",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "shepherd.worktree-hook — a script you choose, run inside every worktree a task creates for a repo.",
  "//exports": "The same split every extension makes: main imports ./manifest to register, the utility process imports the root, ./model is the pure layer, ./ui is the renderer's half.",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./manifest": { "types": "./src/manifest.ts", "default": "./src/manifest.ts" },
    "./model": { "types": "./src/model/index.ts", "default": "./src/model/index.ts" },
    "./ui": { "types": "./ui/editor.tsx", "default": "./ui/editor.tsx" }
  },
  "//dependencies": "@shepherd/ext-tasks is a TYPE-ONLY dependency — `import type` and nothing else. The runtime relationship is the point id, resolved through `points.get`, and the manifest `dependencies` entry the host gates on.",
  "scripts": { "typecheck": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@shepherd/sdk": "workspace:*",
    "@shepherd/ext-tasks": "workspace:*",
    "@shepherd/ui": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "@types/react": "catalog:",
    "react": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "shepherd": {
    "id": "shepherd.worktree-hook",
    "name": "Worktree Hook",
    "version": "0.1.0",
    "api": "^1.0.0",
    "activation": ["onStartup"],
    "permissions": ["storage", "process.exec", "views"],
    "dependencies": ["shepherd.tasks"],
    "contributes": {
      "commands": [
        { "id": "worktreeHook.get", "title": "Worktree Hook: Show" },
        { "id": "worktreeHook.set", "title": "Worktree Hook: Set" },
        { "id": "worktreeHook.clear", "title": "Worktree Hook: Clear" },
        { "id": "worktreeHook.testRun", "title": "Worktree Hook: Test Run" },
        { "id": "worktreeHook.edit", "title": "Worktree Hook: Edit" }
      ]
    }
  }
}
```

`tsconfig.json` — copy `v2/extensions/diagnostics/tsconfig.json` verbatim, then extend `references` to `[{ "path": "../../packages/sdk" }, { "path": "../tasks" }, { "path": "../../packages/ui" }]`.

`vitest.config.ts` — copy diagnostics', with `name: '@shepherd/ext-worktree-hook'`.

- [ ] **Step 4: Write the manifest module**

`v2/extensions/worktree-hook/src/manifest.ts`:

```ts
import type { Manifest } from '@shepherd/sdk';

export const WORKTREE_HOOK_ID = 'shepherd.worktree-hook';
export const TASKS_ID = 'shepherd.tasks';

/**
 * `tasks.repoProvisioned`, spelled out rather than imported.
 *
 * One extension may type-import another and may not value-import it
 * (`tooling/eslint/boundaries.js`), so the id is a local constant. `RepoProvisioned`
 * IS type-imported from `@shepherd/ext-tasks/manifest`, so the SHAPE cannot
 * drift silently; only this string can, and `points.get` returning `undefined`
 * is the loud failure if it ever does.
 */
export const REPO_PROVISIONED_POINT_ID = 'tasks.repoProvisioned';

export const WORKTREE_HOOK_COMMANDS = {
  get: 'worktreeHook.get',
  set: 'worktreeHook.set',
  clear: 'worktreeHook.clear',
  /** Run a script against a throwaway directory, so it can be checked without creating a task. */
  testRun: 'worktreeHook.testRun',
  edit: 'worktreeHook.edit',
} as const;

export const WORKTREE_HOOK_VIEW = 'worktree-hook.editor';

export const worktreeHookManifest: Manifest = {
  id: WORKTREE_HOOK_ID,
  name: 'Worktree Hook',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `process.exec` is the feature: a hook is a script, and running it is the
   * whole job. `storage` holds the scripts — they are deliberately NOT a config
   * file, so that a hook stays on this machine and never lands in a repo
   * somebody else clones. `views` is the editor, which exists only because v2
   * has no settings surface yet (see README).
   */
  permissions: ['storage', 'process.exec', 'views'],
  dependencies: [TASKS_ID],
  contributes: {
    commands: [
      { id: WORKTREE_HOOK_COMMANDS.get, title: 'Worktree Hook: Show' },
      { id: WORKTREE_HOOK_COMMANDS.set, title: 'Worktree Hook: Set' },
      { id: WORKTREE_HOOK_COMMANDS.clear, title: 'Worktree Hook: Clear' },
      { id: WORKTREE_HOOK_COMMANDS.testRun, title: 'Worktree Hook: Test Run' },
      { id: WORKTREE_HOOK_COMMANDS.edit, title: 'Worktree Hook: Edit' },
    ],
  },
};
```

- [ ] **Step 5: Write `expandHome` and the store**

`v2/extensions/worktree-hook/src/model/path.ts`:

```ts
/**
 * `~/dev/alpha` → `/Users/x/dev/alpha`, the way a shell does it.
 *
 * A local copy of `tasks`' function of the same name, on purpose: one extension
 * may not value-import another, and the alternative — a runtime call through
 * `extensions.get` for four lines of string handling — costs more than the
 * duplication. Only a LEADING `~/` or a bare `~` expands; `~user` is a lookup
 * this cannot do and a `~` mid-path is an ordinary character.
 *
 * It matters here because it is the KEY: the same repo typed two ways must be
 * one hook, not two.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (!path.startsWith('~/')) return path;
  return `${home}${path.slice(1)}`;
}
```

`v2/extensions/worktree-hook/src/model/index.ts`:

```ts
export { expandHome } from './path.ts';
export { planHooks, describeOutcomes, type HookRun, type HookOutcome } from './plan.ts';
```

(`plan.ts` arrives in Task 3. Write this file now with only the `expandHome` line, and add the second line in Task 3 — a re-export of a file that does not exist will not typecheck.)

`v2/extensions/worktree-hook/src/store.ts`:

```ts
import { s, type KV } from '@shepherd/sdk';
import { expandHome } from './model/path.ts';

/**
 * Where a hook lives: this extension's KV, and nowhere else.
 *
 * Not a config file, deliberately. A hook is personal — it copies THIS
 * machine's `.env` and symlinks THIS machine's caches — so it is reachable only
 * through the app and the Shepherd CLI, and cannot be committed by accident.
 *
 * The repo path is the key because it is the only stable identity a repo has in
 * v2: there is no repo registry, just the `{path, name}` a user picks per task.
 */
const GLOBAL_KEY = 'hook:global';
const REPO_PREFIX = 'hook:repo:';

const hookSchema = s.object({ script: s.string() });

export interface StoredHook {
  readonly path: string;
  readonly script: string;
}

export interface HookStore {
  global(): string | undefined;
  setGlobal(script: string): void;
  forRepo(path: string): string | undefined;
  setForRepo(path: string, script: string): void;
  listRepos(): readonly StoredHook[];
}

export function createStore(kv: KV, home: string): HookStore {
  const keyFor = (path: string): string => `${REPO_PREFIX}${expandHome(path.trim(), home)}`;

  // Empty clears, matching v1's `setWorktreeHook`. A stored empty string would
  // be a hook that runs `/bin/bash -lc ''` on every worktree — a no-op that
  // still costs a process and still shows as configured.
  const write = (key: string, script: string): void => {
    const trimmed = script.trim();
    if (trimmed === '') kv.delete(key);
    else kv.set(key, { script: trimmed });
  };

  return {
    global: () => kv.get(GLOBAL_KEY, hookSchema)?.script,
    setGlobal: (script) => write(GLOBAL_KEY, script),
    forRepo: (path) => kv.get(keyFor(path), hookSchema)?.script,
    setForRepo: (path, script) => write(keyFor(path), script),
    listRepos: () =>
      kv
        .keys()
        .filter((key) => key.startsWith(REPO_PREFIX))
        .map((key) => ({ path: key.slice(REPO_PREFIX.length), script: kv.get(key, hookSchema)?.script ?? '' }))
        .filter((hook) => hook.script !== '')
        .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
```

- [ ] **Step 6: Wire the package into the workspace**

The workspace globs `extensions/*` already (check `v2/pnpm-workspace.yaml`; if it lists packages individually, add this one).

Run: `cd v2 && pnpm install`

- [ ] **Step 7: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test`
Expected: PASS — store and manifest suites.

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook typecheck`
Expected: no output. (`src/index.ts` and `ui/editor.tsx` do not exist yet; the `exports` map pointing at them is not a typecheck error, but if `tsc -b` complains, create both as one-line stubs and fill them in Tasks 5 and 7.)

- [ ] **Step 8: Commit**

```bash
git add v2/extensions/worktree-hook v2/pnpm-lock.yaml v2/pnpm-workspace.yaml
git commit -m "feat(worktree-hook): the package, its manifest, and the hook store"
```

---

### Task 3: The pure planner

**Files:**
- Create: `v2/extensions/worktree-hook/src/model/plan.ts`
- Modify: `v2/extensions/worktree-hook/src/model/index.ts`
- Test: `v2/extensions/worktree-hook/src/model/plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `planHooks({ global, repo })` → `readonly HookRun[]` where `HookRun = { kind: 'global' | 'repo'; script: string }`; `describeOutcomes(outcomes)` → `{ ok: boolean; message?: string }` where `HookOutcome = { kind: 'global' | 'repo'; ok: boolean; detail: string }`; `TAIL_LINES = 20`; `tail(text, lines)`.

- [ ] **Step 1: Write the failing test**

`v2/extensions/worktree-hook/src/model/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeOutcomes, planHooks, tail } from './plan.ts';

describe('planHooks', () => {
  it('runs nothing when neither is set', () => {
    expect(planHooks({})).toEqual([]);
  });

  it('runs the global hook first, then the repo hook', () => {
    expect(planHooks({ global: 'echo g', repo: 'echo r' })).toEqual([
      { kind: 'global', script: 'echo g' },
      { kind: 'repo', script: 'echo r' },
    ]);
  });

  it('runs just one when just one is set', () => {
    expect(planHooks({ global: 'echo g' })).toEqual([{ kind: 'global', script: 'echo g' }]);
    expect(planHooks({ repo: 'echo r' })).toEqual([{ kind: 'repo', script: 'echo r' }]);
  });
});

describe('describeOutcomes', () => {
  it('is ok when nothing ran', () => {
    expect(describeOutcomes([])).toEqual({ ok: true });
  });

  it('is ok when everything succeeded', () => {
    expect(
      describeOutcomes([
        { kind: 'global', ok: true, detail: '' },
        { kind: 'repo', ok: true, detail: '' },
      ]),
    ).toEqual({ ok: true });
  });

  it('names which hook failed and carries its output', () => {
    expect(
      describeOutcomes([{ kind: 'repo', ok: false, detail: 'exited 3\ncp: no such file' }]),
    ).toEqual({ ok: false, message: 'the repo hook failed — exited 3\ncp: no such file' });
  });

  it('says the repo hook was skipped when the global one failed', () => {
    expect(
      describeOutcomes([{ kind: 'global', ok: false, detail: 'exited 1' }], { skippedRepoHook: true }),
    ).toEqual({
      ok: false,
      message: 'the global hook failed — exited 1\nthe repo hook was skipped because the global hook failed',
    });
  });
});

describe('tail', () => {
  it('keeps the last N lines and says how many it dropped', () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
    const kept = tail(text, 20);
    expect(kept.split('\n')[0]).toBe('… 5 earlier line(s)');
    expect(kept.endsWith('line 25')).toBe(true);
    expect(kept.split('\n')).toHaveLength(21);
  });

  it('returns short output unchanged', () => {
    expect(tail('one\ntwo', 20)).toBe('one\ntwo');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test -- plan.test.ts`
Expected: FAIL — `Failed to resolve import "./plan.ts"`.

- [ ] **Step 3: Write it**

`v2/extensions/worktree-hook/src/model/plan.ts`:

```ts
/**
 * What runs, in what order, and what a run's outcomes mean — with no filesystem
 * and no process in sight.
 *
 * The ordering rule is the only interesting decision: the global hook first,
 * because it is machine setup a repo's own hook may depend on, and the repo hook
 * skipped entirely if the global one failed for exactly that reason. Running the
 * repo hook after a failed global one produces a second, confusing failure that
 * buries the first.
 */

export type HookKind = 'global' | 'repo';

export interface HookRun {
  readonly kind: HookKind;
  readonly script: string;
}

export interface HookOutcome {
  readonly kind: HookKind;
  readonly ok: boolean;
  /** Merged stdout+stderr, already tailed, or the timeout wording. */
  readonly detail: string;
}

/** v1's number, and for v1's reason: enough to see what went wrong, short enough to read in a row. */
export const TAIL_LINES = 20;

export function planHooks(scripts: { readonly global?: string; readonly repo?: string }): readonly HookRun[] {
  const runs: HookRun[] = [];
  if (scripts.global !== undefined && scripts.global.trim() !== '') {
    runs.push({ kind: 'global', script: scripts.global });
  }
  if (scripts.repo !== undefined && scripts.repo.trim() !== '') {
    runs.push({ kind: 'repo', script: scripts.repo });
  }
  return runs;
}

export function describeOutcomes(
  outcomes: readonly HookOutcome[],
  opts: { readonly skippedRepoHook?: boolean } = {},
): { readonly ok: boolean; readonly message?: string } {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return { ok: true };

  const lines = failed.map((outcome) => `the ${outcome.kind} hook failed — ${outcome.detail}`);
  if (opts.skippedRepoHook === true) lines.push('the repo hook was skipped because the global hook failed');
  return { ok: false, message: lines.join('\n') };
}

/**
 * The last N lines, with a count of what was dropped.
 *
 * The count is the addition to v1's plain `tail`: output that silently begins
 * mid-sentence reads as the whole failure, and the first thing you do is go
 * looking for the rest.
 */
export function tail(text: string, lines: number): string {
  const all = text.split('\n');
  if (all.length <= lines) return text;
  const dropped = all.length - lines;
  return [`… ${dropped} earlier line(s)`, ...all.slice(-lines)].join('\n');
}
```

Then add to `src/model/index.ts`:

```ts
export { planHooks, describeOutcomes, tail, TAIL_LINES, type HookKind, type HookRun, type HookOutcome } from './plan.ts';
```

- [ ] **Step 4: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/worktree-hook/src/model
git commit -m "feat(worktree-hook): the pure planner — order, skipping, and output tails"
```

---

### Task 4: The runner

**Files:**
- Create: `v2/extensions/worktree-hook/src/runner.ts`
- Test: `v2/extensions/worktree-hook/src/runner.test.ts`

**Interfaces:**
- Consumes: `planHooks`, `describeOutcomes`, `tail`, `TAIL_LINES` from `./model/plan.ts`; `ProcessAPI` from `@shepherd/sdk`.
- Produces: `HOOK_TIMEOUT_MS = 600_000`; `hookEnv(fact)` → `Record<string, string>`; `runHooks(process_, { scripts, fact })` → `Promise<{ ok: boolean; message?: string }>`.

- [ ] **Step 1: Write the failing test**

`v2/extensions/worktree-hook/src/runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ExecOptions, ProcessAPI } from '@shepherd/sdk';
import { HOOK_TIMEOUT_MS, hookEnv, runHooks } from './runner.ts';

const FACT = {
  repo: { path: '/src/alpha', name: 'alpha' },
  worktree: '/tasks/fix-thing/alpha',
  branch: 'fix-thing',
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
};

function fakeProcess(
  reply: (cmd: readonly string[], opts: ExecOptions) => { ok: true; stdout: string; stderr: string } | { ok: false; code: number; stdout: string; stderr: string },
): { api: ProcessAPI; calls: { cmd: readonly string[]; opts: ExecOptions }[] } {
  const calls: { cmd: readonly string[]; opts: ExecOptions }[] = [];
  const api = {
    exec: async (cmd: readonly string[], opts: ExecOptions) => {
      calls.push({ cmd, opts });
      return reply(cmd, opts);
    },
    gitRead: async () => ({ ok: true as const, stdout: '', stderr: '' }),
    gitWrite: async () => ({ ok: true as const, stdout: '', stderr: '' }),
  } satisfies ProcessAPI;
  return { api, calls };
}

describe('hookEnv', () => {
  it('carries v1s names, so a v1 script runs unchanged', () => {
    expect(hookEnv(FACT)).toEqual({
      WORKTREE_DIR: '/tasks/fix-thing/alpha',
      WORKTREE_SRC: '/src/alpha',
      WORKTREE_BRANCH: 'fix-thing',
      WORKTREE_NAME: 'alpha',
      REPO_NAME: 'alpha',
      TASK_SLUG: 'fix-thing',
      TASK_ROOT: '/tasks/fix-thing',
    });
  });
});

describe('runHooks', () => {
  it('does not spawn anything when no hook is set', async () => {
    const { api, calls } = fakeProcess(() => ({ ok: true, stdout: '', stderr: '' }));
    expect(await runHooks(api, { scripts: {}, fact: FACT })).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('runs bash -lc in the worktree with the hook env and the hook timeout', async () => {
    const { api, calls } = fakeProcess(() => ({ ok: true, stdout: '', stderr: '' }));
    await runHooks(api, { scripts: { repo: 'cp ~/.env .' }, fact: FACT });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(['/bin/bash', '-lc', 'cp ~/.env .']);
    expect(calls[0]!.opts.cwd).toBe('/tasks/fix-thing/alpha');
    expect(calls[0]!.opts.timeoutMs).toBe(HOOK_TIMEOUT_MS);
    expect(calls[0]!.opts.env).toEqual(hookEnv(FACT));
  });

  it('runs the global hook before the repo hook', async () => {
    const { api, calls } = fakeProcess(() => ({ ok: true, stdout: '', stderr: '' }));
    await runHooks(api, { scripts: { global: 'echo g', repo: 'echo r' }, fact: FACT });
    expect(calls.map((call) => call.cmd[2])).toEqual(['echo g', 'echo r']);
  });

  it('merges stdout and stderr into the failure message', async () => {
    const { api } = fakeProcess(() => ({ ok: false, code: 3, stdout: 'copying', stderr: 'cp: no such file' }));
    const result = await runHooks(api, { scripts: { repo: 'cp nope .' }, fact: FACT });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited 3');
    expect(result.message).toContain('copying');
    expect(result.message).toContain('cp: no such file');
  });

  it('skips the repo hook when the global one fails, and says so', async () => {
    const { api, calls } = fakeProcess((cmd) =>
      cmd[2] === 'echo g' ? { ok: false, code: 1, stdout: '', stderr: 'nope' } : { ok: true, stdout: '', stderr: '' },
    );
    const result = await runHooks(api, { scripts: { global: 'echo g', repo: 'echo r' }, fact: FACT });
    expect(calls).toHaveLength(1);
    expect(result.message).toContain('the repo hook was skipped because the global hook failed');
  });

  it('keeps only the last 20 lines of output', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const { api } = fakeProcess(() => ({ ok: false, code: 1, stdout: long, stderr: '' }));
    const result = await runHooks(api, { scripts: { repo: 'noisy' }, fact: FACT });
    expect(result.message).toContain('earlier line(s)');
    expect(result.message).toContain('line 40');
    expect(result.message).not.toContain('line 1\n');
  });

  it('reports a thrown exec as a failure rather than throwing', async () => {
    const api = {
      exec: async () => {
        throw new Error('spawn EACCES');
      },
      gitRead: async () => ({ ok: true as const, stdout: '', stderr: '' }),
      gitWrite: async () => ({ ok: true as const, stdout: '', stderr: '' }),
    } satisfies ProcessAPI;
    const result = await runHooks(api, { scripts: { repo: 'anything' }, fact: FACT });
    expect(result).toEqual({ ok: false, message: expect.stringContaining('spawn EACCES') });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test -- runner.test.ts`
Expected: FAIL — `Failed to resolve import "./runner.ts"`.

- [ ] **Step 3: Write it**

`v2/extensions/worktree-hook/src/runner.ts`:

```ts
import type { ProcessAPI } from '@shepherd/sdk';
import type { RepoProvisionedFact } from '@shepherd/ext-tasks/manifest';
import { describeOutcomes, planHooks, tail, TAIL_LINES, type HookOutcome } from './model/plan.ts';

/**
 * A hook, actually run.
 *
 * `/bin/bash -lc <script>` is v1's shape: a login shell, so a hook sees the PATH
 * and the tool versions a person's terminal has, and the script as ONE string,
 * so a hook is a shell script and not an argv. It is spelled as an array because
 * v2's exec never goes through a shell — the words are the argv `execFile`
 * receives, so nothing here is re-parsed or interpolable.
 */
const BASH = '/bin/bash';

/** Room for a real dependency install inside a hook. `ExecOptions.timeoutMs` is required. */
export const HOOK_TIMEOUT_MS = 600_000;

/**
 * The five unprefixed names are v1's, unchanged, so a script written against v1
 * — `scripts/worktree-hook.sh` in this repo included — runs here untouched. The
 * two `TASK_` names are new, because in v2 a worktree has siblings and a hook may
 * want to reach them.
 */
export function hookEnv(fact: RepoProvisionedFact): Record<string, string> {
  return {
    WORKTREE_DIR: fact.worktree,
    WORKTREE_SRC: fact.repo.path,
    WORKTREE_BRANCH: fact.branch,
    WORKTREE_NAME: fact.repo.name,
    REPO_NAME: fact.repo.name,
    TASK_SLUG: fact.task.slug,
    TASK_ROOT: fact.task.root,
  };
}

export async function runHooks(
  process_: ProcessAPI,
  input: {
    readonly scripts: { readonly global?: string; readonly repo?: string };
    readonly fact: RepoProvisionedFact;
  },
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  const runs = planHooks(input.scripts);
  if (runs.length === 0) return { ok: true };

  const opts = {
    cwd: input.fact.worktree,
    env: hookEnv(input.fact),
    timeoutMs: HOOK_TIMEOUT_MS,
  };

  const outcomes: HookOutcome[] = [];
  for (const run of runs) {
    // The global hook is machine setup the repo hook may depend on, so a failed
    // global one stops the chain rather than producing a second failure that
    // buries the first.
    if (run.kind === 'repo' && outcomes.some((outcome) => !outcome.ok)) {
      return describeOutcomes(outcomes, { skippedRepoHook: true });
    }

    try {
      const result = await process_.exec([BASH, '-lc', run.script], opts);
      if (result.ok) {
        outcomes.push({ kind: run.kind, ok: true, detail: '' });
        continue;
      }
      // Merged, as v1 merged them: a hook's diagnosis is usually split across
      // both streams and reading either alone is reading half of it.
      const merged = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
      outcomes.push({
        kind: run.kind,
        ok: false,
        // The runner kills at the timeout and the exec layer reports it as a
        // non-zero exit with no output, which reads as a mystery. Say which.
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
        kind: run.kind,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return describeOutcomes(outcomes);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test`
Expected: PASS.

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook typecheck`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/worktree-hook/src/runner.ts v2/extensions/worktree-hook/src/runner.test.ts
git commit -m "feat(worktree-hook): run a hook in the worktree, with v1's env and shell"
```

---

### Task 5: `activate` — register the provider, and load the extension

**Files:**
- Create: `v2/extensions/worktree-hook/src/index.ts`, `v2/extensions/worktree-hook/src/index.test.ts`
- Modify: `v2/packages/app/src/main/index.ts:24`, `:710`, `:725`; `v2/packages/app/package.json`; `v2/packages/app/tsconfig.json`

**Interfaces:**
- Consumes: `createStore` (Task 2), `runHooks` (Task 4), `REPO_PROVISIONED_POINT_ID` (Task 2), `RepoProvisioned` / `RepoProvisionedFact` (Task 1).
- Produces: `activate` — the extension is live, and hooks run on `tasks.create` and `tasks.restore`.

- [ ] **Step 1: Write the failing test**

`v2/extensions/worktree-hook/src/index.test.ts`. Model the host fakes on `v2/extensions/claude-code/src/index.test.ts` (it activates an extension against a fake `api` and a fake `ctx`); the assertions are what matter:

```ts
import { describe, expect, it } from 'vitest';
import { REPO_PROVISIONED_POINT_ID } from './manifest.ts';
import { activate } from './index.ts';

const FACT = {
  repo: { path: '/src/alpha', name: 'alpha' },
  worktree: '/tasks/fix-thing/alpha',
  branch: 'fix-thing',
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
};

describe('the worktree-hook extension', () => {
  it('registers one provider into tasks.repoProvisioned', () => {
    const { host } = activateForTest();
    expect(host.point(REPO_PROVISIONED_POINT_ID).all()).toHaveLength(1);
  });

  it('is a no-op for a repo with no hook', async () => {
    const { host, exec } = activateForTest();
    const provider = host.point(REPO_PROVISIONED_POINT_ID).all()[0]!;
    expect(await provider(FACT)).toEqual({ ok: true });
    expect(exec.calls).toHaveLength(0);
  });

  it('runs the repo hook the store holds for that source path', async () => {
    const { host, exec, invoke } = activateForTest();
    await invoke('worktreeHook.set', { repo: '/src/alpha', script: 'cp ~/.env .' });

    const provider = host.point(REPO_PROVISIONED_POINT_ID).all()[0]!;
    expect(await provider(FACT)).toEqual({ ok: true });
    expect(exec.calls[0]!.cmd).toEqual(['/bin/bash', '-lc', 'cp ~/.env .']);
    expect(exec.calls[0]!.opts.cwd).toBe('/tasks/fix-thing/alpha');
  });

  it('reports a failing hook as a value, never a throw', async () => {
    const { host, exec, invoke } = activateForTest();
    exec.reply = () => ({ ok: false, code: 3, stdout: '', stderr: 'cp: no such file' });
    await invoke('worktreeHook.set', { repo: '/src/alpha', script: 'cp nope .' });

    const provider = host.point(REPO_PROVISIONED_POINT_ID).all()[0]!;
    const result = await provider(FACT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cp: no such file');
  });

  it('does nothing when tasks is not there to define the point', () => {
    // `points.get` answers `undefined` when nothing defines the id. The
    // extension must log and carry on — a crashing activate takes the app's
    // startup with it.
    const { host } = activateForTest({ withPoint: false });
    expect(host.logged.some((line) => line.includes('tasks.repoProvisioned'))).toBe(true);
  });
});
```

Write `activateForTest()` in this file: a `points` registry (import `PointRegistry` from `@shepherd/sdk` — `v2/packages/sdk/src/points.ts:148`), an in-memory `KV` (reuse the `fakeKv` from `store.test.ts` by exporting it from a small `src/test-fakes.ts`), a `ProcessAPI` whose `exec` records calls and answers `exec.reply(...)`, and a `ctx` with `storage`, `log`, `homeDir`, `subscriptions`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test -- index.test.ts`
Expected: FAIL — no `activate` export.

- [ ] **Step 3: Write `activate`**

`v2/extensions/worktree-hook/src/index.ts`:

```ts
import { s, type ActivateFn } from '@shepherd/sdk';
import type { RepoProvisioned, RepoProvisionedFact } from '@shepherd/ext-tasks/manifest';
import { REPO_PROVISIONED_POINT_ID, WORKTREE_HOOK_COMMANDS, WORKTREE_HOOK_VIEW } from './manifest.ts';
import { createStore } from './store.ts';
import { runHooks } from './runner.ts';

/**
 * `shepherd.worktree-hook` — a script you choose, run inside every worktree a
 * task creates.
 *
 * v1 had this per WORKSPACE (`spike/seam1/Sources/WorktreeHookRunner.swift`).
 * A v2 task worktrees several repos at once, so the same script running in all
 * of them is the wrong unit: the thing a hook does — copy this repo's `.env`,
 * symlink this repo's vendored directory — belongs to the repo. So the key is
 * the source repo path, and there is one global hook beside it for the machine
 * setup that genuinely is the same everywhere.
 *
 * The hook runs BEFORE the task root is materialized and long before a session
 * spawns, which is what `tasks.repoProvisioned` being awaited buys.
 */
export const activate: ActivateFn = (ctx, api) => {
  const { commands, points, process: process_, views } = api.proposed;
  const store = createStore(ctx.storage, ctx.homeDir);

  const point = points.get<RepoProvisioned>(REPO_PROVISIONED_POINT_ID);
  if (point === undefined) {
    // Reachable when `tasks` is disabled or failed to activate. Logged rather
    // than thrown: a hook nobody can run is a degraded feature, and a throwing
    // `activate` is a startup failure.
    ctx.log.warn(`nothing defines ${REPO_PROVISIONED_POINT_ID} — hooks will not run`);
  } else {
    ctx.subscriptions.push(
      point.register(async (fact: RepoProvisionedFact) =>
        runHooks(process_, {
          scripts: { global: store.global(), repo: store.forRepo(fact.repo.path) },
          fact,
        }),
      ),
    );
  }

  // `repo` absent means the global hook — one flag fewer than a `--global`
  // switch that must be checked against `--repo` being present too.
  const target = s.object({ repo: s.optional(s.string()) });

  ctx.subscriptions.push(
    commands.register(WORKTREE_HOOK_COMMANDS.get, {
      title: 'Worktree Hook: Show',
      schema: target,
      handler: (args) => ({
        scope: args.repo === undefined ? 'global' : args.repo,
        script: args.repo === undefined ? store.global() : store.forRepo(args.repo),
        repos: store.listRepos(),
      }),
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.set, {
      title: 'Worktree Hook: Set',
      schema: s.object({ repo: s.optional(s.string()), script: s.string() }),
      handler: (args) => {
        if (args.repo === undefined) store.setGlobal(args.script);
        else store.setForRepo(args.repo, args.script);
        return { scope: args.repo ?? 'global', cleared: args.script.trim() === '' };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.clear, {
      title: 'Worktree Hook: Clear',
      schema: target,
      handler: (args) => {
        if (args.repo === undefined) store.setGlobal('');
        else store.setForRepo(args.repo, '');
        return { scope: args.repo ?? 'global', cleared: true };
      },
    }),

    /**
     * v1's "Test run" (`spike/seam1/Sources/SettingsView.swift:373-396`), kept
     * because a hook is otherwise only testable by creating a task — and the
     * failure mode it catches (a typo, a missing file) is one you want before a
     * worktree exists, not after.
     *
     * The throwaway directory is the caller's to supply and to remove: an
     * extension that creates temp directories acquires a cleanup problem, and
     * `os.tmpdir()` is exactly the OS API `boundaries.js` keeps out of here.
     */
    commands.register(WORKTREE_HOOK_COMMANDS.testRun, {
      title: 'Worktree Hook: Test Run',
      schema: s.object({ repo: s.optional(s.string()), script: s.string(), at: s.string() }),
      handler: async (args) =>
        runHooks(process_, {
          scripts: { repo: args.script },
          fact: {
            repo: { path: args.repo ?? args.at, name: 'test-run' },
            worktree: args.at,
            branch: 'test-run',
            task: { slug: 'test-run', root: args.at },
          },
        }),
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.edit, {
      title: 'Worktree Hook: Edit',
      schema: s.nothing(),
      handler: () => views.activate(WORKTREE_HOOK_VIEW),
    }),
  );

  ctx.log.info(`ready — ${store.listRepos().length} repo hook(s), global hook ${store.global() === undefined ? 'unset' : 'set'}`);
};
```

If `views.activate(...)` is not the SDK's spelling, use whatever `tasks` calls to reveal its composer (`v2/extensions/tasks/src/index.ts`, the `TASK_COMMANDS.reveal` handler and the composer registration are the two places to copy from).

- [ ] **Step 4: Load the extension in main**

`v2/packages/app/src/main/index.ts` — add beside line 24:

```ts
import { worktreeHookManifest } from '@shepherd/ext-worktree-hook/manifest';
```

and add it **after** `tasksManifest` in both loops (lines 710 and 725), because it declares `shepherd.tasks` as a dependency and the point must exist before it registers:

```ts
for (const manifest of [diagnosticsManifest, agentsCoreManifest, claudeCodeManifest, tasksManifest, worktreeHookManifest]) {
```

Add `"@shepherd/ext-worktree-hook": "workspace:*"` to `v2/packages/app/package.json` dependencies, and `{ "path": "../../extensions/worktree-hook" }` to the `references` array of `v2/packages/app/tsconfig.json`. Then `cd v2 && pnpm install`.

- [ ] **Step 5: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook test && pnpm --filter @shepherd/app typecheck`
Expected: PASS, no typecheck output.

- [ ] **Step 6: Verify it in the real app**

Run: `cd v2 && pnpm dev`, then in another terminal:

```bash
mkdir -p /tmp/wh-proof && printf 'echo hooked > HOOKED.txt\n' > /tmp/wh-script.sh
shepherd raw worktreeHook.set --repo ~/Home/dev/shepherd --script 'echo hooked > HOOKED.txt'
shepherd task create --title "hook proof" --repo ~/Home/dev/shepherd
```

Expected: the new worktree under `~/.shepherd/v2-dev/<slug>/shepherd/` contains `HOOKED.txt`. Then clean up: `shepherd task delete --id <id>` and `shepherd raw worktreeHook.clear --repo ~/Home/dev/shepherd`.

- [ ] **Step 7: Commit**

```bash
git add v2/extensions/worktree-hook v2/packages/app
git commit -m "feat(worktree-hook): register the provider and load the extension"
```

---

### Task 6: The CLI noun

**Files:**
- Modify: `v2/packages/cli/src/argv.ts:20-44`
- Test: `v2/packages/cli/src/argv.test.ts`

**Interfaces:**
- Consumes: the command ids from Task 5.
- Produces: `shepherd worktree-hook get|set|clear|test-run`.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/cli/src/argv.test.ts`:

```ts
describe('the worktree-hook noun', () => {
  it('maps get/set/clear to their command ids', () => {
    expect(parseArgv(['worktree-hook', 'get'])).toMatchObject({ ok: true, command: 'worktreeHook.get' });
    expect(parseArgv(['worktree-hook', 'clear'])).toMatchObject({ ok: true, command: 'worktreeHook.clear' });
  });

  it('passes --repo through as a plain string, not as a repos array', () => {
    expect(parseArgv(['worktree-hook', 'set', '--repo', '~/dev/alpha', '--script', 'echo hi'])).toMatchObject({
      ok: true,
      command: 'worktreeHook.set',
      args: { repo: '~/dev/alpha', script: 'echo hi' },
    });
  });

  it('names the verbs it knows when given a bad one', () => {
    const parsed = parseArgv(['worktree-hook', 'nope']);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('get, set, clear, test-run');
  });
});
```

The second case is the trap: `--repo` currently accumulates into a `repos` array (`argv.ts:105-110`) because `tasks create` repeats it. Here it must stay a scalar.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/cli test`
Expected: FAIL — `unknown noun "worktree-hook"`, and `args.repos` instead of `args.repo`.

- [ ] **Step 3: Write it**

In `v2/packages/cli/src/argv.ts`, add to `VERBS`:

```ts
'worktree-hook': {
  get: 'worktreeHook.get',
  set: 'worktreeHook.set',
  clear: 'worktreeHook.clear',
  'test-run': 'worktreeHook.testRun',
},
```

`--repo` must not accumulate for this noun. Change `parseFlags` to take the noun and only treat `--repo` as repeating for `task create`:

```ts
// `--repo` REPEATS for `task create` (a task is 1..n repos) and is a single
// value everywhere else (a hook belongs to one repo). Deciding by noun rather
// than by "did it appear twice" keeps `worktree-hook set --repo x` from being
// a one-element array that the schema one process away then rejects.
const parsedArgs = parseFlags(rest, noun === 'task');
```

and in `parseFlags(rest: readonly string[], repoRepeats: boolean)`:

```ts
if (name === REPO_FLAG && repoRepeats) {
  repos.push({ path: value, name: value.split('/').filter((p) => p !== '').pop() ?? value });
} else {
  args[name] = value;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/cli test`
Expected: PASS, including the existing `task create --repo` cases.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/cli/src/argv.ts v2/packages/cli/src/argv.test.ts
git commit -m "feat(cli): shepherd worktree-hook get/set/clear/test-run"
```

---

### Task 7: The editor view

**Files:**
- Create: `v2/extensions/worktree-hook/ui/editor.tsx`
- Modify: `v2/extensions/worktree-hook/src/index.ts` (register the view type), `v2/packages/app/src/renderer/extension-ui.ts:29-32`
- Test: `v2/packages/app/src/renderer/extension-ui.test.ts` if one exists; otherwise the smoke below is the check.

**Interfaces:**
- Consumes: `ExtensionViewProps` from `@shepherd/sdk`; the commands from Task 5, reached via `invoke`.
- Produces: the `worktree-hook.editor` component.

- [ ] **Step 1: Register the view type in `activate`**

Add to `src/index.ts`, beside the command registrations:

```ts
/**
 * A view of its own only because v2 has no settings surface yet. When one
 * exists this belongs inside it — see this extension's README.
 */
ctx.subscriptions.push(
  views.registerViewType(WORKTREE_HOOK_VIEW, {
    kind: 'component',
    component: WORKTREE_HOOK_VIEW,
    surface: 'dock',
    title: 'Worktree hooks',
  }),
);
```

- [ ] **Step 2: Write the component**

`v2/extensions/worktree-hook/ui/editor.tsx`. Follow `v2/extensions/tasks/ui/composer.tsx` for the primitives and class names it uses; the behaviour it must have:

```tsx
import { useEffect, useState } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';

interface StoredHook {
  readonly path: string;
  readonly script: string;
}

/**
 * Editing a hook — the whole surface, until there is a settings page to fold it
 * into (see README).
 *
 * The repo path is a free-text field with completion borrowed from
 * `tasks.suggestRepos`, which is the same list the composer's picker offers. It
 * is borrowed rather than reimplemented so that a repo you can put on a task and
 * a repo you can hook are the same set, spelled the same way.
 */
export function WorktreeHookEditor({ invoke }: ExtensionViewProps): React.JSX.Element {
  const [global, setGlobal] = useState('');
  const [repos, setRepos] = useState<readonly StoredHook[]>([]);
  const [path, setPath] = useState('');
  const [script, setScript] = useState('');
  const [suggestions, setSuggestions] = useState<readonly { path: string }[]>([]);
  const [status, setStatus] = useState('');

  const refresh = async (): Promise<void> => {
    const shown = await invoke('worktreeHook.get', {});
    if (!shown.ok) {
      setStatus(`${shown.error.code}: ${shown.error.message}`);
      return;
    }
    const value = shown.value as { script?: string; repos: readonly StoredHook[] };
    setGlobal(value.script ?? '');
    setRepos(value.repos);
  };

  useEffect(() => void refresh(), []);

  const save = async (repo: string | undefined, text: string): Promise<void> => {
    const done = await invoke('worktreeHook.set', repo === undefined ? { script: text } : { repo, script: text });
    setStatus(done.ok ? 'saved' : `${done.error.code}: ${done.error.message}`);
    await refresh();
  };

  const complete = async (query: string): Promise<void> => {
    const found = await invoke('tasks.suggestRepos', { query });
    if (found.ok) setSuggestions(found.value as readonly { path: string }[]);
  };

  return (
    <div className="sh-ext-card" data-testid="worktree-hook-editor">
      <h2 className="sh-dock-title">worktree hooks</h2>

      <label htmlFor="wh-global">Every repo</label>
      <textarea id="wh-global" value={global} onChange={(e) => setGlobal(e.target.value)} rows={4} />
      <button type="button" onClick={() => void save(undefined, global)}>
        Save global hook
      </button>

      <label htmlFor="wh-path">Repo</label>
      <input
        id="wh-path"
        value={path}
        onChange={(e) => {
          setPath(e.target.value);
          void complete(e.target.value);
        }}
        list="wh-repo-suggestions"
      />
      <datalist id="wh-repo-suggestions">
        {suggestions.map((repo) => (
          <option key={repo.path} value={repo.path} />
        ))}
      </datalist>
      <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={6} />
      <button type="button" onClick={() => void save(path, script)} disabled={path.trim() === ''}>
        Save repo hook
      </button>

      <ul data-testid="worktree-hook-list">
        {repos.map((hook) => (
          <li key={hook.path}>
            <button
              type="button"
              onClick={() => {
                setPath(hook.path);
                setScript(hook.script);
              }}
            >
              {hook.path}
            </button>
            <button type="button" onClick={() => void save(hook.path, '')}>
              clear
            </button>
          </li>
        ))}
      </ul>

      <p data-testid="worktree-hook-status">{status}</p>
    </div>
  );
}
```

Leave the "Test run" button out of this task — it needs a throwaway directory the renderer cannot create, and the `worktreeHook.testRun` command is already reachable from the CLI. Note it in the README as the one deferred piece of the UI.

- [ ] **Step 3: Add it to the renderer's table**

`v2/packages/app/src/renderer/extension-ui.ts`:

```ts
import { WorktreeHookEditor } from '@shepherd/ext-worktree-hook/ui';
```

```ts
export const EXTENSION_UI: Readonly<Record<string, ComponentType<ExtensionViewProps>>> = {
  'tasks.composer': TaskComposer,
  'diagnostics.card': DiagnosticsCard,
  'worktree-hook.editor': WorktreeHookEditor,
};
```

- [ ] **Step 4: Typecheck and run the suites**

Run: `cd v2 && pnpm --filter @shepherd/ext-worktree-hook typecheck && pnpm --filter @shepherd/app test`
Expected: no typecheck output; app suite passes.

- [ ] **Step 5: See it**

Run: `cd v2 && pnpm dev`, then `shepherd raw worktreeHook.edit`.
Expected: the dock shows "worktree hooks" with the global field, a repo field that completes as you type, and any repo hooks you set in Task 5.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/worktree-hook/ui v2/extensions/worktree-hook/src/index.ts v2/packages/app/src/renderer/extension-ui.ts
git commit -m "feat(worktree-hook): the editor view"
```

---

### Task 8: Docs

**Files:**
- Create: `v2/extensions/worktree-hook/README.md`
- Modify: `docs/control-cli.md` (the hook paragraph at `:68-90` describes v1 — add the v2 verbs beside it)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the extension README**

`v2/extensions/worktree-hook/README.md`, following the shape of `v2/extensions/claude-code/README.md`. It must state:

- What a hook is, and that it is per source-repo path with one global hook beside it.
- The env table from the design doc, and that the first five names are v1's so a v1 script runs unchanged.
- `/bin/bash -lc`, cwd = the new worktree, 600s timeout, stdout+stderr merged, last 20 lines kept.
- Failure is degraded, not fatal: worktree kept, agents spawn, the row reads `ready — hook failed`.
- That it runs on restore as well as create.
- **A "Not done yet" section whose first line is:** "**A settings page.** This extension contributes its own `worktree-hook.editor` view for one reason: v2 has no settings surface. The moment there is one, this editor belongs inside it and the standalone view should go. Do not let it become the permanent home." Second line: the Test run button, deferred from Task 7.
- That `scripts/worktree-hook.sh` at the repo root is a working example.

- [ ] **Step 2: Document the CLI verbs**

In `docs/control-cli.md`, beside the existing `workspace hook` rows (`:53-55`), add a v2 table:

```markdown
| `worktree-hook get [--repo <path>]` | the script for that repo, or the global one |
| `worktree-hook set [--repo <path>] --script <sh>` | set it; an empty script clears |
| `worktree-hook clear [--repo <path>]` | clear it |
| `worktree-hook test-run --script <sh> --at <dir>` | run a script against a throwaway directory |
```

and a paragraph saying the v1 `workspace hook` verbs are per-workspace and do not migrate — an existing hook must be re-entered once per repo.

- [ ] **Step 3: Full verification**

Run: `cd v2 && pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. The lint run is the one that catches a value import of `@shepherd/ext-tasks` if one crept in.

- [ ] **Step 4: Commit**

```bash
git add v2/extensions/worktree-hook/README.md docs/control-cli.md
git commit -m "docs: the worktree hook, and the settings page it is waiting for"
```

---

## Self-review notes

- Spec §"The seam" → Task 1. §"The extension" → Task 2. §"Execution" → Tasks 3, 4. §"Failure" → Tasks 1, 3, 4. §"Surfaces" → Tasks 5, 6, 7. §"Restore" → Task 1 (both `tasks.create` and `tasks.restore` call `provision()`, so no extra work; the restore test is worth adding if `index.test.ts` already has a restore harness). §"Testing" → Tasks 1–5. §"Deferred" → Task 8.
- Names used consistently across tasks: `REPO_PROVISIONED_POINT` (in `tasks`) vs `REPO_PROVISIONED_POINT_ID` (the local copy in `worktree-hook`) — deliberately different identifiers for the same string, so a reader can see which side they are on. `RepoProvisioned`, `RepoProvisionedFact`, `planHooks`, `describeOutcomes`, `tail`, `TAIL_LINES`, `hookEnv`, `runHooks`, `HOOK_TIMEOUT_MS`, `createStore` are each defined once and referenced by those exact names everywhere after.
- The one place the plan says "follow the existing pattern" rather than giving code is the test harness in Tasks 1 and 5 (`activateForTest`), because it must match host fakes that already exist in those suites and inventing a second set would be worse than reading the first.
