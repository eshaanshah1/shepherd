import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  /**
   * Every command id this extension actually registered.
   *
   * Exposed for one claim: a row's declared actions must name commands that
   * exist. An id that names nothing draws perfectly and fails only when chosen —
   * as `unknown-command`, in a log, with the menu already closed.
   */
  registeredCommands(): ReadonlySet<string>;
  readonly dataDir: string;
  /** A throwaway home — where the Claude Code trust store is read and written. */
  readonly homeDir: string;
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
    /** What `ctx.clock.now()` answers — the archive sweep reads it at activate. */
    now?: number;
    /**
     * Every WARNING the extension writes.
     *
     * D15 says a degraded path reports itself, which makes "did it warn" a real
     * claim rather than logging trivia — and its opposite is a claim too: the
     * closeRoot classifier exists so that the ordinary case (a task that never
     * spawned) produces no line at all, and only a recorder can show that.
     */
    onWarn?: (line: string) => void;
  } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'shepherd-tasks-'));
  // A home of its own, so the trust seeding in `provision` reads and writes a
  // throwaway `.claude.json` and can never reach the developer's real one.
  const homeDir = mkdtempSync(join(tmpdir(), 'shepherd-tasks-home-'));
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
  /**
   * Which roots are live — the one piece of state the layout fakes below share.
   *
   * `layout.openRoot` is idempotent and reports whether it MINTED the root, and
   * that answer is the only thing `startSession` branches on. A fake with no
   * memory would answer `created: true` forever, so every spawn would look like
   * a task's first and the split path would never run in a test.
   */
  const roots = new Set<string>();
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
      // A task owns a ROOT, and `openRoot` mints it once: the first call for a
      // given id creates it and hands back its first pane, every later call
      // answers `created: false` with no side effect — which is exactly what the
      // real command does, and what tells a first spawn from a second.
      if (id === 'layout.openRoot') {
        const root = String((args as { root?: unknown }).root);
        if (roots.has(root)) return { ok: true, value: { root, pane: null, created: false } as never };
        roots.add(root);
        return { ok: true, value: { root, pane: `p${(panes += 1)}`, created: true } as never };
      }
      // A root that was never opened fails the way the real one does — the
      // store's `no root <id>`, wrapped by the registry into `handler-failed`.
      // That exact shape is what the extension classifies as "this task never
      // spawned" and stays silent about, so a fake that answered OK would let
      // the classifier rot untested.
      if (id === 'layout.closeRoot') {
        const root = String((args as { root?: unknown }).root);
        if (!roots.delete(root)) {
          return {
            ok: false,
            error: {
              code: 'handler-failed',
              message: `"layout.closeRoot" failed: no root ${root}`,
              commandId: 'layout.closeRoot',
            },
          } as never;
        }
        return { ok: true, value: { root, closedPanes: 1 } as never };
      }
      // `layout.split` answers with the pane id ITSELF, which is what the kernel
      // returns and what `startSession` records. The blanket `undefined` below
      // would make every spawn key its session on a pane that is not a string,
      // and the tests would agree with each other about nothing. The counter is
      // shared with `openRoot` above, so a pane id names one pane whichever verb
      // opened it.
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
    homeDir,
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log:
      opts.onWarn === undefined
        ? nullLogger.child('extension')
        : { ...nullLogger.child('extension'), warn: opts.onWarn },
    clock: manualClock(opts.now ?? 1),
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
    registeredCommands: () => new Set(registered.keys()),
    dataDir,
    homeDir,
    dispose: () => {
      for (const sub of ctx.subscriptions) sub.dispose();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
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

/**
 * git's answers for an archive that SUCCEEDS.
 *
 * `commit-tree` and `write-tree` have to hand back something that looks like a
 * sha, or `archiveWorktree` refuses ("could not write the archive commit") and
 * every ordering claim downstream of it is vacuous. The `ls-files` calls stay
 * empty on purpose: one asks whether anything is unmerged and the other lists
 * ignored files, and both mean "nothing" when they print nothing.
 */
const archivable = (call: GitCall): ExecOk =>
  call.args[0] === 'ls-files' ? OK : { ok: true, stdout: 'abc123\n', stderr: '' };

interface DeleteResult {
  readonly id: string;
  readonly slug: string;
  readonly branchesLeft: readonly string[];
  readonly failed: readonly string[];
}

/** A task's state as `tasks.list` answers it — the derived one, not the stored one. */
const listedState = async (h: Harness): Promise<string> =>
  (await h.run<{ displayState: string }[]>('tasks.list'))[0]?.displayState ?? 'no such task';

/**
 * A task's row as the tree draws it — where its state shows now that the list
 * is flat. It used to be read off the group HEADINGS; grouping was removed
 * because tasks are independent work and bucketing asserted a relationship
 * between them that does not exist, so the state reaches the row as its tint.
 */
const rowOf = async (h: Harness, id: string): Promise<TreeItem | undefined> =>
  (await h.tree().children(undefined)).find((row) => row.id === id);

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

  it('moves a task to needs-you, in tasks.list AND on its row', async () => {
    const h = (live = harness({ tasks: [attentive] }));
    expect(await listedState(h)).toBe('running');
    expect((await rowOf(h, 't1'))?.tint).toBe('running');

    h.emit('attention.changed', ASKING);

    expect(await listedState(h)).toBe('needs-you');
    // The command's answer AND the row: two separate `displayState` calls, and
    // one being left behind is a sidebar that disagrees with the CLI.
    const row = await rowOf(h, 't1');
    expect(row?.tint).toBe('needs-you');
    expect(row?.description).toBe('needs-you');
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
    expect((await rowOf(h, 't1'))?.tint).toBe('running');
  });

  it('ignores a pane no task is running in, rather than colouring the nearest one', async () => {
    const h = (live = harness({ tasks: [attentive] }));
    h.emit('attention.changed', { pane: 'p9', level: 'urgent', reason: 'approve Bash' });

    expect(await listedState(h)).toBe('running');
    expect((await rowOf(h, 't1'))?.tint).toBe('running');
  });

  it('nudges the tree on a delta, because the host only re-reads when asked', async () => {
    // The tree is pull-based: `children()` is re-run on an `onDidChange` and at
    // no other time, so a mirror that updates silently is a sidebar that keeps
    // showing the old state until something unrelated happens to change.
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
  it('names the orchestrator’s pane AT MINT, with the task title and no second call', async () => {
    const h = (live = harness());
    const created = await h.run<{ id: string }>('tasks.create', {
      title: 'Fix login',
      brief: 'Make it work.',
      repos: [],
    });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    expect(h.invoked.find((call) => call.id === 'layout.openRoot')?.args).toMatchObject({
      root: `task:${created.id}`,
      title: 'Fix login',
    });
    // And NOT renamed afterwards: `openRoot` takes the title, so a rename here
    // would be the same title set twice — one invoke that exists only because
    // nobody noticed the first one had already done it.
    expect(h.invoked.filter((call) => call.id === 'layout.rename')).toEqual([]);
  });

  it('names a workstream by its repo, since that is what distinguishes it', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', repo: 'api', prompt: 'go' });

    expect(h.invoked.find((call) => call.id === 'layout.openRoot')?.args).toMatchObject({
      title: 'Fix login · api',
    });
  });

  it('falls back to "workstream" for one that runs at the task root', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    expect(h.invoked.find((call) => call.id === 'layout.openRoot')?.args).toMatchObject({
      title: 'Fix login · workstream',
    });
  });

  it('renames the SECOND agent’s pane, because a split carries no title', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'first' });
    await h.run('tasks.spawn', { task: 't1', repo: 'api', prompt: 'second' });

    expect(h.invoked.filter((call) => call.id === 'layout.rename')).toEqual([
      { id: 'layout.rename', args: { pane: 'p2', title: 'Fix login · api' } },
    ]);
    // After the split, necessarily: the pane id is the split's answer.
    expect(h.trace.indexOf('invoke layout.rename')).toBeGreaterThan(h.trace.indexOf('invoke layout.split'));
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
    // The first spawn mints the root and is named at mint; only the second goes
    // through `layout.rename`, so it is the one that can see it fail.
    await h.run('tasks.spawn', { task: 't1', prompt: 'first' });
    const session = await h.run<{ pane?: string; role: string }>('tasks.spawn', { task: 't1', prompt: 'go' });

    expect(session.pane).toBe('p2');
    // And the session is recorded, so the pane is not left running with nothing
    // in the store pointing at it — which is the leak a throw here would make.
    const listed = await h.run<{ sessions: { pane?: string }[] }[]>('tasks.list');
    expect(listed[0]?.sessions.map((entry) => entry.pane)).toEqual(['p1', 'p2']);
  });
});

