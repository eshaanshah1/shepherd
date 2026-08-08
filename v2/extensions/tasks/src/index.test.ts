import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extensionId,
  manualClock,
  nullLogger,
  toDisposable,
  type Caller,
  type CommandAPI,
  type CommandError,
  type CommandSpec,
  type Envelope,
  type EventAPI,
  type ExecErr,
  type ExecOk,
  type ExecOptions,
  type ExtensionContext,
  type ExtensionPoint,
  type KV,
  type PointsAPI,
  type ProcessAPI,
  type Result,
  type Schema,
  type Shepherd,
  type TreeDataProvider,
  type TreeItem,
  type ViewAPI,
  type ViewProvider,
} from '@shepherd/sdk';
import { activate } from './index.ts';
import { TASK_SCHEMA_VERSION, type TaskRecord } from './store.ts';

/**
 * `tasks.delete`, through `activate` — the handler, not the pieces under it.
 *
 * Everything this verb gets wrong is wrong in the ORDER it does things: panes
 * closed before the directory they are running in vanishes, `worktree prune`
 * after the `rmSync` rather than before, the record removed last so a failure
 * halfway through still names its leftovers. None of that survives being tested
 * one function at a time — `removeWorktree` is pinned in `provision.test.ts` and
 * every one of those tests passed while the handler around it was stranding
 * registrations. So the seams are faked and the handler is real.
 *
 * The fakes below are the same shape as `fakeKV` in `store.test.ts`: canned
 * answers plus a record of what was asked. `trace` is the addition, and it is
 * what makes the ordering assertable at all — one list both the command
 * invocations and the git calls write to, in the order they actually happened.
 */

const CALLER: Caller = { kind: 'device', deviceId: 'test' };
const OK: ExecOk = { ok: true, stdout: '', stderr: '' };

interface GitCall {
  readonly fn: 'gitRead' | 'gitWrite';
  readonly args: readonly string[];
  readonly opts: ExecOptions;
}

interface Harness {
  /**
   * Run a registered command's handler directly.
   *
   * Deliberately NOT `commands.invoke`: the real registry turns a throw into a
   * typed `handler-failed`, and "refuses an unknown task by name" is a fact
   * about the handler that would be swallowed by testing it through the wrapper.
   */
  run<R>(id: string, args?: unknown): Promise<R>;
  /** Every `commands.invoke` the extension made — layout.close lives here. */
  readonly invoked: { id: string; args: unknown }[];
  readonly git: GitCall[];
  /** Invocations and git calls interleaved, which is where the ordering shows. */
  readonly trace: string[];
  /**
   * The HOST announcing something — the opposite direction from `EventAPI.emit`,
   * which is the extension's own. This is how a test plays `agents-core` and
   * puts a pane into attention.
   */
  emit(topic: string, payload: unknown): void;
  /** The extension's own tree, as the shell would ask it. */
  tree(): TreeDataProvider;
  readonly dataDir: string;
  dispose(): void;
}

