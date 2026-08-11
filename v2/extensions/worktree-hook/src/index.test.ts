import { describe, expect, it } from 'vitest';
import {
  extensionId,
  manualClock,
  nullLogger,
  PointRegistry,
  toDisposable,
  type Caller,
  type CommandAPI,
  type CommandSpec,
  type ExecErr,
  type ExecOk,
  type ExecOptions,
  type ExtensionContext,
  type KV,
  type Schema,
  type Shepherd,
  type ViewAPI,
  type ViewProvider,
} from '@shepherd/sdk';
import type {
  RepoProvisioned,
  RepoProvisionedFact,
  TaskProvisioned,
  TaskProvisionedFact,
} from '@shepherd/ext-tasks/manifest';
import { activate } from './index.ts';
import {
  REPO_PROVISIONED_POINT_ID,
  TASK_PROVISIONED_POINT_ID,
  WORKTREE_HOOK_COMMANDS,
  WORKTREE_HOOK_VIEW,
  worktreeHookManifest,
} from './manifest.ts';

/**
 * The extension through `activate`, with `tasks` played by a real
 * `PointRegistry` — because the claim worth testing is that a provider lands in
 * the seam `tasks` actually defines and answers the shape it actually expects.
 * A hand-rolled point would agree with whatever this file happened to do.
 */

const CALLER: Caller = { kind: 'device', deviceId: 'test' };
const OK: ExecOk = { ok: true, stdout: '', stderr: '' };
const HOME = '/Users/x';

const FACT: RepoProvisionedFact = {
  repo: { path: '/src/alpha', name: 'alpha' },
  worktree: '/tasks/fix-thing/alpha',
  branch: 'fix-thing',
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
};

const TASK_FACT: TaskProvisionedFact = {
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
  branch: 'fix-thing',
  repos: [
    { path: '/src/alpha', name: 'alpha', worktree: '/tasks/fix-thing/alpha' },
    { path: '/src/beta', name: 'beta', worktree: '/tasks/fix-thing/beta' },
  ],
};

interface ExecCall {
  readonly cmd: readonly string[];
  readonly opts: ExecOptions;
}

interface Harness {
  run<R>(id: string, args?: unknown): Promise<R>;
  /** The providers registered into the point, as `tasks` would see them. */
  providers(): readonly RepoProvisioned[];
  /** The providers registered into the TASK point, as `tasks` would see them. */
  taskProviders(): readonly TaskProvisioned[];
  readonly execs: ExecCall[];
  /** What the fake `exec` answers. Reassignable mid-test. */
  reply: (call: ExecCall) => ExecOk | ExecErr;
  readonly warnings: string[];
  viewTypes(): ReadonlyMap<string, ViewProvider>;
  /** Every command this extension registered — what a missing point must not cost. */
  commandIds(): readonly string[];
  dispose(): void;
}

function harness(opts: { withPoint?: boolean } = {}): Harness {
  const raw = new Map<string, unknown>();
  const storage: KV = {
    get: <T>(key: string, schema: Schema<T>): T | undefined => {
      if (!raw.has(key)) return undefined;
      const parsed = schema.parse(raw.get(key));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void raw.set(key, value),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()].sort(),
  };

  const registered = new Map<string, CommandSpec<unknown, unknown>>();
  const commands: CommandAPI = {
    register: (id, spec) => {
      registered.set(id, spec as unknown as CommandSpec<unknown, unknown>);
      return toDisposable(() => void registered.delete(id));
    },
    invoke: () => Promise.resolve({ ok: true, value: undefined as never }),
    list: () => [...registered.keys()].map((id) => ({ id })),
  };

  const execs: ExecCall[] = [];
  const state = { reply: (() => OK) as (call: ExecCall) => ExecOk | ExecErr };
  const process_ = {
    exec: (cmd: readonly string[], opts_: ExecOptions) => {
      const call = { cmd, opts: opts_ };
      execs.push(call);
      return Promise.resolve(state.reply(call));
    },
    gitRead: () => Promise.resolve(OK),
    gitWrite: () => Promise.resolve(OK),
  };

  // `tasks`, standing in — the registry the real host hands out, with the point
  // defined by somebody else exactly as it is in the app.
  const registry = new PointRegistry({ logger: nullLogger });
  const point =
    opts.withPoint === false
      ? undefined
      : registry.define<RepoProvisioned>(REPO_PROVISIONED_POINT_ID, {
          order: 'registration',
          owner: 'shepherd.tasks',
        });
  const taskPoint =
    opts.withPoint === false
      ? undefined
      : registry.define<TaskProvisioned>(TASK_PROVISIONED_POINT_ID, {
          order: 'registration',
          owner: 'shepherd.tasks',
        });

  const viewTypes = new Map<string, ViewProvider>();
  const views: ViewAPI = {
    registerViewType: (type, provider) => {
      viewTypes.set(type, provider);
      return toDisposable(() => void viewTypes.delete(type));
    },
    registerStatusItem: () => toDisposable(() => {}),
  };

  const warnings: string[] = [];
  const ctx: ExtensionContext = {
    id: extensionId('shepherd.worktree-hook'),
    source: 'builtin',
    subscriptions: [],
    storage,
    dataDir: '/data',
    homeDir: HOME,
    userName: 'ada',
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: { ...nullLogger.child('extension'), warn: (line: string) => void warnings.push(line) },
    clock: manualClock(1),
    permissions: ['storage', 'process.exec'],
    isDev: false,
  };

  const api = {
    version: '1.0.0',
    proposed: { commands, points: registry, views, process: process_ },
  } as unknown as Shepherd;

  activate(ctx, api);

  return {
    run: async <R>(id: string, args?: unknown): Promise<R> => {
      const spec = registered.get(id);
      if (spec === undefined) throw new Error(`no command ${id} was registered`);
      return (await spec.handler(args, CALLER)) as R;
    },
    providers: () => point?.all() ?? [],
    taskProviders: () => taskPoint?.all() ?? [],
    execs,
    get reply() {
      return state.reply;
    },
    set reply(next: (call: ExecCall) => ExecOk | ExecErr) {
      state.reply = next;
    },
    warnings,
    viewTypes: () => viewTypes,
    commandIds: () => [...registered.keys()],
    dispose: () => {
      for (const sub of ctx.subscriptions) sub.dispose();
      registry.dispose();
    },
  };
}