/**
 * A task owns a root — M3c, and the whole of what "landing in a task" means.
 *
 * The interesting claims are all about WHICH layout verb runs and in what
 * order, because every one of them is invisible to a unit test of the pieces:
 * `openRoot` is idempotent and `split` is not, `closeRoot` ends the sessions in
 * a root and the per-session loop does not, and the archive's refusal has to
 * come before anything touches the screen. So the seams are faked and the
 * handlers are real, exactly as `tasks.delete`'s tests above are.
 */
describe('a task owns a layout root', () => {
  it('opens the task’s OWN root for the first agent, with its cwd and the line to type', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    const opened = h.invoked.find((call) => call.id === 'layout.openRoot')?.args as {
      root: string;
      cwd: string;
      initialCommand: string;
    };
    expect(opened.root).toBe('task:t1');
    expect(opened.cwd).toBe(join(h.dataDir, 'fix-login'));
    // The prompt rides a FILE that the typed line reads back and deletes — one
    // line, because a newline is an Enter press.
    expect(opened.initialCommand).toContain('cat ');
    // And no split: the root did not exist, so there was nothing to split into.
    expect(h.invoked.filter((call) => call.id === 'layout.split')).toEqual([]);
  });

  it('splits into the SAME root for the second agent, rather than opening a second one', async () => {
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'first' });
    await h.run('tasks.spawn', { task: 't1', repo: 'api', prompt: 'second' });

    // Named explicitly: an unqualified split means "the root I am looking at",
    // and a spawn from the CLI while another task is on screen must not open a
    // pane in somebody else's task.
    expect(h.invoked.filter((call) => call.id === 'layout.split').map((call) => call.args)).toEqual([
      { axis: 'row', root: 'task:t1', cwd: join(h.dataDir, 'fix-login', 'api'), initialCommand: expect.any(String) },
    ]);
  });

  it('LANDS you in the task — every spawn switches to its root', async () => {
    // v1's composer behaviour: you asked for work, so you are taken to it. A
    // pane opened in a root nobody switched to is an agent running off screen.
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    expect(h.invoked.filter((call) => call.id === 'layout.switchRoot')).toEqual([
      { id: 'layout.switchRoot', args: { root: 'task:t1' } },
    ]);
    // After the pane exists, or the window moves to a root with nothing in it.
    expect(h.trace.indexOf('invoke layout.switchRoot')).toBeGreaterThan(
      h.trace.indexOf('invoke layout.openRoot'),
    );
  });

  it('does NOT fail the spawn when the switch fails — the agent is running either way', async () => {
    const h = (live = harness({
      tasks: [task()],
      invoke: (id) =>
        id === 'layout.switchRoot'
          ? { ok: false, error: { code: 'handler-failed', message: 'no root', commandId: 'layout.switchRoot' } }
          : undefined,
    }));
    const session = await h.run<{ pane?: string }>('tasks.spawn', { task: 't1', prompt: 'go' });
    expect(session.pane).toBe('p1');
  });

  describe('tasks.reveal', () => {
    it('switches to the task’s root', async () => {
      const h = (live = harness({ tasks: [task()] }));
      await h.run('tasks.spawn', { task: 't1', prompt: 'go' });
      const before = h.invoked.length;

      await h.run('tasks.reveal', { task: 't1' });

      expect(h.invoked.slice(before).filter((call) => call.id === 'layout.switchRoot')).toEqual([
        { id: 'layout.switchRoot', args: { root: 'task:t1' } },
      ]);
    });

    it('OPENS the root first when there is none — a task that never spawned is still somewhere', async () => {
      // A plain shell at the task's own directory is the honest "here is your
      // task": no `initialCommand`, because starting an agent would spend a
      // session on a glance.
      const h = (live = harness({ tasks: [task()] }));
      await h.run('tasks.reveal', { task: 't1' });

      const opened = h.invoked.find((call) => call.id === 'layout.openRoot')?.args as {
        root: string;
        cwd: string;
        initialCommand?: string;
      };
      expect(opened).toMatchObject({ root: 'task:t1', cwd: join(h.dataDir, 'fix-login') });
      expect(opened.initialCommand).toBeUndefined();
      expect(h.trace.indexOf('invoke layout.switchRoot')).toBeGreaterThan(
        h.trace.indexOf('invoke layout.openRoot'),
      );
    });

    it('refuses an unknown task BY NAME, rather than switching to a root that means nothing', async () => {
      const h = (live = harness({ tasks: [task()] }));
      await expect(h.run('tasks.reveal', { task: 'ghost' })).rejects.toThrow('ghost');
      expect(h.invoked.filter((call) => call.id === 'layout.switchRoot')).toEqual([]);
    });
  });

  describe('closing the root when a task ends', () => {
    it('closes the task’s root BEFORE delete touches the disk its panes are running on', async () => {
      const h = (live = harness({ tasks: [task()] }));
      await h.run('tasks.spawn', { task: 't1', prompt: 'go' });
      // The spawn's own trace is dropped, so the indices below are the delete's.
      const spawned = h.trace.length;
      await h.run('tasks.delete', { task: 't1' });
      const deleting = h.trace.slice(spawned);

      const closed = deleting.indexOf('invoke layout.closeRoot');
      const firstGit = deleting.findIndex((entry) => entry.startsWith('git '));
      // Both indices asserted present first: `indexOf` answers -1 for a line
      // that never happened, and -1 is less than everything, so a comparison
      // alone would pass loudest when neither call was made.
      expect(closed).toBeGreaterThanOrEqual(0);
      expect(firstGit).toBeGreaterThanOrEqual(0);
      expect(firstGit).toBeGreaterThan(closed);
    });

    it('keeps the per-session close as well, for panes that were never in the root', async () => {
      // Idempotent, and not redundant: a record from before a task owned a root
      // — or a pane moved elsewhere — has a session `closeRoot` cannot reach.
      const h = (live = harness({
        tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p9' }] })],
      }));
      await h.run('tasks.delete', { task: 't1' });

      expect(h.invoked.filter((call) => call.id === 'layout.close')).toEqual([
        { id: 'layout.close', args: { pane: 'p9' } },
      ]);
    });

    it('says NOTHING when the task never spawned, because that is the ordinary case', async () => {
      // A draft deleted the day it was created never opened a root. Warning
      // about it would put a line in the log for the most common thing this
      // verb does — and the extension has only the message text to tell that
      // from a real failure, so the classifier is worth a test of its own.
      const warnings: string[] = [];
      const h = (live = harness({ tasks: [task()], onWarn: (line) => warnings.push(line) }));
      await h.run('tasks.delete', { task: 't1' });

      expect(h.invoked.some((call) => call.id === 'layout.closeRoot')).toBe(true);
      expect(warnings.filter((line) => line.includes('root'))).toEqual([]);
    });

    it('WARNS when the root refuses for any other reason', async () => {
      const warnings: string[] = [];
      const h = (live = harness({
        tasks: [task()],
        onWarn: (line) => warnings.push(line),
        invoke: (id) =>
          id === 'layout.closeRoot'
            ? {
                ok: false,
                error: {
                  code: 'handler-failed',
                  message: '"layout.closeRoot" failed: task:t1 is the home root and cannot be closed',
                  commandId: 'layout.closeRoot',
                },
              }
            : undefined,
      }));
      await h.run('tasks.delete', { task: 't1' });

      expect(warnings.some((line) => line.includes('its root was not closed'))).toBe(true);
    });

    it('archives by closing the root AFTER the worktrees are snapshotted', async () => {
      const h = (live = harness({ tasks: [task()], git: archivable }));
      await h.run('tasks.spawn', { task: 't1', prompt: 'go' });
      await h.run('tasks.archive', { task: 't1' });

      const removed = h.trace.lastIndexOf(`git worktree remove --force ${join(h.dataDir, 'fix-login', 'api')}`);
      const closed = h.trace.lastIndexOf('invoke layout.closeRoot');
      expect(removed).toBeGreaterThanOrEqual(0);
      expect(closed).toBeGreaterThan(removed);
    });

    it('REFUSES a conflicted worktree before it closes anything', async () => {
      // git cannot write a tree from a conflicted index, so the archive fails —
      // and a refusal that had already closed the task's panes would leave the
      // work on disk with no agent left to finish resolving it.
      const h = (live = harness({
        tasks: [task()],
        git: (call) =>
          call.args[0] === 'ls-files' && call.args[1] === '-u'
            ? { ok: true, stdout: '100644 abc 1\tREADME.md\n', stderr: '' }
            : OK,
      }));
      await h.run('tasks.spawn', { task: 't1', prompt: 'go' });
      const before = h.invoked.length;

      await expect(h.run('tasks.archive', { task: 't1' })).rejects.toThrow('unmerged');
      expect(h.invoked.slice(before).filter((call) => call.id === 'layout.closeRoot')).toEqual([]);
    });
  });
});

