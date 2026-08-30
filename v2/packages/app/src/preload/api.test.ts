import { describe, expect, it } from 'vitest';
import { BRIDGE_SURFACE, CONTROL_TOPICS, EMIT, INVOKE } from '../shared/index.ts';
import { createBridge, type IpcLike } from './api.ts';

/**
 * What the page can reach, checked against the declared allowlist.
 *
 * This half of the claim — the SHAPE — is checkable here. The other half,
 * whether `window.require` exists, is decided by `contextIsolation` at runtime
 * and is asserted in `smoke-terminal.ts` against a real renderer. Neither test
 * substitutes for the other, and a bridge that grew a `invoke(channel, …)`
 * escape hatch would fail this one on the very first line.
 */

/** What the page ASKED for, with the bridge's own construction-time `on` dropped. */
function invokes(ipc: { readonly log: Recorded[] }): Recorded[] {
  return ipc.log.filter((entry) => entry.kind === 'invoke');
}

interface Recorded {
  readonly kind: 'invoke' | 'on' | 'off';
  readonly channel: string;
  readonly args: readonly unknown[];
}

function fakeIpc(): IpcLike & {
  readonly log: Recorded[];
  emit(channel: string, payload: unknown): void;
  readonly listenerCount: number;
  /** What every `invoke` resolves with. Default: a bare success. */
  answer: unknown;
} {
  const log: Recorded[] = [];
  let listeners: Array<{ channel: string; fn: (event: unknown, ...args: unknown[]) => void }> = [];
  return {
    log,
    get listenerCount() {
      return listeners.length;
    },
    answer: { ok: true, value: undefined },
    invoke(channel, ...args) {
      log.push({ kind: 'invoke', channel, args });
      return Promise.resolve(this.answer);
    },
    on: (channel, fn) => {
      log.push({ kind: 'on', channel, args: [] });
      listeners.push({ channel, fn });
    },
    off: (channel, fn) => {
      log.push({ kind: 'off', channel, args: [] });
      listeners = listeners.filter((l) => l.fn !== fn);
    },
    emit: (channel, payload) => {
      for (const listener of [...listeners]) {
        if (listener.channel === channel) listener.fn({}, payload);
      }
    },
  };
}

