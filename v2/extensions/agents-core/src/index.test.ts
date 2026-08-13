import { describe, expect, it } from 'vitest';
import {
  extensionId,
  manualClock,
  nullLogger,
  PointRegistry,
  toDisposable,
  type AttentionState,
  type CommandAPI,
  type CommandSpec,
  type Disposable,
  type Envelope,
  type EventAPI,
  type ExtensionContext,
  type KV,
  type Schema,
  type SettingsAPI,
  type Shepherd,
} from '@shepherd/sdk';
import { activate, type AgentsAPI } from './index.ts';
import type { AgentDecision, AgentKind } from './kind.ts';
import { AGENT_STATE_KEY } from './persist.ts';
import {
  AGENTS_COMMANDS,
  AGENT_STATE_TOPIC,
  SESSIONS_LIST_COMMAND,
  SESSION_EXIT_TOPIC,
} from './manifest.ts';

/**
 * `activate` across a RESTART, which is the only place this can be tested.
 *
 * The registry's own tests prove a snapshot round-trips as values. They cannot
 * prove the snapshot is ever written, or read, or filtered against the sessions
 * that actually survived — and that gap is exactly the shape of the bug: every
 * unit was correct and nothing joined them, so a live `claude` read idle.
 *
 * So a "restart" here is two `activate` calls over ONE storage, the way two runs
 * of the app share one KV.
 */

const SESSION = 'session-1';
const PANE = 'pane-1';

/** A kind that answers however the test says, and records the state it was shown. */
function fakeKind(answer: (current: string) => AgentDecision): AgentKind & { seen: string[] } {
  const seen: string[] = [];
  return {
    id: 'claude-code',
    topics: ['test.hook'],
    seen,
    reduce(input) {
      seen.push(input.current);
      return answer(input.current);
    },
  };
}

const transition = (state: string): AgentDecision => ({
  kind: 'transition',
  to: {
    state: state as 'working',
    clearTitle: false,
    applied: true,
    heldForBackground: false,
    turnFinished: false,
  },
});

interface SessionRow {
  readonly id: string;
  readonly paneId?: string;
  readonly hasForegroundProcess?: boolean;
  readonly viewing?: boolean;
}

interface Launch {
  /** Deliver one vendor hook, as the ingress attributes it: to the envelope's session. */
  hook(sessionId: string, payload?: unknown): void;
  /** Deliver a kernel event on a topic this extension subscribes to. */
  fire(topic: string, payload: unknown): void;
  run<R>(id: string, args?: unknown): Promise<R>;
  /** Every `agents.stateChanged` this run published. */
  readonly published: { sessionId: string; to: string; pane?: string }[];
  readonly attention: { sessionId: string; state: AttentionState }[];
  dispose(): Promise<void>;
}

/** One storage, shared across launches — the KV two runs of the app both see. */
function sharedStorage(): KV & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: <T>(key: string, schema: Schema<T>): T | undefined => {
      if (!raw.has(key)) return undefined;
      const parsed = schema.parse(raw.get(key));
      return parsed.ok ? parsed.value : undefined;
    },
    // Round-tripped through JSON, because the real store is SQLite and a test
    // that handed the same object back would prove nothing about what persists.
    set: (key, value) => void raw.set(key, JSON.parse(JSON.stringify(value)) as unknown),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()].sort(),
  };
}

async function launch(
  storage: KV,
  sessions: readonly SessionRow[],
  kind?: AgentKind,
): Promise<Launch> {
  const listeners = new Map<string, ((payload: unknown, envelope: Envelope) => void)[]>();
  const published: { sessionId: string; to: string; pane?: string }[] = [];

  const events: EventAPI = {
    emit: <T>(topic: string, payload: T) => {
      if (topic !== AGENT_STATE_TOPIC) return;
      const change = payload as { sessionId: string; to: string; pane?: string };
      published.push({ sessionId: change.sessionId, to: change.to, ...(change.pane === undefined ? {} : { pane: change.pane }) });
    },
    on: <T>(topic: string, fn: (payload: T, envelope: Envelope) => void): Disposable => {
      const list = listeners.get(topic) ?? [];
      list.push(fn as (payload: unknown, envelope: Envelope) => void);
      listeners.set(topic, list);
      return toDisposable(() => void listeners.set(topic, list.filter((f) => f !== fn)));
    },
  };

  const registered = new Map<string, CommandSpec<unknown, unknown>>();
  const commands: CommandAPI = {
    register: (id, spec) => {
      registered.set(id, spec as unknown as CommandSpec<unknown, unknown>);
      return toDisposable(() => void registered.delete(id));
    },
    invoke: <R>(id: string) =>
      Promise.resolve(
        id === SESSIONS_LIST_COMMAND
          ? { ok: true as const, value: sessions as unknown as R }
          : { ok: false as const, error: { code: 'unknown-command' as const, message: 'no', commandId: id } },
      ),
    list: () => [...registered.keys()].map((id) => ({ id })),
  };

  const attentionCalls: { sessionId: string; state: AttentionState }[] = [];
  const registry = new PointRegistry({ logger: nullLogger });

  const ctx: ExtensionContext = {
    id: extensionId('shepherd.agents-core'),
    source: 'builtin',
    subscriptions: [],
    storage,
    dataDir: '/data',
    homeDir: '/Users/x',
    userName: 'ada',
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: nullLogger.child('extension'),
    clock: manualClock(1),
    permissions: ['storage', 'sessions', 'attention', 'settings'],
    isDev: false,
  };

  const settings: SettingsAPI = {
    get: <T>(_key: string, _schema: Schema<T>): T => null as T,
    set: () => Promise.resolve({ ok: true as const, value: undefined }),
    onDidChange: () => toDisposable(() => {}),
  };

  const api = {
    version: '1.0.0',
    proposed: {
      commands,
      events,
      points: registry,
      settings,
      attention: {
        set: (target: unknown, state: AttentionState) =>
          void attentionCalls.push({ sessionId: String(target), state }),
        clear: () => {},
        get: () => undefined,
        count: () => 0,
        onDidChange: () => toDisposable(() => {}),
      },
    },
  } as unknown as Shepherd;

  // `ActivateFn` permits `void`, so the API has to be checked rather than assumed
  // — a kind registered through nothing would make every test here vacuous.
  const exported: AgentsAPI | void = await activate(ctx, api);
  if (kind !== undefined) {
    if (exported === undefined) throw new Error('activate returned no API to register a kind through');
    ctx.subscriptions.push(exported.registerKind(kind));
  }

  const deliver = (topic: string, payload: unknown, envelope: Envelope): void => {
    for (const fn of listeners.get(topic) ?? []) fn(payload, envelope);
  };

  return {
    hook: (sessionId, payload = {}) =>
      deliver('test.hook', payload, {
        seq: 1,
        ts: 1,
        source: { kind: 'agent', sessionId: sessionId as never },
      }),
    fire: (topic, payload) =>
      deliver(topic, payload, { seq: 1, ts: 1, source: { kind: 'device', deviceId: 'test' } }),
    run: async <R>(id: string, args?: unknown): Promise<R> => {
      const spec = registered.get(id);
      if (spec === undefined) throw new Error(`no command ${id} was registered`);
      return (await spec.handler(args, { kind: 'device', deviceId: 'test' })) as R;
    },
    published,
    attention: attentionCalls,
    dispose: async () => {
      for (const sub of ctx.subscriptions) sub.dispose();
      registry.dispose();
      await Promise.resolve();
    },
  };
}