describe('a pane that closes', () => {
  // The bug this pins: closing a pane left the task reporting `running` for a
  // session that no longer existed, because nothing subscribed to the kernel's
  // own `session.exit` — the sidebar's one job, stated wrongly.
  it('drops the session and ARCHIVES the task, because the last pane closing means done', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));
    expect(await listedState(h)).toBe('running');

    h.emit('session.exit', { sessionId: 's1', paneId: 'p1' });
    await until(() => h.invoked.some((call) => call.id === 'tasks.archive'));

    expect((await h.run<{ sessions: unknown[] }[]>('tasks.list'))[0]?.sessions).toEqual([]);
    // Archive, not delete: the worktrees are snapshotted first, so every
    // uncommitted line survives a gesture that looks like throwing work away.
    expect(h.invoked.find((call) => call.id === 'tasks.archive')?.args).toEqual({ task: 't1' });
  });

  it('does NOT archive while any other session is left — closing one pane is not finishing', async () => {
    const h = (live = harness({
      tasks: [
        task({
          sessions: [
            { id: 's1', role: 'orchestrator', pane: 'p1' },
            { id: 's2', role: 'workstream', pane: 'p2' },
          ],
        }),
      ],
    }));

    h.emit('session.exit', { sessionId: 's1', paneId: 'p1' });

    expect(await listedState(h)).toBe('running');
    expect((await h.run<{ sessions: unknown[] }[]>('tasks.list'))[0]?.sessions).toHaveLength(1);
    expect(h.invoked.some((call) => call.id === 'tasks.archive')).toBe(false);
  });

  it('matches on the PANE, since a dying session may still be a pending- id', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 'pending-9', role: 'orchestrator', pane: 'p1' }] })],
    }));

    h.emit('session.exit', { sessionId: 'some-real-id', paneId: 'p1' });

    expect((await h.run<{ sessions: unknown[] }[]>('tasks.list'))[0]?.sessions).toEqual([]);
  });
});