describe('the preload bridge surface', () => {
  it('exposes exactly the declared namespaces — no more, no fewer', () => {
    const bridge = createBridge(fakeIpc());
    expect(Object.keys(bridge)).toEqual(Object.keys(BRIDGE_SURFACE));
  });

  it('exposes exactly the declared members of each namespace', () => {
    const bridge = createBridge(fakeIpc()) as unknown as Record<string, object>;
    for (const [namespace, members] of Object.entries(BRIDGE_SURFACE)) {
      expect(Object.keys(bridge[namespace] as object), namespace).toEqual([...members]);
    }
  });

  it('exposes only functions — no raw ipcRenderer, no event emitter, no escape hatch', () => {
    const bridge = createBridge(fakeIpc()) as unknown as Record<string, Record<string, unknown>>;
    for (const namespace of Object.keys(BRIDGE_SURFACE)) {
      for (const [member, value] of Object.entries(bridge[namespace] ?? {})) {
        expect(typeof value, `${namespace}.${member}`).toBe('function');
      }
    }
    expect(Object.keys(BRIDGE_SURFACE)).not.toContain('invoke');
    expect(Object.keys(BRIDGE_SURFACE)).not.toContain('send');
    expect(Object.keys(BRIDGE_SURFACE)).not.toContain('ipcRenderer');
  });

  it('every declared member routes to a declared channel', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const known = new Set<string>([...Object.values(INVOKE), ...Object.values(EMIT)]);

    void bridge.session.create({});
    void bridge.session.attach('s1');
    void bridge.session.detach('s1');
    void bridge.session.write('s1', 'x');
    void bridge.session.paste('s1', 'x');
    void bridge.session.resize('s1', 80, 24);
    void bridge.commands.invoke('layout.split', { axis: 'row' });
    // What the palette reads — a SNAPSHOT of the registry, on its own channel.
    void bridge.commands.list();
    void bridge.layout.get();
    void bridge.layout.setViewport({ x: 0, y: 0, width: 10, height: 10 });
    void bridge.layout.snapshot('p1');
    void bridge.window.close();
    bridge.session.onData(() => undefined);
    bridge.session.onExit(() => undefined);
    bridge.layout.onChanged(() => undefined);

    // 15 calls plus the one the bridge makes for itself: a single listener on
    // `control:frame`, which is how every control-plane subscription arrives.
    expect(ipc.log).toHaveLength(16);
    expect(ipc.log[0]).toMatchObject({ kind: 'on', channel: EMIT.controlFrame });
    for (const entry of ipc.log) expect(known, entry.channel).toContain(entry.channel);
  });

  it('opens exactly ONE frame listener, however many topics the page follows', () => {
    // One channel carries every subscription, addressed by id. A listener per
    // topic would put the routing in electron's dispatch table, where nothing
    // can tear it down when a follower goes away.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    bridge.agents.onChanged(() => undefined);
    bridge.settings.onChanged(() => undefined);
    bridge.views.onChanged(() => undefined);
    expect(ipc.log.filter((entry) => entry.kind === 'on' && entry.channel === EMIT.controlFrame)).toHaveLength(1);
  });

  it('defaults a command with no arguments to `{}`, not `undefined`', () => {
    // Every layout command's schema is an `s.object`, and `s.object` on
    // `undefined` is an `invalid-args` failure — so ⌘W, which genuinely takes no
    // arguments, would be rejected for sending none.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);

    void bridge.commands.invoke('layout.close');

    expect(invokes(ipc)[0]).toEqual({
      kind: 'invoke',
      channel: INVOKE.controlInvoke,
      args: ['layout.close', {}],
    });
  });

  it('passes arguments through unchanged, in order', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const bytes = new Uint8Array([1, 2, 3]);

    void bridge.session.write('s7', bytes);
    void bridge.session.resize('s7', 120, 40);

    expect(invokes(ipc)[0]).toEqual({ kind: 'invoke', channel: INVOKE.sessionWrite, args: ['s7', bytes] });
    expect(invokes(ipc)[1]).toEqual({
      kind: 'invoke',
      channel: INVOKE.sessionResize,
      args: ['s7', 120, 40],
    });
  });

  it('hands a subscriber the message and never the event object', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const seen: unknown[] = [];

    const off = bridge.session.onData((message) => seen.push(message));
    ipc.emit(EMIT.sessionData, { sessionId: 's1', bytes: new Uint8Array([9]) });

    expect(seen).toEqual([{ sessionId: 's1', bytes: new Uint8Array([9]) }]);
    // An IpcRendererEvent would carry `sender` — a way back out of the bridge.
    expect(seen[0]).not.toHaveProperty('sender');
    off();
    // One remains, and it is the bridge's own: `control:frame` is opened at
    // construction and lives as long as the bridge does.
    expect(ipc.listenerCount).toBe(1);
  });

  it('a view that unmounts really does stop listening', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const seen: unknown[] = [];
    const off = bridge.layout.onChanged((snapshot) => seen.push(snapshot));

    off();
    ipc.emit(EMIT.layoutChanged, { root: 'window-1' });

    expect(seen).toEqual([]);
  });
});

/**
 * The control-plane namespaces, as ONE client of `control:invoke` and
 * `control:subscribe`.
 *
 * These assert the two things Stage 2 bought and the CLI never needed: a
 * subscription that starts with the topic's current value, and a nudge the
 * reader acknowledges. They are asserted HERE rather than only in core because
 * the preload is where a page's `agents.onChanged` becomes a topic name — and
 * that translation is the whole of what keeps a compromised page from naming
 * one.
 */