describe('the provider it registers', () => {
  it('lands exactly one provider in tasks.repoProvisioned', () => {
    const h = harness();
    expect(h.providers()).toHaveLength(1);
    h.dispose();
  });

  it('is a no-op, spawning nothing, for a repo with no hook', async () => {
    const h = harness();
    expect(await h.providers()[0]?.(FACT)).toEqual({ ok: true });
    expect(h.execs).toHaveLength(0);
    h.dispose();
  });

  it('runs the hook stored for that SOURCE repo path, in the worktree', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'cp ~/.env .' });

    expect(await h.providers()[0]?.(FACT)).toEqual({ ok: true });
    expect(h.execs[0]?.cmd).toEqual(['/bin/bash', '-lc', 'cp ~/.env .']);
    expect(h.execs[0]?.opts.cwd).toBe('/tasks/fix-thing/alpha');
    h.dispose();
  });

  it('does not run another repo’s hook', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/beta', script: 'echo beta' });

    await h.providers()[0]?.(FACT);
    expect(h.execs).toHaveLength(0);
    h.dispose();
  });

  it('runs the global hook for a repo that has none of its own', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { script: 'echo global' });

    await h.providers()[0]?.(FACT);
    expect(h.execs.map((call) => call.cmd[2])).toEqual(['echo global']);
    h.dispose();
  });

  it('finds a hook stored under ~ when the task names the expanded path', async () => {
    // The composer hands over an expanded path and the CLI may not. Two
    // spellings of one repo must be one hook.
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '~/dev/alpha', script: 'echo hi' });

    await h.providers()[0]?.({ ...FACT, repo: { path: `${HOME}/dev/alpha`, name: 'alpha' } });
    expect(h.execs.map((call) => call.cmd[2])).toEqual(['echo hi']);
    h.dispose();
  });

  it('reports a failing hook as a VALUE, never a throw', async () => {
    // It runs inside somebody else's provisioning. A throw here would be a
    // throw in the middle of creating a task.
    const h = harness();
    h.reply = () => ({ ok: false, code: 3, stdout: '', stderr: 'cp: no such file' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'cp nope .' });

    const result = await h.providers()[0]?.(FACT);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('cp: no such file');
    h.dispose();
  });

  it('warns and stays up when nothing defines the point', () => {
    // `tasks` disabled or failed to activate. A crashing activate would take
    // the app's startup with it, and the editor still has to work so the
    // scripts already set are neither lost nor hidden.
    const h = harness({ withPoint: false });
    expect(h.warnings.some((line) => line.includes(REPO_PROVISIONED_POINT_ID))).toBe(true);
    // The editor used to be a view, and this asserted the view was still
    // registered. It is a settings page in the manifest now, so what proves the
    // same claim is that the VERBS behind it are still registered: the page is
    // listed either way, and a page whose commands are missing is an editor that
    // cannot show or change what is already stored.
    expect(h.commandIds()).toContain(WORKTREE_HOOK_COMMANDS.get);
    expect(h.commandIds()).toContain(WORKTREE_HOOK_COMMANDS.set);
    h.dispose();
  });
});