const listed = (l: Launch): Promise<{ agents: { sessionId: string; state: string; pane?: string }[] }> =>
  l.run(AGENTS_COMMANDS.list);

const LIVE: readonly SessionRow[] = [{ id: SESSION, paneId: PANE, hasForegroundProcess: true, viewing: false }];

describe('a state that outlives the process', () => {
  it('answers a restored working agent from agents.list', async () => {
    // THE regression. `pnpm ship` replaces the app while the daemon keeps every
    // pty, so the `claude` in this pane never restarted and will never fire
    // another SessionStart. Before the snapshot, `agents.list` answered nothing
    // and every task row read idle with a live agent in it.
    const storage = sharedStorage();
    const first = await launch(storage, LIVE, fakeKind(() => transition('working')));
    first.hook(SESSION);
    expect((await listed(first)).agents[0]?.state).toBe('working');
    await first.dispose();

    const second = await launch(storage, LIVE);

    const agents = (await listed(second)).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.state).toBe('working');
    // Keyed by pane too, or every consumer that can only key by pane — which is
    // `tasks`, whose rows are the ones that read idle — seeds nothing.
    expect(agents[0]?.pane).toBe(PANE);
    await second.dispose();
  });

  it('publishes what it restored, so attention is not left empty', async () => {
    const storage = sharedStorage();
    const first = await launch(storage, LIVE, fakeKind(() => transition('blocked')));
    first.hook(SESSION);
    await first.dispose();

    const second = await launch(storage, LIVE);

    expect(second.published).toEqual([{ sessionId: SESSION, to: 'blocked', pane: PANE }]);
    // A blocked agent still wants you after a restart. Restoring the registry
    // and not the badge would move the bug rather than fix it.
    expect(second.attention[0]?.state.level).toBe('urgent');
    await second.dispose();
  });

  it('lets the turn in flight carry on being reported', async () => {
    // The second half of the bug, and the reason a snapshot is not optional: the
    // ordering guard drops a mid-turn event unless the session is already
    // working or blocked (ADR 0004). Restored as untracked, the running agent's
    // own events were discarded for the rest of its turn.
    const storage = sharedStorage();
    const first = await launch(storage, LIVE, fakeKind(() => transition('working')));
    first.hook(SESSION);
    await first.dispose();

    const kind = fakeKind((current) => (current === 'working' ? transition('needsCheck') : { kind: 'ignore', why: 'mid-turn guard' }));
    const second = await launch(storage, LIVE, kind);
    second.hook(SESSION);

    expect(kind.seen).toEqual(['working']);
    expect((await listed(second)).agents[0]?.state).toBe('needsCheck');
    await second.dispose();
  });

  it('forgets a session whose pty did not survive', async () => {
    const storage = sharedStorage();
    const first = await launch(storage, LIVE, fakeKind(() => transition('working')));
    first.hook(SESSION);
    await first.dispose();

    // The daemon was replaced too, or the shell exited: the kernel reports no
    // such session, so restoring it would strand a working dot on a pane that
    // does not exist — and the sweep only corrects sessions the kernel names.
    const second = await launch(storage, []);

    expect((await listed(second)).agents).toEqual([]);
    await second.dispose();
  });

  it('drops a session from the snapshot when it exits', async () => {
    const storage = sharedStorage();
    const first = await launch(storage, LIVE, fakeKind(() => transition('working')));
    first.hook(SESSION);
    first.fire(SESSION_EXIT_TOPIC, { sessionId: SESSION });

    expect(storage.get(AGENT_STATE_KEY, { describe: 'raw', parse: (v) => ({ ok: true as const, value: v }) })).toEqual([]);
    await first.dispose();
  });
});