function harness(
  opts: {
    tasks?: readonly TaskRecord[];
    git?: (call: GitCall) => ExecOk | ExecErr;
    /**
     * Answer a command the extension does not own. `undefined` falls through to
     * the defaults below, so a test overrides one verb without restating them.
     */
    invoke?: (id: string, args: unknown) => Result<unknown, CommandError> | undefined;
  } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'shepherd-tasks-'));
  const raw = new Map<string, unknown>();
  for (const task of opts.tasks ?? []) raw.set(`task:${task.id}`, task);

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

  const trace: string[] = [];
  const invoked: { id: string; args: unknown }[] = [];
  const registered = new Map<string, CommandSpec<unknown, unknown>>();
  let panes = 0;
  const commands: CommandAPI = {
    register: (id, spec) => {
      registered.set(id, spec as unknown as CommandSpec<unknown, unknown>);
      return toDisposable(() => void registered.delete(id));
    },
    invoke: async (id, args) => {
      invoked.push({ id, args });
      trace.push(`invoke ${id}`);
      const spec = registered.get(id);
      if (spec !== undefined) return { ok: true, value: (await spec.handler(args, CALLER)) as never };
      const override = opts.invoke?.(id, args);
      if (override !== undefined) return override as never;
      // `layout.split` answers with the pane id ITSELF, which is what the kernel
      // returns and what `startSession` records. The blanket `undefined` below
      // would make every spawn key its session on a pane that is not a string,
      // and the tests would agree with each other about nothing.
      if (id === 'layout.split') return { ok: true, value: `p${(panes += 1)}` as never };
      // Everything else the extension does not own answers OK and nothing else,
      // which is what `layout.close` and `layout.rename` on a live pane do. The
      // failing cases are their own tests, so a blanket failure here would hide
      // them.
      return { ok: true, value: undefined as never };
    },
    list: () => [...registered.keys()].map((id) => ({ id })),
  };

  /**
   * The bus, as a table of subscribers plus a way to drive it.
   *
   * A real fake rather than a cast, because the extension's whole attention
   * feature is what it does when a payload arrives — a stub that accepted a
   * subscription and never called it would let every assertion below be about
   * an empty mirror.
   */
  const subscribers = new Map<string, Set<(payload: unknown, envelope: Envelope) => void>>();
  let seq = 0;
  const events: EventAPI = {
    emit: (topic) => void trace.push(`emit ${topic}`),
    on: (topic, fn) => {
      const listener = fn as (payload: unknown, envelope: Envelope) => void;
      const set = subscribers.get(topic) ?? new Set();
      set.add(listener);
      subscribers.set(topic, set);
      return toDisposable(() => void set.delete(listener));
    },
  };

  const git: GitCall[] = [];
  const answer = opts.git ?? (() => OK);
  const process_: ProcessAPI = {
    exec: () => Promise.resolve(OK),
    gitRead: (args, opts_) => record('gitRead', args, opts_),
    gitWrite: (args, opts_) => record('gitWrite', args, opts_),
  };
  function record(fn: GitCall['fn'], args: readonly string[], opts_: ExecOptions): Promise<ExecOk | ExecErr> {
    const call: GitCall = { fn, args, opts: opts_ };
    git.push(call);
    trace.push(`git ${args.join(' ')}`);
    return Promise.resolve(answer(call));
  }

  const points: PointsAPI = {
    define: <T>(id: string): ExtensionPoint<T> => {
      const providers: T[] = [];
      return {
        id,
        register: (provider) => {
          providers.push(provider);
          return toDisposable(() => {
            const at = providers.indexOf(provider);
            if (at !== -1) providers.splice(at, 1);
          });
        },
        all: () => providers,
        first: () => providers[0],
        dispose: () => void (providers.length = 0),
      };
    },
    get: () => undefined,
  };

  const viewTypes = new Map<string, ViewProvider>();
  const views: ViewAPI = {
    registerViewType: (type, provider) => {
      viewTypes.set(type, provider);
      return toDisposable(() => void viewTypes.delete(type));
    },
    registerStatusItem: () => toDisposable(() => {}),
  };

  const ctx: ExtensionContext = {
    id: extensionId('shepherd.tasks'),
    source: 'builtin',
    subscriptions: [],
    storage,
    dataDir,
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: nullLogger.child('extension'),
    clock: manualClock(1),
    permissions: [],
    isDev: false,
  };

  // The five groups `activate` reaches are typed at their declaration, so the
  // compiler still checks the shapes that matter. The other four are cast past
  // rather than stubbed: a stub for `attention` or `layout` here would be
  // surface that looks exercised and never is, and the next reader would have to
  // find that out by grepping. `attention` in particular stays absent on
  // purpose — this extension reads the topic and never touches that API.
  const api = {
    version: '1.0.0',
    proposed: { commands, events, points, views, process: process_ },
  } as unknown as Shepherd;

  activate(ctx, api);

  return {
    run: async <R>(id: string, args?: unknown): Promise<R> => {
      const spec = registered.get(id);
      if (spec === undefined) throw new Error(`no command ${id} was registered`);
      return (await spec.handler(args, CALLER)) as R;
    },
    invoked,
    git,
    trace,
    emit: (topic, payload) => {
      seq += 1;
      for (const fn of [...(subscribers.get(topic) ?? [])]) fn(payload, { seq, ts: 0, source: CALLER });
    },
    tree: () => {
      const provider = viewTypes.get('tasks.tree');
      if (provider?.kind !== 'tree') throw new Error('no tree view type was registered');
      return provider.data;
    },
    dataDir,
    dispose: () => {
      for (const sub of ctx.subscriptions) sub.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  schemaVersion: TASK_SCHEMA_VERSION,
  id: 't1',
  slug: 'fix-login',
  title: 'Fix login',
  brief: 'Make it work.',
  lifecycle: 'running',
  repos: [{ name: 'api', path: '/src/api' }],
  sessions: [],
  createdAt: 1,
  ...over,
});