describe('archives that have run out', () => {
  // Thirty days, swept at startup. The record is written by `tasks.archive`
  // with `archivedAt`, so what this pins is the sweep firing the same delete a
  // human would — no second removal path to keep in step.
  const DAY = 86_400_000;

  it('deletes an archive older than thirty days, through the ordinary verb', async () => {
    const h = (live = harness({
      tasks: [task({ id: 'old', lifecycle: 'archived', archivedAt: 1_000, sessions: [] })],
      now: 1_000 + 31 * DAY,
    }));
    await until(() => h.invoked.some((call) => call.id === 'tasks.delete'));
    expect(h.invoked.find((call) => call.id === 'tasks.delete')?.args).toEqual({ task: 'old' });
  });

  it('leaves one archived yesterday alone', async () => {
    const h = (live = harness({
      tasks: [task({ id: 'fresh', lifecycle: 'archived', archivedAt: 1_000, sessions: [] })],
      now: 1_000 + DAY,
    }));
    // A tick is enough: the sweep runs synchronously inside activate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.invoked.some((call) => call.id === 'tasks.delete')).toBe(false);
  });
});

/**
 * A task row's CONTEXT MENU, declared by this extension.
 *
 * The shell cannot know a task's verbs — a sidebar that hardcoded Reveal /
 * Archive / Delete would be a sidebar that knows what a task is, which is the
 * special case ADR 0031 exists to prevent. So they ride the row, and every one
 * of them is a command id this extension registered, run attributed to this
 * extension (D14) rather than to the user.
 */