describe('the control plane, from the page\'s side', () => {
  it('never lets the page name a topic — every subscribe carries a constant', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    bridge.agents.onChanged(() => undefined);
    bridge.settings.onChanged(() => undefined);
    bridge.settings.onVisibility(() => undefined);
    bridge.views.onChanged(() => undefined);

    const topics = ipc.log
      .filter((entry) => entry.kind === 'invoke' && entry.channel === INVOKE.controlSubscribe)
      .map((entry) => entry.args[1]);
    expect(topics).toEqual([
      CONTROL_TOPICS.agents,
      CONTROL_TOPICS.settingsChanged,
      CONTROL_TOPICS.settingsVisibility,
      CONTROL_TOPICS.views,
    ]);
  });

  it('delivers a topic\'s SNAPSHOT to the same listener the deltas reach', () => {
    // The Stage 2 win: one code path, not a read plus a subscribe plus a merge
    // rule for the race between them.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const seen: unknown[] = [];
    bridge.agents.onChanged((indicators) => seen.push(indicators));

    ipc.emit(EMIT.controlFrame, {
      subscription: 's1',
      frame: { kind: 'snapshot', topic: CONTROL_TOPICS.agents, seq: 0, value: [{ sessionId: 'a', state: 'idle' }] },
    });
    ipc.emit(EMIT.controlFrame, {
      subscription: 's1',
      frame: { kind: 'event', topic: CONTROL_TOPICS.agents, seq: 1, payload: [{ sessionId: 'a', state: 'working' }] },
    });

    expect(seen).toEqual([[{ sessionId: 'a', state: 'idle' }], [{ sessionId: 'a', state: 'working' }]]);
  });

  it('routes a frame only to the subscription it is addressed to', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const agents: unknown[] = [];
    const settings: unknown[] = [];
    bridge.agents.onChanged((value) => agents.push(value));
    bridge.settings.onChanged((value) => settings.push(value));

    ipc.emit(EMIT.controlFrame, {
      subscription: 's2',
      frame: { kind: 'event', topic: CONTROL_TOPICS.settingsChanged, seq: 1, payload: { key: 'k', value: 1 } },
    });

    expect(agents).toEqual([]);
    expect(settings).toEqual([{ key: 'k', value: 1 }]);
  });

  it('acknowledges a nudge, which is what lets the next one arrive', () => {
    // Without the pull the reader gets exactly one nudge for the life of the
    // window: the whole point of the outstanding flag is that nothing else is
    // sent until the reader says it has read.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const changed: string[] = [];
    bridge.views.onChanged((type) => changed.push(type));

    ipc.emit(EMIT.controlFrame, {
      subscription: 's1',
      frame: { kind: 'nudge', topic: CONTROL_TOPICS.views, seq: 1, coalesced: 0, keys: ['tasks.tree'] },
    });

    expect(changed).toEqual(['tasks.tree']);
    expect(ipc.log.filter((entry) => entry.channel === INVOKE.controlPull)).toHaveLength(1);
  });

  it('reports a keyless nudge as the empty type — "re-read what you hold"', () => {
    // Main sends `''` when the SET of views changed rather than one of them, and
    // a coalesced nudge that saw one of those names nothing at all.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const changed: string[] = [];
    bridge.views.onChanged((type) => changed.push(type));

    ipc.emit(EMIT.controlFrame, {
      subscription: 's1',
      frame: { kind: 'nudge', topic: CONTROL_TOPICS.views, seq: 1, coalesced: 4 },
    });

    expect(changed).toEqual(['']);
  });

  it('stops delivering, and says so upstream, when a follower unsubscribes', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const seen: unknown[] = [];
    const off = bridge.agents.onChanged((value) => seen.push(value));
    off();

    ipc.emit(EMIT.controlFrame, {
      subscription: 's1',
      frame: { kind: 'event', topic: CONTROL_TOPICS.agents, seq: 1, payload: [] },
    });

    expect(seen).toEqual([]);
    expect(ipc.log.filter((entry) => entry.channel === INVOKE.controlUnsubscribe)).toHaveLength(1);
  });

  it('unwraps the envelope views.list answers in', () => {
    // `views.list` answers `{ views: [...] }` because that is what a paired
    // member reads off another Mac. A cast would have typechecked while handing
    // the page the wrapper — and the dock would have drawn nothing, with the
    // answer sitting right there.
    const ipc = fakeIpc();
    ipc.answer = { ok: true, value: { views: [{ type: 'tasks.tree' }] } };
    const bridge = createBridge(ipc);
    return expect(bridge.views.list()).resolves.toEqual({ ok: true, value: [{ type: 'tasks.tree' }] });
  });
});
