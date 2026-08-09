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
import type { RepoProvisioned, RepoProvisionedFact } from '@shepherd/ext-tasks/manifest';
import { activate } from './index.ts';
import { REPO_PROVISIONED_POINT_ID, WORKTREE_HOOK_COMMANDS, WORKTREE_HOOK_VIEW } from './manifest.ts';

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

interface ExecCall {
  readonly cmd: readonly string[];
  readonly opts: ExecOptions;
}

interface Harness {
  run<R>(id: string, args?: unknown): Promise<R>;
  /** The providers registered into the point, as `tasks` would see them. */
  providers(): readonly RepoProvisioned[];
  readonly execs: ExecCall[];
  /** What the fake `exec` answers. Reassignable mid-test. */
  reply: (call: ExecCall) => ExecOk | ExecErr;
  readonly warnings: string[];
  viewTypes(): ReadonlyMap<string, ViewProvider>;
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
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: { ...nullLogger.child('extension'), warn: (line: string) => void warnings.push(line) },
    clock: manualClock(1),
    permissions: ['storage', 'process.exec', 'views'],
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
    execs,
    get reply() {
      return state.reply;
    },
    set reply(next: (call: ExecCall) => ExecOk | ExecErr) {
      state.reply = next;
    },
    warnings,
    viewTypes: () => viewTypes,
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
    expect(h.viewTypes().has(WORKTREE_HOOK_VIEW)).toBe(true);
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

describe('the editor view', () => {
  it('is an overlay with an accelerator, since nothing else can raise it', () => {
    const h = harness();
    const provider = h.viewTypes().get(WORKTREE_HOOK_VIEW);
    expect(provider).toMatchObject({
      kind: 'component',
      component: WORKTREE_HOOK_VIEW,
      surface: 'overlay',
      key: 'CmdOrCtrl+Shift+H',
    });
    h.dispose();
  });
});