describe('the commands', () => {
  it('shows the global hook when no repo is named', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { script: 'echo global' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ scope: 'global', script: 'echo global' });
    h.dispose();
  });

  it('lists every repo hook alongside whichever one was asked for', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/beta', script: 'echo b' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'echo a' });

    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repo: '/src/alpha' })).toEqual({
      scope: '/src/alpha',
      script: 'echo a',
      repos: [
        { path: '/src/alpha', script: 'echo a' },
        { path: '/src/beta', script: 'echo b' },
      ],
      // One call fills the whole editor, so the answer carries every scope
      // there is — empty here, and present rather than absent.
      sets: [],
    });
    h.dispose();
  });

  it('says when setting a hook to nothing deleted it', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'echo a' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: '  ' })).toEqual({
      scope: '/src/alpha',
      cleared: true,
    });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repo: '/src/alpha' })).toMatchObject({ script: undefined });
    h.dispose();
  });

  it('clears a repo hook without touching the global one', async () => {
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { script: 'echo global' });
    await h.run(WORKTREE_HOOK_COMMANDS.set, { repo: '/src/alpha', script: 'echo a' });
    await h.run(WORKTREE_HOOK_COMMANDS.clear, { repo: '/src/alpha' });

    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ script: 'echo global' });
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, { repo: '/src/alpha' })).toMatchObject({ script: undefined });
    h.dispose();
  });

  it('test-runs a script in the directory it was handed, without saving it', async () => {
    const h = harness();
    const result = await h.run(WORKTREE_HOOK_COMMANDS.testRun, { script: 'echo trying', at: '/tmp/throwaway' });

    expect(result).toEqual({ ok: true });
    expect(h.execs[0]?.cmd).toEqual(['/bin/bash', '-lc', 'echo trying']);
    expect(h.execs[0]?.opts.cwd).toBe('/tmp/throwaway');
    expect(await h.run(WORKTREE_HOOK_COMMANDS.get, {})).toMatchObject({ script: undefined });
    h.dispose();
  });

  it('test-runs the script in front of you and NOT the global hook as well', async () => {
    // A test run that quietly ran the global hook first would say nothing about
    // the script you typed.
    const h = harness();
    await h.run(WORKTREE_HOOK_COMMANDS.set, { script: 'echo global' });
    await h.run(WORKTREE_HOOK_COMMANDS.testRun, { script: 'echo trying', at: '/tmp/throwaway' });

    expect(h.execs.map((call) => call.cmd[2])).toEqual(['echo trying']);
    h.dispose();
  });

  it('reports a failing test run rather than throwing', async () => {
    const h = harness();
    h.reply = () => ({ ok: false, code: 1, stdout: '', stderr: 'nope' });
    const result = await h.run<{ ok: boolean; message?: string }>(WORKTREE_HOOK_COMMANDS.testRun, {
      script: 'false',
      at: '/tmp/throwaway',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('nope');
    h.dispose();
  });
});

describe('the editor', () => {
  it('is a settings page in the manifest, and registers no view at all', () => {
    // It was an overlay with a ⌘⇧H of its own, and its own comment said that was
    // only because v2 had no settings surface. There is one now (spec
    // 2026-08-11), so the page is static data in the manifest and this extension
    // does nothing at activation to put it there — which is what lets the screen
    // list it while this extension is not running.
    const h = harness();
    expect(h.viewTypes().size).toBe(0);
    /**
     * The fields that carry the CLAIM, not the whole object.
     *
     * A deep-equal here pinned the page's presentation as well as its identity, so
     * adding the page's one serif sentence (a redesign of the screen, not of this
     * extension) failed a test about where the editor lives. What matters is that
     * it is one page, that it is a COMPONENT page, and that it names this
     * extension's UI module.
     */
    expect(worktreeHookManifest.contributes?.settings).toHaveLength(1);
    expect(worktreeHookManifest.contributes?.settings?.[0]).toMatchObject({
      id: 'worktreeHook.editor',
      title: 'Worktree hooks',
      component: WORKTREE_HOOK_VIEW,
    });
    h.dispose();
  });

  it('no longer asks for the `views` grant it would not use', () => {
    // An unused permission in a manifest is a grant nobody can justify at review.
    expect(worktreeHookManifest.permissions).not.toContain('views');
  });
});

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
    // The verbs, not the view: the editor is a settings page now (see 'the
    // editor'), so what has to survive a missing point is the ability to show and
    // change hooks that are already stored.
    expect(h.commandIds()).toContain(WORKTREE_HOOK_COMMANDS.get);
    h.dispose();
  });
});
