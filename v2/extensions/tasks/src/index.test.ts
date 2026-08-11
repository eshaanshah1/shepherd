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
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  REPO_PROVISIONED_POINT,
  TASK_PROVISIONED_POINT,
  type RepoProvisioned,
  type RepoProvisionedFact,
  type TaskProvisioned,
  type TaskProvisionedFact,
} from './manifest.ts';
import { TASK_SCHEMA_VERSION, type TaskRecord, type TaskSession } from './store.ts';
import { taskRootId } from './model/root-id.ts';

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
  /**
   * A point this extension DEFINED, so a test can register into it the way
   * another extension would. Throws rather than answering `undefined`: a seam
   * that was renamed should fail by name here, not by a silent no-op later.
   */
  point<T>(id: string): ExtensionPoint<T>;
  readonly dataDir: string;
  /** A throwaway home — where the Claude Code trust store is read and written. */
  readonly homeDir: string;
  dispose(): void;
}

function harness(
  opts: {
    tasks?: readonly TaskRecord[];
    /**
     * A promise is allowed so a test can HOLD a call open and ask what the app
     * looks like mid-operation — which is the only way to assert a spinner.
     */
    git?: (call: GitCall) => ExecOk | ExecErr | Promise<ExecOk | ExecErr>;
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
      if (id === 'layout.closeGroup') {
        const group = String((args as { group?: unknown }).group);
        if (!roots.delete(group)) {
          return {
            ok: false,
            error: {
              code: 'handler-failed',
              message: `"layout.closeGroup" failed: no group ${group}`,
              commandId: 'layout.closeGroup',
            },
          } as never;
        }
        return { ok: true, value: { group, closedRoots: 1, closedPanes: 1 } as never };
      }
      // `layout.split` answers with the pane id ITSELF, which is what the kernel
      // returns and what `startSession` records. The blanket `undefined` below
      // would make every spawn key its session on a pane that is not a string,
      // and the tests would agree with each other about nothing. The counter is
      // shared with `openRoot` above, so a pane id names one pane whichever verb
      // opened it.
      if (id === 'layout.split') return { ok: true, value: `p${(panes += 1)}` as never };
      /**
       * The AGENT extension answers this, not `tasks` (ADR 0036 §3).
       *
       * The seam is a three-way split: `tasks` decides WHETHER to resume, the
       * agents layer decides WHICH kind, and the kind decides HOW. This fake
       * stands in for the last two — and it is why the assertion below can check
       * that `tasks` never spells `claude` itself.
       */
      /**
       * Which sessions are actually running.
       *
       * `tasks.reveal` checks a recorded session against this before presenting
       * it, because a record outlives the ptys it names. The fake answers with
       * whatever the tasks under test claim, which is the "still running" case;
       * the "no longer running" case overrides it to `[]`.
       */
      if (id === 'sessions.list') {
        return {
          ok: true,
          value: (opts.tasks ?? []).flatMap((t) =>
            (t.sessions ?? []).map((session) => ({ id: session.id, paneId: session.pane })),
          ) as never,
        };
      }
      if (id === 'agents.resumeCommand') {
        const target = String((args as { target?: unknown }).target);
        return { ok: true, value: { command: `claude --resume '${target}'` } as never };
      }
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

  // Kept, rather than made and forgotten, so a test can play the OTHER extension
  // and register into a point this one defines — which is the only way to assert
  // that a seam is reached at all.
  const defined = new Map<string, ExtensionPoint<unknown>>();
  const points: PointsAPI = {
    define: <T>(id: string): ExtensionPoint<T> => {
      const providers: T[] = [];
      const point: ExtensionPoint<T> = {
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
      defined.set(id, point as ExtensionPoint<unknown>);
      return point;
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
    userName: 'ada',
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
    point: <T>(id: string): ExtensionPoint<T> => {
      const found = defined.get(id);
      if (found === undefined) throw new Error(`no point ${id} was defined`);
      return found as ExtensionPoint<T>;
    },
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
async function until(holds: () => boolean | Promise<boolean>, ticks = 50): Promise<void> {
  for (let attempt = 0; attempt < ticks; attempt += 1) {
    if (await holds()) return;
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

  it('goes blue while an agent works, in tasks.list AND on its row', async () => {
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('working'));

    // The command's answer AND the row: two separate `displayState` calls, and
    // one being left behind is a sidebar that disagrees with the CLI.
    expect(await listedState(h)).toBe('working');
    const row = await rowOf(h, 't1');
    expect(row?.tint).toBe('working');
    expect(row?.description).toBe('working');
  });

  it('turns a finished turn GREEN, and not the amber a blocked one gets', async () => {
    // v1's behaviour, and the palette's own words: `pasture` is "done / success",
    // `hay` is "blocked / attention". One amber for both would make "finished"
    // and "waiting on you" the same dot.
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('needsCheck', { turnFinished: true, level: 'attention' }));

    expect((await rowOf(h, 't1'))?.tint).toBe('needs-check');

    h.emit('agents.stateChanged', change('blocked', { from: 'needsCheck' }));
    expect((await rowOf(h, 't1'))?.tint).toBe('blocked');
  });

  it('goes back to idle when the agent is viewed, which rides the same topic', async () => {
    // `registry.observeViewed` writes needsCheck -> idle and emits it, so the
    // clear needs no second channel — which is what lets the attention mirror go.
    const h = (live = harness({ tasks: [spawned] }));
    h.emit('agents.stateChanged', change('needsCheck', { turnFinished: true }));
    expect((await rowOf(h, 't1'))?.tint).toBe('needs-check');

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

    expect(await listedState(h)).toBe('idle');
    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('drops a change with no pane rather than keying the mirror on undefined', async () => {
    // A payload that crossed a port. An entry keyed on `undefined` could never
    // be cleared, because no later change can name that key.
    const h = (live = harness({ tasks: [spawned] }));
    const { pane: _dropped, ...noPane } = change('blocked');
    h.emit('agents.stateChanged', noPane);

    expect((await rowOf(h, 't1'))?.tint).toBe('idle');
  });

  it('nudges the tree on a delta, because the host only re-reads when asked', async () => {
    // The tree is pull-based: `children()` is re-run on an `onDidChange` and at
    // no other time, so a mirror that updates silently is a sidebar that keeps
    // showing the old state until something unrelated happens to change.
    const h = (live = harness({ tasks: [spawned] }));
    let nudges = 0;
    const data = h.tree();
    data.onDidChange?.(() => {
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

      const closed = deleting.indexOf('invoke layout.closeGroup');
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

      expect(h.invoked.some((call) => call.id === 'layout.closeGroup')).toBe(true);
      expect(warnings.filter((line) => line.includes('pane group'))).toEqual([]);
    });

    it('WARNS when the root refuses for any other reason', async () => {
      const warnings: string[] = [];
      const h = (live = harness({
        tasks: [task()],
        onWarn: (line) => warnings.push(line),
        invoke: (id) =>
          id === 'layout.closeGroup'
            ? {
                ok: false,
                error: {
                  code: 'handler-failed',
                  message: '"layout.closeGroup" failed: no such thing',
                  commandId: 'layout.closeGroup',
                },
              }
            : undefined,
      }));
      await h.run('tasks.delete', { task: 't1' });

      expect(warnings.some((line) => line.includes('its pane group was not closed'))).toBe(true);
    });

    it('archives by closing the root AFTER the worktrees are snapshotted', async () => {
      const h = (live = harness({ tasks: [task()], git: archivable }));
      await h.run('tasks.spawn', { task: 't1', prompt: 'go' });
      await h.run('tasks.archive', { task: 't1' });

      const removed = h.trace.lastIndexOf(`git worktree remove --force ${join(h.dataDir, 'fix-login', 'api')}`);
      const closed = h.trace.lastIndexOf('invoke layout.closeGroup');
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
  it('drops the session from the record', async () => {
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

    expect((await h.run<{ sessions: unknown[] }[]>('tasks.list'))[0]?.sessions).toHaveLength(1);
  });

  it('does NOT archive on a session exit — the layout decides that, not a count', async () => {
    /*
     * The shipped bug, pinned. This counted the task's own recorded panes down
     * to zero, and pane ids are REGENERATED when a layout is restored: after a
     * relaunch the record names panes that do not exist, so the count never
     * reaches zero and closing the last pane archived nothing. The count is
     * gone; `layout.rootClosed` is the trigger, and it holds across restarts.
     */
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));

    h.emit('session.exit', { sessionId: 's1', paneId: 'p1' });
    await Promise.resolve();

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

describe('restoring a task', () => {
  const withAgent = task({
    lifecycle: 'archived',
    sessions: [{ id: 's1', role: 'orchestrator', resumeTarget: 'claude-abc' }],
  });

  it('REATTACHES the agent instead of starting a new one on the brief', async () => {
    /*
     * The bug: a restored task opened a fresh agent typed with the original
     * brief — the same words with none of the transcript, which reads as the
     * agent having forgotten everything it did. The target was captured when
     * the task was archived and goes back unread (D11).
     */
    const h = (live = harness({ tasks: [withAgent] }));

    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const opened = h.invoked.find((call) => call.id === 'layout.openRoot');
    expect((opened?.args as { initialCommand?: string }).initialCommand).toBe(
      "claude --resume 'claude-abc'",
    );
    // …and it came from the AGENT layer rather than from here. `tasks` used to
    // build this string itself; R1 moved it to the kind, so the command in the
    // assertion above is the fake agent's, not this extension's.
    expect(h.invoked.some((call) => call.id === 'agents.resumeCommand')).toBe(true);
  });

  /**
   * The rule ADR 0036 §3 finishes: the target was already opaque here, and now
   * so are the binary and the flag around it.
   */
  /**
   * The effect channel (Fable's amendment, and the crux of the phone design).
   *
   * `reveal` is "the whole of what clicking a row means", and everything it does
   * — open a root, switch to it — is a DESKTOP gesture. A phone recovering the
   * intent by matching this command's id would have hardcoded `tasks`, which is
   * the special case ADR 0031 exists to prevent, smuggled in through the client
   * instead of the shell. So the verb names what it wanted PRESENTED, and each
   * renderer decides what that means on its own surface.
   */
  it('says what to PRESENT, so a client need not know what a task is', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));

    const revealed = await h.run<{ present?: unknown }>('tasks.reveal', { task: 't1' });

    // A session, named in terms core owns — not a task, not a root, not a pane.
    expect(revealed.present).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('presents nothing when the task has no live agent, rather than an empty terminal', async () => {
    const h = (live = harness({ tasks: [task({ sessions: [] })] }));
    const revealed = await h.run<{ present?: unknown }>('tasks.reveal', { task: 't1' });
    // The truth, rather than a terminal pretending there is something in it.
    expect(revealed.present).toBeUndefined();
  });

  /**
   * A record outlives the ptys it names — the daemon restarts, a session exits.
   * Presenting a dead one told a phone to open a terminal that could never
   * paint, with nothing reporting a fault because nothing had failed.
   */
  it('does NOT present a recorded session that has since stopped running', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
      // The kernel says nothing is running, whatever the record claims.
      invoke: (id) => (id === 'sessions.list' ? { ok: true, value: [] as never } : undefined),
    }));

    const revealed = await h.run<{ present?: unknown }>('tasks.reveal', { task: 't1' });
    expect(revealed.present).toBeUndefined();
  });

  it('never spells the agent binary itself when resuming', async () => {
    const h = (live = harness({ tasks: [withAgent] }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const asked = h.invoked.find((call) => call.id === 'agents.resumeCommand');
    // What leaves this extension is a TOKEN. Everything about how to run it
    // comes back from the kind.
    expect(asked?.args).toEqual({ target: 'claude-abc' });
    expect(h.invoked.some((call) => call.id.startsWith('claudeCode.'))).toBe(false);
  });

  it('asks the AGENT extension for the target, never a vendor by name', async () => {
    // A task that invoked `claudeCode.*` would be a task that knows which agent
    // it hired. The verb is `agents.resumeTarget` and the value is opaque here.
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
      git: archivable,
    }));

    await h.run('tasks.archive', { task: 't1' });

    expect(h.invoked.some((call) => call.id === 'agents.resumeTarget')).toBe(true);
    expect(h.invoked.some((call) => call.id.startsWith('claudeCode.'))).toBe(false);
  });

  it('leaves a session with nothing to resume alone rather than re-prompting it', async () => {
    // An agent that cannot be reattached to is one there is nothing to restore.
    // Starting it fresh is the behaviour being fixed; `tasks.spawn` is right
    // there when a new agent is what you want.
    const h = (live = harness({
      tasks: [task({ lifecycle: 'archived', sessions: [{ id: 's1', role: 'orchestrator' }] })],
    }));

    await h.run('tasks.restore', { task: 't1' });
    // The re-provision is deliberately not awaited by the verb (D12), so give
    // it the ticks it needs to have opened a pane if it were going to.
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.invoked.some((call) => call.id === 'layout.openRoot')).toBe(false);
  });
});

describe('a long operation', () => {
  it('says so on the row, with the app’s working indicator, and stops when it ends', async () => {
    // The seconds git takes are seconds a row that says nothing is a row you
    // press again. A word and a spinner, never a bar: `worktree add` and a
    // snapshot commit report no progress, so a denominator would be invented.
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = (live = harness({
      tasks: [task()],
      // `write-tree` is the archive's first read, held open so the row can be
      // asked what it looks like mid-operation. Everything else answers as
      // `archivable` does, or the archive refuses and the test is vacuous.
      git: (call) => (call.args[0] === 'write-tree' ? held.then(() => archivable(call)) : archivable(call)),
    }));

    const archiving = h.run('tasks.archive', { task: 't1' });
    const during = await rowOf(h, 't1');
    expect(during?.busy).toBe(true);
    expect(during?.description).toBe('archiving…');

    finish();
    await archiving;
    expect((await rowOf(h, 't1'))?.busy).toBeUndefined();
  });

  it('says so while a NEW task is being provisioned, which is the longest of them', async () => {
    // The one a user actually waits on: `tasks.create` answers immediately and
    // the worktrees land behind it (D12), so between the row appearing and the
    // agent opening there are git-shaped seconds. It read as an idle draft —
    // the row was drawn, nothing said it was mid-anything, and the app looked
    // like it had done nothing.
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = (live = harness({
      // `fetch` is the first call `provisionRepo` makes, held open so the row
      // can be asked what it looks like while the worktree is being built.
      git: (call) => (call.args[0] === 'fetch' ? held.then(() => OK) : OK),
    }));

    await h.run('tasks.create', { title: 'Ship it', repos: [{ path: '/src/app', name: 'app' }] });
    const during = (await h.tree().children(undefined))[0];
    expect(during?.busy).toBe(true);

    finish();
    await until(async () => (await rowOf(h, String(during?.id)))?.busy === undefined);
  });

  it('keeps saying "restoring" after the re-provision inside it finishes', async () => {
    // Restoring wraps a provision, so the two spans nest. An inner `finally`
    // that DELETED the word would drop the row back to idle at the halfway
    // mark — and the half it drops during is the archive replay, which is the
    // part that puts the user's uncommitted work back.
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = (live = harness({
      tasks: [
        task({
          lifecycle: 'archived',
          archives: [
            { repo: 'api', branch: 'fix', headSha: 'abc123', commit: 'def456', stagedTree: 'aaa111' },
          ],
        }),
      ],
      // `read-tree` belongs to the archive replay and to nothing else, so it
      // can only run once the provision inside the restore has come and gone —
      // which is exactly where the inner span ended. (`symbolic-ref` looks like
      // the earlier marker and is not: `provisionRepo` probes the default base
      // with one, so holding it stops the provision instead.)
      git: (call) => (call.args[0] === 'read-tree' ? held.then(() => OK) : OK),
    }));

    await h.run('tasks.restore', { task: 't1' });
    await until(async () => h.git.some((call) => call.args[0] === 'read-tree'));

    const during = await rowOf(h, 't1');
    expect(during?.busy).toBe(true);
    expect(during?.description).toBe('restoring…');

    finish();
    await until(async () => (await rowOf(h, 't1'))?.busy === undefined);
  });
});

describe('a task row', () => {
  it('names the layout root it stands for, so the shell can tell it is the one on screen', async () => {
    // The row says WHICH root it is, and stops there. Whether that root is the
    // one on screen is the layout's fact and the shell reads it from the same
    // snapshot it draws the stage from — so the highlight and the visible pane
    // cannot disagree, which is the whole defect.
    //
    // Mirroring the active root in here instead would be a second copy of a
    // kernel fact living in another process: the same disease as the click-
    // written selection this replaces, one process along.
    const h = (live = harness({ tasks: [task({ id: 't1' }), task({ id: 't2', slug: 'other' })] }));

    expect((await rowOf(h, 't1'))?.root).toBe(taskRootId('t1'));
    expect((await rowOf(h, 't2'))?.root).toBe(taskRootId('t2'));
  });

  it('names it even while archived, because reopening it is what a click does', async () => {
    // An archived task has no live root, but clicking it restores one AT THE
    // SAME ID (`tasks.reveal`), so the row identifies the same root throughout.
    // Withholding it while archived would blank the highlight for the first
    // moments after a restore — exactly when the window has just moved there.
    const h = (live = harness({ tasks: [task({ id: 't1', lifecycle: 'archived' })] }));

    expect((await rowOf(h, 't1'))?.root).toBe(taskRootId('t1'));
  });
});

describe('a task owns a pane GROUP', () => {
  it('opens its root as the anchor of its own group', async () => {
    // One string, two roles: `task:t1` is the task's first tab AND the name of
    // the group every later tab of it joins.
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    const opened = h.invoked.find((call) => call.id === 'layout.openRoot');
    expect(opened?.args).toMatchObject({ root: 'task:t1', group: 'task:t1' });
  });

  it('records which tab each session went into', async () => {
    // What lets the sidebar give each tab its own dot without walking the
    // layout on every render.
    const h = (live = harness({ tasks: [task()] }));
    await h.run('tasks.spawn', { task: 't1', prompt: 'go' });

    const listed = await h.run<{ sessions: TaskSession[] }[]>('tasks.list');
    expect(listed[0]?.sessions[0]?.root).toBe('task:t1');
  });
});

describe("a task's tabs, as its sidebar sublist", () => {
  /** The kernel answering `layout.listRoots` with a group of `n` tabs. */
  const withTabs = (n: number) =>
    harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', root: 'task:t1' }] })],
      invoke: (id) => {
        if (id === 'layout.listRoots') {
          return {
            ok: true,
            value: Array.from({ length: n }, (_, index) => ({
              root: index === 0 ? 'task:t1' : `task:t1/tab-${index + 1}`,
              group: 'task:t1',
              label: index === 0 ? 'api' : `tab ${index + 1}`,
              focusedPane: `p${index + 1}`,
              focusedSession: index === 0 ? 's1' : null,
            })),
          } as never;
        }
        return undefined;
      },
    });

  it('lists one row per tab, each naming its own root', async () => {
    const h = (live = withTabs(2));
    await until(async () => (await h.tree().children('t1')).length === 2);

    const rows = await h.tree().children('t1');
    expect(rows.map((row) => row.root)).toEqual(['task:t1', 'task:t1/tab-2']);
    expect(rows.map((row) => row.label)).toEqual(['api', 'tab 2']);
  });

  it('draws the sublist for a SINGLE tab too — the entry does not change shape', async () => {
    const h = (live = withTabs(1));
    await until(async () => (await h.tree().children('t1')).length === 1);
    expect((await h.tree().children('t1'))[0]?.root).toBe('task:t1');
  });

  it('presents the session of the tab that was tapped, not the task’s first', async () => {
    const h = (live = withTabs(2));
    await until(async () => (await h.tree().children('t1')).length === 2);

    const rows = await h.tree().children('t1');
    expect(rows[1]?.presents).toEqual({
      id: 'tasks.presentation',
      args: { task: 't1', root: 'task:t1/tab-2' },
    });
  });

  it('caps at three rows, with an overflow row that says how many are hidden', async () => {
    const h = (live = withTabs(5));
    await until(async () => (await h.tree().children('t1')).length === 3);

    const rows = await h.tree().children('t1');
    expect(rows.at(-1)?.label).toBe('… +3');
  });

  it('expands in place when the overflow row is run, and folds back', async () => {
    const h = (live = withTabs(5));
    await until(async () => (await h.tree().children('t1')).length === 3);

    await h.run('tasks.expandTabs', { task: 't1' });
    const expanded = await h.tree().children('t1');
    expect(expanded).toHaveLength(6);
    expect(expanded.at(-1)?.label).toBe('… less');

    await h.run('tasks.expandTabs', { task: 't1' });
    expect(await h.tree().children('t1')).toHaveLength(3);
  });

  it('gives each tab its own dot, rolled up over the sessions in THAT tab', async () => {
    const h = (live = withTabs(2));
    await until(async () => (await h.tree().children('t1')).length === 2);
    h.emit('agents.stateChanged', {
      sessionId: 's1',
      kindId: 'claude-code',
      pane: 'p1',
      from: 'idle',
      to: 'needsCheck',
      turnFinished: true,
      level: 'attention',
      alertReason: '',
    });
    await until(async () => (await h.tree().children('t1'))[0]?.tint === 'needs-check');

    const rows = await h.tree().children('t1');
    // Tab 2 holds no session of this task, so it stays quiet — the point of
    // rolling up per root rather than per task.
    expect(rows.map((row) => row.tint)).toEqual(['needs-check', 'idle']);
  });
});

describe('archiving keeps the tabs and their screens', () => {
  const withGroup = (extra?: (id: string, args: unknown) => unknown) =>
    harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', root: 'task:t1' }] })],
      git: archivable,
      invoke: (id, args) => {
        if (id === 'layout.listRoots') {
          return {
            ok: true,
            value: [
              {
                root: 'task:t1',
                group: 'task:t1',
                label: 'api',
                focusedPane: 'p1',
                tree: { kind: 'leaf', pane: { id: 'p1' } },
                panes: [{ pane: 'p1', cwd: '/wt', userTitle: null, session: 's1' }],
              },
              {
                root: 'task:t1/tab-2',
                group: 'task:t1',
                label: 'logs',
                focusedPane: 'p2',
                tree: { kind: 'leaf', pane: { id: 'p2' } },
                panes: [{ pane: 'p2', cwd: '/wt/api', userTitle: 'logs', session: null }],
              },
            ],
          } as never;
        }
        if (id === 'sessions.capture') {
          return { ok: true, value: { bytes: Buffer.from('previous work').toString('base64') } } as never;
        }
        return extra?.(id, args) as never;
      },
    });

  it('captures every screen BEFORE it closes the group', async () => {
    // `layout.closeGroup` kills the ptys and a mirror dies with its session.
    // Capturing afterwards would archive empty screens and report no fault,
    // because nothing would have failed.
    const h = (live = withGroup());
    await h.run('tasks.archive', { task: 't1' });

    const captured = h.trace.indexOf('invoke sessions.capture');
    const closed = h.trace.indexOf('invoke layout.closeGroup');
    expect(captured).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(captured);
  });

  it('records each tab with its panes, and writes a history file per captured pane', async () => {
    const h = (live = withGroup());
    await h.run('tasks.archive', { task: 't1' });

    const stored = (await h.run<{ tabs?: { root: string; panes: { history?: string }[] }[] }[]>('tasks.list'))[0];
    expect(stored?.tabs?.map((tab) => tab.root)).toEqual(['task:t1', 'task:t1/tab-2']);
    const history = stored?.tabs?.[0]?.panes[0]?.history;
    expect(history).toBeDefined();
    expect(existsSync(join(h.dataDir, '.archives', history as string))).toBe(true);
    // The pane with no session had nothing to capture, and says so by omission.
    expect(stored?.tabs?.[1]?.panes[0]?.history).toBeUndefined();
  });

  it('archives a pane WITHOUT history when its screen cannot be read', async () => {
    // A session that has already exited has no mirror. A task you cannot shelve
    // because one pane's history could not be read is the worse outcome.
    const warnings: string[] = [];
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', root: 'task:t1' }] })],
      git: archivable,
      onWarn: (line) => warnings.push(line),
      invoke: (id) => {
        if (id === 'layout.listRoots') {
          return {
            ok: true,
            value: [
              {
                root: 'task:t1',
                group: 'task:t1',
                label: 'api',
                focusedPane: 'p1',
                tree: { kind: 'leaf', pane: { id: 'p1' } },
                panes: [{ pane: 'p1', cwd: '/wt', userTitle: null, session: 's1' }],
              },
            ],
          } as never;
        }
        if (id === 'sessions.capture') {
          return {
            ok: false,
            error: { code: 'handler-failed', message: 'no session s1', commandId: id },
          } as never;
        }
        return undefined;
      },
    }));
    await h.run('tasks.archive', { task: 't1' });

    const stored = (await h.run<{ lifecycle: string; tabs?: { panes: { history?: string }[] }[] }[]>('tasks.list'))[0];
    expect(stored?.lifecycle).toBe('archived');
    expect(stored?.tabs?.[0]?.panes[0]?.history).toBeUndefined();
    expect(warnings.some((line) => line.includes('without its history'))).toBe(true);
  });
});