describe('the actions a task row declares', () => {
  it('offers reveal, archive and delete, each naming its own task', async () => {
    const h = await harness();
    const created = await h.run<{ id: string }>('tasks.create', { title: 'Ship the login fix' });
    const row = await rowOf(h, created.id);

    expect(row?.actions).toEqual([
      { id: 'tasks.reveal', label: 'Reveal', icon: 'eye', args: { task: created.id } },
      { separator: true },
      { id: 'tasks.archive', label: 'Archive', icon: 'archive', danger: true, args: { task: created.id } },
      { id: 'tasks.delete', label: 'Delete', icon: 'trash', danger: true, args: { task: created.id } },
    ]);
  });

  it('marks exactly the destructive two', async () => {
    const h = await harness();
    const created = await h.run<{ id: string }>('tasks.create', { title: 'a' });
    const row = await rowOf(h, created.id);
    const danger = (row?.actions ?? [])
      .filter((entry): entry is { id: string; label: string; danger?: boolean } => !('separator' in entry))
      .filter((entry) => entry.danger === true)
      .map((entry) => entry.id);
    expect(danger).toEqual(['tasks.archive', 'tasks.delete']);
  });

  /**
   * MUTATION TARGET. An action id that names no registered command would draw
   * perfectly and fail only when chosen — as `unknown-command`, in a log, with
   * the menu already closed. Every id here is checked against the table this
   * extension actually registered.
   */
  it('names only commands this extension registered', async () => {
    const h = await harness();
    const created = await h.run<{ id: string }>('tasks.create', { title: 'a' });
    const row = await rowOf(h, created.id);
    for (const entry of row?.actions ?? []) {
      if ('separator' in entry) continue;
      expect(h.registeredCommands().has(entry.id), entry.id).toBe(true);
    }
  });
});