/** git's answer to `worktree remove`, refusing. The one call that can fail here. */
const refusesRemoval = (call: GitCall): ExecOk | ExecErr =>
  call.args[0] === 'worktree' && call.args[1] === 'remove'
    ? { ok: false, code: 128, stdout: '', stderr: "fatal: '/x' is a main working tree\n" }
    : OK;

interface DeleteResult {
  readonly id: string;
  readonly slug: string;
  readonly branchesLeft: readonly string[];
  readonly failed: readonly string[];
}

/** A task's state as `tasks.list` answers it — the derived one, not the stored one. */
const listedState = async (h: Harness): Promise<string> =>
  (await h.run<{ displayState: string }[]>('tasks.list'))[0]?.displayState ?? 'no such task';

/** The tree's headings, in order — which is where a task MOVING shows. */
const sections = async (h: Harness): Promise<string[]> =>
  (await h.tree().children(undefined)).filter((row) => row.section === true).map((row) => row.label);

/**
 * Wait for work the extension started and did not hand back.
 *
 * `tasks.create` provisions optimistically (`void provision(task)`), so the
 * orchestrator's pane is opened after the handler has already answered. Real
 * timers, deliberately: the clock is manual so `correlate`'s poll never fires,
 * and this must not wait on it.
 */
async function until(holds: () => boolean, ticks = 50): Promise<void> {
  for (let attempt = 0; attempt < ticks; attempt += 1) {
    if (holds()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the condition never held after ${ticks} ticks`);
}

let live: Harness | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

describe('tasks.delete', () => {
  it('removes the record, so the task is gone from the list it was in', async () => {
    const h = (live = harness({ tasks: [task()] }));
    expect(await h.run<unknown[]>('tasks.list')).toHaveLength(1);
    await h.run('tasks.delete', { task: 't1' });
    expect(await h.run<unknown[]>('tasks.list')).toEqual([]);
  });

  it('destroys the generated task root, which is the extension’s own directory', async () => {
    const h = (live = harness({ tasks: [task()] }));
    const root = join(h.dataDir, 'fix-login');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Fix login\n');

    await h.run('tasks.delete', { task: 't1' });
    expect(existsSync(root)).toBe(false);
  });

  it('refuses an unknown task BY NAME, rather than deleting nothing quietly', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await expect(h.run('tasks.delete', { task: 'ghost' })).rejects.toThrow('ghost');
    // And the real task is untouched — a miss must not be a partial hit.
    expect(await h.run<unknown[]>('tasks.list')).toHaveLength(1);
  });

  it('names the branches it left, as "repo: branch"', async () => {
    // The branch is deliberately NOT deleted — it lives in the source repo and
    // may carry commits — so the answer has to be specific enough for a person
    // to go and find it.
    const h = (live = harness({
      tasks: [task()],
      git: (call) => (call.args[0] === 'rev-parse' ? { ok: true, stdout: 'fix-login\n', stderr: '' } : OK),
    }));
    const out = await h.run<DeleteResult>('tasks.delete', { task: 't1' });
    expect(out.branchesLeft).toEqual(['api: fix-login']);
    expect(out.failed).toEqual([]);
  });

  describe('a worktree that will not come off', () => {
    const twoRepos = task({
      repos: [
        { name: 'api', path: '/src/api' },
        { name: 'web', path: '/src/web' },
      ],
    });

    it('does NOT abort — the record still goes, and the failure is named', async () => {
      // A task that half-exists is worse than one whose leftovers are listed:
      // the record is the only thing that knows where the rest lives, so keeping
      // it on a partial failure just moves the orphan from disk to storage.
      const h = (live = harness({
        tasks: [twoRepos],
        git: (call) => (call.opts.cwd === '/src/api' ? refusesRemoval(call) : OK),
      }));
      const out = await h.run<DeleteResult>('tasks.delete', { task: 't1' });

      expect(out.failed).toEqual(["api: fatal: '/x' is a main working tree"]);
      expect(await h.run<unknown[]>('tasks.list')).toEqual([]);
    });

    it('prunes the SOURCE repo afterwards, because git only prunes a registration whose directory is gone', async () => {
      // The ordering is the fix, not the prune: run before the `rmSync` the
      // directory still answers, git keeps the registration, and the next
      // `worktree add` on that branch fails pointing at a path that no longer
      // exists.
      const h = (live = harness({
        tasks: [twoRepos],
        git: (call) => (call.opts.cwd === '/src/api' ? refusesRemoval(call) : OK),
      }));
      await h.run('tasks.delete', { task: 't1' });

      const prune = h.git.find((call) => call.args[1] === 'prune');
      expect(prune?.args).toEqual(['worktree', 'prune']);
      expect(prune?.opts.cwd).toBe('/src/api');

      // Both indices are asserted present first: `indexOf` answers -1 for a line
      // that never happened, and -1 is less than everything, so a comparison
      // alone would pass loudest exactly when neither call was made.
      const removal = h.trace.indexOf(`git worktree remove --force ${join(h.dataDir, 'fix-login', 'api')}`);
      const pruned = h.trace.indexOf('git worktree prune');
      expect(removal).toBeGreaterThanOrEqual(0);
      expect(pruned).toBeGreaterThan(removal);
    });

    it('prunes ONLY where a removal failed, since a clean removal strands nothing', async () => {
      const h = (live = harness({
        tasks: [twoRepos],
        git: (call) => (call.opts.cwd === '/src/api' ? refusesRemoval(call) : OK),
      }));
      await h.run('tasks.delete', { task: 't1' });
      expect(h.git.filter((call) => call.args[1] === 'prune').map((call) => call.opts.cwd)).toEqual(['/src/api']);
    });
  });

  it('runs NO git at all for an archived task, whose worktrees the archive already removed', async () => {
    // Running `worktree remove` again fails per repo, which made a clean delete
    // report itself as broken — the answer a user would read as data loss.
    const h = (live = harness({ tasks: [task({ lifecycle: 'archived' })] }));
    const out = await h.run<DeleteResult>('tasks.delete', { task: 't1' });

    expect(h.git).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.branchesLeft).toEqual([]);
    expect(await h.run<unknown[]>('tasks.list')).toEqual([]);
  });

  it('closes every pane the task is running in — ADR 0022 makes that the only way a session ends', async () => {
    const h = (live = harness({
      tasks: [
        task({
          sessions: [
            { id: 's1', role: 'orchestrator', pane: 'p1' },
            { id: 's2', role: 'workstream', pane: 'p2' },
            // No pane: it was never mounted, so there is nothing to close and
            // inventing an id to close would address somebody else's pane.
            { id: 's3', role: 'workstream' },
          ],
        }),
      ],
    }));
    await h.run('tasks.delete', { task: 't1' });

    expect(h.invoked.filter((call) => call.id === 'layout.close')).toEqual([
      { id: 'layout.close', args: { pane: 'p1' } },
      { id: 'layout.close', args: { pane: 'p2' } },
    ]);
  });

  it('closes the panes BEFORE it touches the directory they are running in', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));
    await h.run('tasks.delete', { task: 't1' });

    const closed = h.trace.indexOf('invoke layout.close');
    const firstGit = h.trace.findIndex((entry) => entry.startsWith('git '));
    expect(closed).toBeGreaterThanOrEqual(0);
    expect(firstGit).toBeGreaterThan(closed);
  });
});

/**
 * `needs-you`, end to end — the bus to the row.
 *
 * D4 says it is derived at read and never stored, which makes the interesting
 * failures invisible to a unit test of `displayState`: a mirror keyed on the
 * wrong id, a group filter that still passes `[]` while the row it draws does
 * not, a delta nobody nudges the tree about. Every one of those leaves
 * `lifecycle.test.ts` green, so these go through `activate` with a real
 * subscription and the real tree provider.
 *
 * The session below carries a `pending-` id ON PURPOSE: that is what a session
 * looks like for the first seconds after a spawn, and it is exactly when an
 * agent is most likely to ask something. A mirror keyed by session id would
 * drop it.
 */
describe('attention reaching the task tree', () => {
  const attentive = task({ sessions: [{ id: 'pending-1', role: 'orchestrator', pane: 'p1' }] });
  const ASKING = { pane: 'p1', level: 'attention', reason: 'answer needed' };

  it('moves a task to needs-you, in tasks.list AND in the tree’s grouping', async () => {
    const h = (live = harness({ tasks: [attentive] }));
    expect(await listedState(h)).toBe('running');
    expect(await sections(h)).toEqual(['WORKING']);

    h.emit('attention.changed', ASKING);

    expect(await listedState(h)).toBe('needs-you');
    // The heading AND the row: the grouping filter and the row it draws are two
    // separate `displayState` calls, and one of them being left behind is a
    // task drawn as `running` under a NEEDS YOU heading.
    expect(await sections(h)).toEqual(['NEEDS YOU']);
    const rows: readonly TreeItem[] = await h.tree().children(undefined);
    expect(rows.find((row) => row.id === 't1')?.description).toBe('needs-you');
  });

  it('clears back on level "none", which is why the mirror needs no reconciliation', async () => {
    // The store emits `none` on every clear it makes — viewing the pane, closing
    // it, the purge — so an entry that stops mattering always announces itself
    // and nothing here has to go looking.
    const h = (live = harness({ tasks: [attentive] }));
    h.emit('attention.changed', ASKING);
    expect(await listedState(h)).toBe('needs-you');

    h.emit('attention.changed', { pane: 'p1', level: 'none', reason: 'viewed' });

    expect(await listedState(h)).toBe('running');
    expect(await sections(h)).toEqual(['WORKING']);
  });

  it('ignores a pane no task is running in, rather than colouring the nearest one', async () => {
    const h = (live = harness({ tasks: [attentive] }));
    h.emit('attention.changed', { pane: 'p9', level: 'urgent', reason: 'approve Bash' });

    expect(await listedState(h)).toBe('running');
    expect(await sections(h)).toEqual(['WORKING']);
  });

  it('nudges the tree on a delta, because the host only re-reads when asked', async () => {
    // The tree is pull-based: `children()` is re-run on an `onDidChange` and at
    // no other time, so a mirror that updates silently is a sidebar that keeps
    // showing the old grouping until something unrelated happens to change.
    const h = (live = harness({ tasks: [attentive] }));
    let nudges = 0;
    const data = h.tree();
    data.onDidChange?.(() => {
      nudges += 1;
    });

    h.emit('attention.changed', ASKING);
    expect(nudges).toBe(1);

    // The same level again is not a delta — the store re-announces a level with
    // a new reason, and rebuilding the tree for that is work with no change in it.
    h.emit('attention.changed', { ...ASKING, reason: 'plan approval' });
    expect(nudges).toBe(1);
  });
});

/**
 * A spawned pane is named, and the name is the task.
 *
 * Three agents on one task is three identically-titled shells otherwise, which
 * is the state v1's sidebar was built to get out of.
 */
describe('naming the pane a session runs in', () => {
  it('renames the orchestrator’s pane with the task title', async () => {
    const h = (live = harness());
    await h.run('tasks.create', { title: 'Fix login', brief: 'Make it work.', repos: [] });
    await until(() => h.invoked.some((call) => call.id === 'layout.rename'));

    expect(h.invoked.filter((call) => call.id === 'layout.rename')).toEqual([
      { id: 'layout.rename', args: { pane: 'p1', title: 'Fix login' } },
    ]);
    // After the split, necessarily: the pane id is the split's answer.
    expect(h.trace.indexOf('invoke layout.rename')).toBeGreaterThan(h.trace.indexOf('invoke layout.split'));
  });

  it('names a workstream by its repo, since that is what distinguishes it', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', repo: 'api', prompt: 'go' });

    expect(h.invoked.find((call) => call.id === 'layout.rename')?.args).toEqual({
      pane: 'p1',
      title: 'Fix login · api',
    });
  });

  it('falls back to "workstream" for one that runs at the task root', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    expect(h.invoked.find((call) => call.id === 'layout.rename')?.args).toEqual({
      pane: 'p1',
      title: 'Fix login · workstream',
    });
  });

  it('does NOT fail the spawn when the rename fails — the pane is real, the title is decoration', async () => {
    const h = (live = harness({
      tasks: [task()],
      invoke: (id) =>
        id === 'layout.rename'
          ? {
              ok: false,
              error: { code: 'handler-failed', message: 'no such pane', commandId: 'layout.rename' },
            }
          : undefined,
    }));
    const session = await h.run<{ pane?: string; role: string }>('tasks.spawn', { task: 't1', prompt: 'go' });

    expect(session.pane).toBe('p1');
    // And the session is recorded, so the pane is not left running with nothing
    // in the store pointing at it — which is the leak a throw here would make.
    const listed = await h.run<{ sessions: { pane?: string }[] }[]>('tasks.list');
    expect(listed[0]?.sessions.map((entry) => entry.pane)).toEqual(['p1']);
  });
});