describe('mark done', () => {
  it('offers Mark done on a live task and nothing on an archived one', async () => {
    const h = (live = harness({
      tasks: [task(), task({ id: 't2', lifecycle: 'archived', archivedAt: 1 })],
    }));
    expect((await rowOf(h, 't1'))?.primaryAction).toMatchObject({
      id: 'tasks.archive',
      label: 'Mark done',
      icon: 'check',
      args: { task: 't1' },
    });
    expect((await rowOf(h, 't2'))?.primaryAction).toBeUndefined();
  });
});

describe('restoring a task with tabs rebuilds the SCREEN', () => {
  const archivedWithTabs = () =>
    task({
      lifecycle: 'archived',
      archivedAt: 1,
      archives: [],
      sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', root: 'task:t1', resumeTarget: 'opaque' }],
      tabs: [
        {
          root: 'task:t1',
          focusedPane: 'p1',
          panes: [{ pane: 'p1', cwd: '/wt', userTitle: null, sessionId: 's1', resumeTarget: 'opaque' }],
        },
        {
          root: 'task:t1/tab-2',
          focusedPane: 'p2',
          panes: [{ pane: 'p2', cwd: '/wt/api', userTitle: 'logs' }],
        },
      ],
    });

  const resuming = (id: string) =>
    id === 'agents.resumeCommand' ? ({ ok: true, value: { command: 'claude --resume opaque' } } as never) : undefined;

  it('reopens every archived tab, in order, in the task’s group', async () => {
    const h = (live = harness({ tasks: [archivedWithTabs()], invoke: resuming }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.filter((call) => call.id === 'layout.openRoot').length === 2);

    const opened = h.invoked.filter((call) => call.id === 'layout.openRoot');
    expect(opened.map((call) => (call.args as { root: string }).root)).toEqual([
      'task:t1',
      'task:t1/tab-2',
    ]);
    expect(opened[0]?.args).toMatchObject({ group: 'task:t1', cwd: '/wt' });
  });

  it('STAGES the resume line without a newline, so nothing runs', async () => {
    /*
     * The whole correction, in one assertion. `setInitialInput` documents a
     * newline as an Enter press, so a staged line ending in one would relaunch
     * every agent of a task somebody restored in order to glance at it.
     */
    const h = (live = harness({ tasks: [archivedWithTabs()], invoke: resuming }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const staged = h.invoked.find((call) => call.id === 'layout.openRoot')?.args as {
      initialCommand?: string;
    };
    expect(staged.initialCommand).toBe('claude --resume opaque');
    expect(staged.initialCommand).not.toContain('\n');
  });

  it('stages nothing in a tab that had no agent', async () => {
    const h = (live = harness({ tasks: [archivedWithTabs()], invoke: resuming }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.filter((call) => call.id === 'layout.openRoot').length === 2);

    const second = h.invoked.filter((call) => call.id === 'layout.openRoot')[1]?.args as {
      initialCommand?: string;
    };
    expect(second.initialCommand).toBeUndefined();
  });

  it('never opens a pane through the RESUME path, which would run the agent', async () => {
    // `resumeSession` types the line WITH its Enter. A restore that fell through
    // to it would resume every agent while claiming to have staged them.
    const h = (live = harness({ tasks: [archivedWithTabs()], invoke: resuming }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.filter((call) => call.id === 'layout.openRoot').length === 2);

    expect(h.invoked.some((call) => call.id === 'layout.split')).toBe(false);
    const staged = h.invoked
      .filter((call) => call.id === 'layout.openRoot')
      .map((call) => (call.args as { initialCommand?: string }).initialCommand);
    expect(staged.filter((line) => line !== undefined)).toHaveLength(1);
  });

  it('restores a record written before tabs existed exactly as it always did', async () => {
    const h = (live = harness({
      tasks: [
        task({
          lifecycle: 'archived',
          archivedAt: 1,
          archives: [],
          sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', resumeTarget: 'opaque' }],
        }),
      ],
      invoke: resuming,
    }));
    await h.run('tasks.restore', { task: 't1' });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    // One root, opened by the old resume path — no second tab invented.
    expect(h.invoked.filter((call) => call.id === 'layout.openRoot')).toHaveLength(1);
  });
});

describe('a task whose pane group empties', () => {
  it('archives it — closing every pane on a task is finishing it', async () => {
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));
    // The precondition is that it has not archived YET, which is all this test
    // ever meant by it. It is no longer a statement about the dot: `displayState`
    // answers from the agents now, and a task none of whose sessions have
    // reported reads `idle`.
    expect(await listedState(h)).not.toBe('archived');

    h.emit('layout.rootClosed', { root: 'task:t1' });
    await until(() => h.invoked.some((call) => call.id === 'tasks.archive'));

    // Archive, not delete: the worktrees are snapshotted first, so every
    // uncommitted line survives a gesture that looks like throwing work away.
    expect(h.invoked.find((call) => call.id === 'tasks.archive')?.args).toEqual({ task: 't1' });
  });

  it('does NOT archive while another tab of the task still has panes', async () => {
    /*
     * The sharpest edge in the whole tabs change. A task's tabs are separate
     * roots, so closing the first one announces a closed root while the second
     * is still running an agent — and archiving there snapshots and removes the
     * worktrees out from under work that is very much in flight.
     */
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));

    h.emit('layout.rootClosed', { root: 'task:t1', group: 'task:t1', groupEmpty: false });
    // Given every chance to archive, and it must not have.
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.invoked.some((call) => call.id === 'tasks.archive')).toBe(false);
  });

  it('archives when the LAST tab of the task empties, whichever tab that is', async () => {
    // The announcement names the tab that closed — `task:t1/tab-2`, which
    // matches no task — and the GROUP, which is what the task is known by.
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
    }));

    h.emit('layout.rootClosed', { root: 'task:t1/tab-2', group: 'task:t1', groupEmpty: true });
    await until(() => h.invoked.some((call) => call.id === 'tasks.archive'));
    expect(h.invoked.find((call) => call.id === 'tasks.archive')?.args).toEqual({ task: 't1' });
  });

  it('KEEPS the sessions in the record, minus their dead panes', async () => {
    /*
     * They are what restore reattaches to. An empty list would also make
     * `provision` treat the restored task as one that has never run and start a
     * fresh agent on the original brief — the same words with none of the
     * transcript, which is the bug this pairs with.
     *
     * The pane goes, because it closed with the root: a record naming a pane
     * that does not exist is what made the archive trigger unreliable to begin
     * with.
     */
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1' }] })],
      git: archivable,
    }));

    h.emit('layout.rootClosed', { root: 'task:t1' });
    await until(async () => {
      const [listed] = await h.run<{ lifecycle: string }[]>('tasks.list');
      return listed?.lifecycle === 'archived';
    });

    expect((await h.run<{ sessions: TaskSession[] }[]>('tasks.list'))[0]?.sessions).toEqual([
      { id: 's1', role: 'orchestrator' },
    ]);
  });

  it('archives it whatever the record says its panes were', async () => {
    // The restart case, which is the one that was broken: the layout restored
    // and minted new pane ids, so the record names panes that do not exist —
    // and it makes no difference, because nothing counts them any more.
    const h = (live = harness({
      tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'a-pane-from-last-run' }] })],
    }));

    h.emit('layout.rootClosed', { root: 'task:t1' });
    await until(() => h.invoked.some((call) => call.id === 'tasks.archive'));
    expect(h.invoked.find((call) => call.id === 'tasks.archive')?.args).toEqual({ task: 't1' });
  });

  it('ignores a root that is not a task, and one already archived', async () => {
    const h = (live = harness({ tasks: [task({ lifecycle: 'archived' })] }));

    h.emit('layout.rootClosed', { root: 'home' });
    h.emit('layout.rootClosed', { root: 'task:t1' });
    await Promise.resolve();

    expect(h.invoked.some((call) => call.id === 'tasks.archive')).toBe(false);
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

/**
 * `tasks.repoProvisioned` — the one seam another extension gets into
 * provisioning.
 *
 * It is AWAITED rather than announced on the bus, and that is the whole claim
 * worth testing: the motivating provider copies gitignored files a fresh
 * `worktree add` cannot carry, and an agent opens in that checkout moments
 * later. A fire-and-forget event would race it, and the race would be invisible
 * — the files land, just sometimes after the agent looked.
 *
 * The other half is that a provider CANNOT take a task down. It is somebody
 * else's code running in the middle of provisioning, so a failure and a throw
 * both have to degrade the repo and leave the worktree, the root and the spawn
 * alone.
 */
describe('tasks.repoProvisioned', () => {
  const REPO = { name: 'api', path: '/src/api' };

  it('hands a provider the worktree, the source repo, the branch and the task', async () => {
    const h = (live = harness());
    const seen: RepoProvisionedFact[] = [];
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact);
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => seen.length > 0);

    expect(seen).toEqual([
      {
        repo: { path: '/src/api', name: 'api' },
        worktree: join(h.dataDir, 'fix-login', 'api'),
        branch: 'fix-login',
        task: { slug: 'fix-login', root: join(h.dataDir, 'fix-login') },
      },
    ]);
  });

  it('runs BEFORE the task root is written and before any pane opens', async () => {
    // The ordering IS the feature. A provider that finishes the checkout after
    // the orchestrator has started is a provider that did nothing.
    const h = (live = harness());
    let rootAtCallTime: boolean | undefined;
    let panesAtCallTime = 0;
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => {
      rootAtCallTime = existsSync(join(h.dataDir, 'fix-login', 'CLAUDE.md'));
      panesAtCallTime = h.invoked.filter((call) => call.id === 'layout.openRoot').length;
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => rootAtCallTime !== undefined);

    expect(rootAtCallTime).toBe(false);
    expect(panesAtCallTime).toBe(0);
  });

  it('waits for a slow provider rather than racing it', async () => {
    const h = (live = harness());
    let finished = false;
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    expect(finished).toBe(true);
  });

  it('runs every provider, in registration order', async () => {
    const h = (live = harness());
    const order: string[] = [];
    const point = h.point<RepoProvisioned>(REPO_PROVISIONED_POINT);
    point.register(async () => {
      order.push('first');
      return { ok: true };
    });
    point.register(async () => {
      order.push('second');
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => order.length === 2);

    expect(order).toEqual(['first', 'second']);
  });

  it('runs once per repo, in its own worktree', async () => {
    const h = (live = harness());
    const worktrees: string[] = [];
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async (fact) => {
      worktrees.push(fact.worktree);
      return { ok: true };
    });

    await h.run('tasks.create', {
      title: 'Fix login',
      repos: [REPO, { name: 'web', path: '/src/web' }],
    });
    await until(() => worktrees.length === 2);

    // Sorted: the chains run concurrently, so which repo's provider is called
    // first is a race. What this test is about is that each repo gets one call
    // in its OWN worktree — the ordering claim that does matter lives in
    // `provisioning repos concurrently` below, on `landed`.
    expect([...worktrees].sort()).toEqual(
      [join(h.dataDir, 'fix-login', 'api'), join(h.dataDir, 'fix-login', 'web')].sort(),
    );
  });

  it('is not consulted for a repo whose worktree never appeared', async () => {
    const h = (live = harness({
      git: (call) =>
        call.args[0] === 'worktree' && call.args[1] === 'add'
          ? { ok: false, code: 128, stdout: '', stderr: 'fatal: nope\n' }
          : OK,
    }));
    let called = false;
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => {
      called = true;
      return { ok: true };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    expect(called).toBe(false);
  });

  it('keeps the worktree and still spawns when a provider reports a failure', async () => {
    // v1's choice, and for v1's reason: a half-provisioned checkout you can look
    // at beats a task that refused to open.
    const warnings: string[] = [];
    const h = (live = harness({ onWarn: (line) => warnings.push(line) }));
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => ({
      ok: false,
      message: 'the repo hook failed — exited 3\ncp: no such file',
    }));

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const listed = await h.run<{ repos: { provisioning: string; hookIssue?: string }[] }[]>('tasks.list');
    expect(listed[0]?.repos[0]?.provisioning).toBe('ready');
    expect(listed[0]?.repos[0]?.hookIssue).toBe('the repo hook failed — exited 3\ncp: no such file');
    expect(warnings.some((line) => line.includes('cp: no such file'))).toBe(true);
  });

  it('says so on the TASK row, without claiming the repo is unprovisioned', async () => {
    // It was said on the repo's own child row until a task's children became
    // its tabs. The fact is unchanged and so is the wording — what moved is
    // which row carries it, and it is APPENDED so the task still reads as the
    // state it is really in.
    const h = (live = harness());
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => ({ ok: false, message: 'exited 1' }));

    const created = await h.run<{ id: string }>('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const row = await rowOf(h, created.id);
    expect(row?.description).toContain(`${REPO.name} — hook failed`);
  });

  it('survives a provider that throws, and reports what it threw', async () => {
    const h = (live = harness());
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async () => {
      throw new Error('boom');
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    const listed = await h.run<{ repos: { hookIssue?: string }[] }[]>('tasks.list');
    expect(listed[0]?.repos[0]?.hookIssue).toContain('boom');
  });

  it('lets a later provider run after an earlier one failed', async () => {
    // They are independent side effects on a directory, not a chain. One
    // provider's failure is not a reason to skip somebody else's.
    const h = (live = harness());
    let secondRan = false;
    const point = h.point<RepoProvisioned>(REPO_PROVISIONED_POINT);
    point.register(async () => ({ ok: false, message: 'first failed' }));
    point.register(async () => {
      secondRan = true;
      return { ok: false, message: 'second failed' };
    });

    await h.run('tasks.create', { title: 'Fix login', repos: [REPO] });
    await until(() => h.invoked.some((call) => call.id === 'layout.openRoot'));

    expect(secondRan).toBe(true);
    const listed = await h.run<{ repos: { hookIssue?: string }[] }[]>('tasks.list');
    expect(listed[0]?.repos[0]?.hookIssue).toBe('first failed\nsecond failed');
  });

  it('runs on restore too — a restored worktree needs its gitignored files as much', async () => {
    const h = (live = harness({
      tasks: [task({ id: 't1', lifecycle: 'archived', archivedAt: 5, repos: [REPO] })],
      git: archivable,
    }));
    const seen: string[] = [];
    h.point<RepoProvisioned>(REPO_PROVISIONED_POINT).register(async (fact) => {
      seen.push(fact.worktree);
      return { ok: true };
    });

    // Restoring re-provisions optimistically too (`void whileBusy(...)`), so the
    // handler answers before the worktrees are back.
    await h.run('tasks.restore', { task: 't1' });
    await until(() => seen.length > 0);

    expect(seen).toEqual([join(h.dataDir, 'fix-login', 'api')]);
  });
});

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
        // Only the LAST call of api's chain, not all six of them: one 20ms delay
        // inverts completion order, where delaying every git call costs more
        // wall clock than `until`'s tick budget and times out instead.
        if (call.opts.cwd === '/src/api' && call.args[0] === 'worktree' && call.args[1] === 'add') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
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
        // Only the LAST call of api's chain, not all six of them: one 20ms delay
        // inverts completion order, where delaying every git call costs more
        // wall clock than `until`'s tick budget and times out instead.
        if (call.opts.cwd === '/src/api' && call.args[0] === 'worktree' && call.args[1] === 'add') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
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

/**
 * The composer's speculative ask, and the cache that makes it provisioning's ask
 * too (D21).
 *
 * Without the cache, the exact case speculation exists for — Create pressed a
 * second before the answer lands — pays for the model twice and waits ~6s from
 * scratch.
 */
describe('tasks.suggestName', () => {
  const LONG = 'a brief that is long enough to be worth naming';

  /** A quick model that answers, and a count of how often it was asked. */
  const answering = (text: string) => (id: string) =>
    id === 'agents.complete' ? ({ ok: true as const, value: { ok: true, text } }) : undefined;

  const asks = (h: Harness): number => h.invoked.filter((call) => call.id === 'agents.complete').length;

  it('asks the quick model and sanitizes what comes back', async () => {
    const h = harness({ invoke: answering('`Add a cheap model seam`') });
    expect(await h.run('tasks.suggestName', { brief: LONG })).toEqual({ name: 'Add a cheap model seam' });
    h.dispose();
  });

  it('carries the brief in the prompt, not just the title', async () => {
    const h = harness({ invoke: answering('A name') });
    await h.run('tasks.suggestName', { brief: LONG });
    const ask = h.invoked.find((call) => call.id === 'agents.complete');
    expect(JSON.stringify(ask?.args)).toContain('long enough to be worth naming');
    h.dispose();
  });

  it('asks once per brief, however many callers want it', async () => {
    const h = harness({ invoke: answering('A name') });
    await Promise.all([h.run('tasks.suggestName', { brief: LONG }), h.run('tasks.suggestName', { brief: LONG })]);
    expect(asks(h)).toBe(1);
    h.dispose();
  });

  it('asks again once the brief has really changed', async () => {
    const h = harness({ invoke: answering('A name') });
    await h.run('tasks.suggestName', { brief: LONG });
    await h.run('tasks.suggestName', { brief: `${LONG} and now it says something else entirely` });
    expect(asks(h)).toBe(2);
    h.dispose();
  });

  it('does not ask about a brief too short to name', async () => {
    const h = harness({ invoke: answering('whatever') });
    expect(await h.run('tasks.suggestName', { brief: 'fix it' })).toEqual({ name: null });
    expect(asks(h)).toBe(0);
    h.dispose();
  });

  it('answers null when the model cannot, and does not warn about it', async () => {
    // An unavailable model is not a fault of whoever asked, and this extension's
    // warn channel is for things a user can act on.
    const warnings: string[] = [];
    const h = harness({
      onWarn: (line) => warnings.push(line),
      invoke: (id) =>
        id === 'agents.complete'
          ? { ok: true as const, value: { ok: false, reason: 'failed', message: 'no binary' } }
          : undefined,
    });
    expect(await h.run('tasks.suggestName', { brief: LONG })).toEqual({ name: null });
    expect(warnings).toEqual([]);
    h.dispose();
  });

  it('answers null when the command itself was refused', async () => {
    const h = harness({
      invoke: (id) =>
        id === 'agents.complete'
          ? { ok: false as const, error: { code: 'denied' as const, message: 'lacks permission "agents"', commandId: id } }
          : undefined,
    });
    expect(await h.run('tasks.suggestName', { brief: LONG })).toEqual({ name: null });
    h.dispose();
  });

  it('answers null when the answer has a shape nobody expected', async () => {
    // A command's answer is `unknown` and came from an extension this code has
    // never seen. A cast is not a check.
    for (const value of [42, null, 'a string', {}, { ok: true }, { ok: true, text: 7 }]) {
      const h = harness({ invoke: (id) => (id === 'agents.complete' ? { ok: true as const, value } : undefined) });
      expect(await h.run('tasks.suggestName', { brief: LONG })).toEqual({ name: null });
      h.dispose();
    }
  });

  it('answers null rather than throwing when the ask itself blows up', async () => {
    const h = harness({
      invoke: (id) => {
        if (id !== 'agents.complete') return undefined;
        throw new Error('the port died');
      },
    });
    expect(await h.run('tasks.suggestName', { brief: LONG })).toEqual({ name: null });
    h.dispose();
  });
});

/**
 * The race, and the invariant that keeps it from ever becoming a rename:
 *
 *   the slug may change exactly once, before the first git write, and never after.
 *
 * That single sentence is what keeps `git branch -m`, `git worktree move`, a task
 * root that moves under a booting agent, and re-seeding trust out of this codebase
 * entirely.
 */
describe('naming a task at create', () => {
  const REPO = { path: '/src/api', name: 'api' };
  const BRIEF = 'I wanna add a cheap model for naming things without blocking a worktree';

  /** Every task as it is actually STORED, not as a handler answered. */
  const stored = async (h: Harness): Promise<readonly TaskRecord[]> =>
    await h.run<readonly TaskRecord[]>('tasks.list');

  /** Provisioning is deliberately not awaited (D12), so give it its ticks. */
  const drain = async (): Promise<void> => {
    for (let tick = 0; tick < 40; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const named = (text: string) => (id: string) =>
    id === 'agents.complete' ? { ok: true as const, value: { ok: true, text } } : undefined;

  const worktreeAdds = (h: Harness): GitCall[] =>
    h.git.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');

  it('uses a name the caller already has, and never asks again', async () => {
    const h = harness({ invoke: named('Ignored — should not be asked') });
    const created = await h.run<TaskRecord>('tasks.create', {
      title: BRIEF,
      brief: BRIEF,
      name: 'Add a cheap model seam',
      repos: [REPO],
    });
    expect(created.slug).toBe('add-a-cheap-model-seam');
    // One call answers both the branch and the row label (D18).
    expect(created.title).toBe('Add a cheap model seam');
    expect(h.invoked.filter((call) => call.id === 'agents.complete')).toEqual([]);
    h.dispose();
  });

  it('falls back to the heuristic, not to the whole first line', async () => {
    const h = harness({ invoke: () => undefined });
    const created = await h.run<TaskRecord>('tasks.create', {
      title: "#shepherd I wanna add a new feature / extension. It's something like a dumb model",
      brief: "#shepherd I wanna add a new feature / extension. It's something like a dumb model",
      repos: [],
    });
    // The bug being fixed produced
    // `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`.
    expect(created.slug).toBe('add-a-new-feature-extension');
    h.dispose();
  });

  it('adopts a name that lands before the first git write, and renames nothing', async () => {
    const h = harness({ invoke: named('Add a cheap model seam') });
    const created = await h.run<TaskRecord>('tasks.create', { title: BRIEF, brief: BRIEF, repos: [REPO] });
    await drain();

    expect((await stored(h)).find((t) => t.id === created.id)?.slug).toBe('add-a-cheap-model-seam');
    // ONE worktree add, under the settled name — one name for the lifetime of the
    // task, and no rename behind it.
    expect(worktreeAdds(h)).toHaveLength(1);
    expect(worktreeAdds(h)[0]?.args.join(' ')).toContain('add-a-cheap-model-seam');
    expect(h.git.some((call) => call.args.join(' ').includes('branch -m'))).toBe(false);
    expect(h.git.some((call) => call.args.join(' ').includes('worktree move'))).toBe(false);
    h.dispose();
  });

  it('never writes git under the provisional name', async () => {
    // The whole point of awaiting the name BEFORE the first write rather than
    // renaming after it: no git command may ever mention the heuristic slug.
    //
    // Asserted against the WHOLE provisional slug, not a prefix of it: the
    // heuristic (`add-a-cheap-model-for-naming`) and the settled name
    // (`add-a-cheap-model-seam`) share their first four words, so a substring
    // check would fail on the correct behaviour.
    const h = harness({ invoke: named('Add a cheap model seam') });
    await h.run<TaskRecord>('tasks.create', { title: BRIEF, brief: BRIEF, repos: [REPO] });
    await drain();
    expect(h.git.some((call) => call.args.join(' ').includes('add-a-cheap-model-for-naming'))).toBe(false);
    h.dispose();
  });

  it('holds the first worktree add for a slow answer rather than dropping it', async () => {
    // Fake timers, because the ask is the only clock now and a real ~10s wait is
    // not something a suite can sit through.
    vi.useFakeTimers();
    try {
      const h = harness({
        invoke: (id) =>
          id === 'agents.complete'
            ? (new Promise((resolve) => {
                setTimeout(() => resolve({ ok: true, value: { ok: true, text: 'Slow But Correct' } }), 10_500);
              }) as never)
            : undefined,
      });
      const created = await h.run<TaskRecord>('tasks.create', { title: BRIEF, brief: BRIEF, repos: [REPO] });

      // Past the 4s this used to give up at, and still nothing is written: a name
      // that lands after the first worktree add is a name that cannot be used.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(worktreeAdds(h)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);

      expect((await stored(h)).find((t) => t.id === created.id)?.slug).toBe('slow-but-correct');
      expect(worktreeAdds(h)).toHaveLength(1);
      expect(worktreeAdds(h)[0]?.args.join(' ')).toContain('slow-but-correct');
      expect(h.git.some((call) => call.args.join(' ').includes('add-a-cheap-model-for-naming'))).toBe(false);
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the heuristic when the ask fails, and does not wait for its timeout', async () => {
    // The bound on the wait is the ask, so the ask failing has to end it — a
    // signed-out model answers `ok: false` in a couple of seconds, and a task that
    // sat 30s for that would be indistinguishable from a hang.
    const h = harness({
      invoke: (id) =>
        id === 'agents.complete'
          ? { ok: true as const, value: { ok: false, reason: 'failed', message: 'Not logged in' } }
          : undefined,
    });
    const created = await h.run<TaskRecord>('tasks.create', { title: BRIEF, brief: BRIEF, repos: [REPO] });
    await drain();

    expect((await stored(h)).find((t) => t.id === created.id)?.slug).toBe('add-a-cheap-model-for-naming');
    expect(worktreeAdds(h)).toHaveLength(1);
    h.dispose();
  });

  it('does not rename a task that is being restored', async () => {
    // Restore provisions too, and a task with a history must never have its
    // directory renamed under it — the window in which a slug may change closed
    // the first time git ran for it.
    const h = harness({
      tasks: [task({ id: 't1', slug: 'old-name', title: 'Old name', brief: BRIEF, lifecycle: 'archived', sessions: [] })],
      invoke: named('A Brand New Name'),
    });
    await h.run('tasks.restore', { task: 't1' });
    await drain();
    expect((await stored(h)).find((t) => t.id === 't1')?.slug).toBe('old-name');
    h.dispose();
  });
});