/**
 * The generated task root is pre-trusted before any agent opens in it.
 *
 * Measured, not assumed: Claude Code opens on *"Quick safety check: Is this a
 * project you created or one you trust?"* in a directory it has not seen, and a
 * task root is by construction a directory that did not exist a second ago — so
 * the orchestrator this extension spawns would sit on a dialog forever. The
 * shape of the record and every degradation live in `trust.test.ts`; what is
 * claimed here is that provisioning does it, for the right paths, in time.
 */
describe('pre-trusting the directories it generates', () => {
  const configOf = (h: Harness): Record<string, unknown> =>
    JSON.parse(readFileSync(join(h.homeDir, '.claude.json'), 'utf8')) as Record<string, unknown>;

  it('trusts the task root, so the orchestrator starts instead of waiting on a dialog', async () => {
    const h = (live = harness());
    writeFileSync(join(h.homeDir, '.claude.json'), '{}', 'utf8');

    const created = await h.run<{ id: string }>('tasks.create', { title: 'Fix login', repos: [] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const projects = configOf(h)['projects'] as Record<string, unknown>;
    expect(projects[join(h.dataDir, 'fix-login')]).toEqual({ hasTrustDialogAccepted: true });
    expect(created.id).toBeTruthy();
  });

  it('trusts a repo worktree too, since that is where a workstream agent runs', async () => {
    const h = (live = harness());
    writeFileSync(join(h.homeDir, '.claude.json'), '{}', 'utf8');

    await h.run('tasks.create', {
      title: 'Fix login',
      repos: [{ name: 'api', path: '/src/api' }],
    });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const projects = configOf(h)['projects'] as Record<string, unknown>;
    expect(projects[join(h.dataDir, 'fix-login', 'api')]).toEqual({ hasTrustDialogAccepted: true });
  });

  it('trusts nothing but what it made — never the source repo', async () => {
    // The narrowness IS the feature. Shepherd created the task root and can say
    // so honestly; it did not create the user's checkout and has no standing to
    // answer for it.
    const h = (live = harness());
    writeFileSync(join(h.homeDir, '.claude.json'), '{}', 'utf8');

    await h.run('tasks.create', {
      title: 'Fix login',
      repos: [{ name: 'api', path: '/src/api' }],
    });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const projects = configOf(h)['projects'] as Record<string, unknown>;
    // Both spellings of the data dir count as ours: the realpath is written too,
    // because Claude Code resolves symlinks before it looks a directory up — and
    // on macOS the temp dir these tests run in is itself behind one.
    const mine = [h.dataDir, realpathSync(h.dataDir)];
    for (const key of Object.keys(projects)) {
      expect(mine.some((dir) => key.startsWith(dir)), key).toBe(true);
    }
    expect(projects['/src/api']).toBeUndefined();
  });

  it('provisions anyway when there is no config to seed', async () => {
    // A machine that has never run Claude Code has no agent to unblock, and the
    // task is not the trust record's to fail.
    const warnings: string[] = [];
    const h = (live = harness({ onWarn: (line) => warnings.push(line) }));

    await h.run('tasks.create', { title: 'Fix login', repos: [] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    // And it says so, because a skipped pre-trust is why an agent is sitting on
    // a prompt.
    expect(warnings.some((line) => line.includes('trust prompt'))).toBe(true);
  });
});

describe('finished work', () => {
  // Closing a task archives it (its own test above). This is what the sidebar
  // then does with it, and what clicking it does — the two halves of the
  // gesture being safe to make casually.
  const archived = (id: string): TaskRecord =>
    task({ id, title: `T ${id}`, lifecycle: 'archived', archivedAt: 5, sessions: [] });

  it('puts archived tasks under a DONE heading at the bottom, not among live work', async () => {
    const h = (live = harness({ tasks: [archived('old'), task({ id: 'now', title: 'T now' })] }));
    const rows = await h.tree().children(undefined);

    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(['now', 'group:done', 'old']);
    expect(rows.find((row) => row.id === 'group:done')?.section).toBe(true);
  });

  it('draws no DONE heading when nothing is finished', async () => {
    const h = (live = harness({ tasks: [task({ id: 'now' })] }));
    const rows = await h.tree().children(undefined);
    expect(rows.some((row) => row.section === true)).toBe(false);
  });

  it('offers Restore where a live task offers Archive', async () => {
    const h = (live = harness({ tasks: [archived('old'), task({ id: 'now' })] }));
    const rows = await h.tree().children(undefined);
    const labels = (id: string): unknown[] =>
      (rows.find((row) => row.id === id)?.actions ?? []).map((a) =>
        'separator' in a ? '—' : a.label,
      );

    expect(labels('old')).toEqual(['Restore', '—', 'Delete']);
    expect(labels('now')).toEqual(['Reveal', '—', 'Archive', 'Delete']);
  });

  it('brings an archived task BACK when it is revealed, before opening its root', async () => {
    // Opening a root at a directory whose worktrees were removed would show an
    // empty shell — the app pretending the task is there.
    const h = (live = harness({ tasks: [archived('old')] }));
    await h.run('tasks.reveal', { task: 'old' });

    const order = h.invoked.map((call) => call.id);
    expect(order).toContain('tasks.restore');
    expect(order.indexOf('tasks.restore')).toBeLessThan(order.indexOf('layout.openRoot'));
  });

  it('does not restore a live task on the way to revealing it', async () => {
    const h = (live = harness({ tasks: [task({ id: 'now' })] }));
    await h.run('tasks.reveal', { task: 'now' });
    expect(h.invoked.some((call) => call.id === 'tasks.restore')).toBe(false);
  });
});

describe('what archiving leaves on disk', () => {
  // The worktrees were removed and the generated root was not, so an archived
  // task left a directory you could still `cd` into, describing work that is no
  // longer there — and one such directory per task, forever.
  it('takes the generated task root with it', async () => {
    const h = (live = harness({ tasks: [task({ id: 't1', repos: [] })] }));
    const root = `${h.dataDir}/fix-login`;
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/CLAUDE.md`, '# generated');

    await h.run('tasks.archive', { task: 't1' });

    expect(existsSync(root)).toBe(false);
  });
});
