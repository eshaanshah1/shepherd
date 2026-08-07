import { describe, expect, it } from 'vitest';
import {
  manualClock,
  nullLogger,
  rootId,
  sessionId,
  systemClock,
  toDisposable,
  type Disposable,
  type PaneID,
  type RootID,
  type SessionID,
} from '@shepherd/sdk';
import { LayoutStore } from '@shepherd/core/layout';
import type { SessionError, SessionExit, SessionInfo, SessionSpec } from '@shepherd/core';
import { COALESCE, EMIT, type SessionDataMessage, type SessionExitMessage } from '../shared/index.ts';
import { SessionBridge, type RendererTarget, type SessionHostLike } from './session-bridge.ts';

/**
 * A `SessionHostLike` whose bytes arrive when the test says so. The real host
 * is covered against a real pty in @shepherd/core; what is under test here is
 * how many times the bridge crosses the IPC boundary, which needs the producer
 * to be exact rather than realistic.
 */
class FakeHost implements SessionHostLike {
  readonly sinks = new Map<SessionID, Set<(b: Uint8Array) => void>>();
  readonly live = new Map<SessionID, SessionInfo>();
  #exitListeners = new Set<(e: SessionExit) => void>();
  #seq = 0;

  create(spec: SessionSpec) {
    const id = sessionId(`fake-${this.#seq++}`);
    const info: SessionInfo = {
      id,
      pid: 1000 + this.#seq,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args ? [...spec.args] : [],
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
    };
    this.live.set(id, info);
    return { ok: true as const, value: info };
  }
  get(id: SessionID) {
    return this.live.get(id);
  }
  list() {
    return [...this.live.values()];
  }
  attach(id: SessionID, sink: (b: Uint8Array) => void) {
    if (!this.live.has(id)) return { ok: false as const, error: unknown(id) };
    let set = this.sinks.get(id);
    if (!set) {
      set = new Set();
      this.sinks.set(id, set);
    }
    set.add(sink);
    return {
      ok: true as const,
      value: toDisposable(() => {
        set.delete(sink);
      }) as Disposable,
    };
  }
  write(id: SessionID) {
    return this.live.has(id)
      ? { ok: true as const, value: undefined }
      : { ok: false as const, error: unknown(id) };
  }
  paste(id: SessionID) {
    return this.write(id);
  }
  resize(id: SessionID) {
    return this.write(id);
  }
  kill(id: SessionID) {
    if (!this.live.has(id)) return { ok: false as const, error: unknown(id) };
    this.exit(id, 0);
    return { ok: true as const, value: undefined };
  }
  onExit(listener: (e: SessionExit) => void) {
    this.#exitListeners.add(listener);
    return toDisposable(() => {
      this.#exitListeners.delete(listener);
    });
  }

  // -- test drivers
  feed(id: SessionID, bytes: Uint8Array): void {
    for (const sink of [...(this.sinks.get(id) ?? [])]) sink(bytes);
  }
  exit(id: SessionID, exitCode: number): void {
    this.live.delete(id);
    this.sinks.delete(id);
    for (const l of [...this.#exitListeners]) l({ sessionId: id, exitCode });
  }
}

function unknown(id: SessionID): SessionError {
  return { code: 'unknown-session', message: `no live session ${id}`, sessionId: id };
}

class FakeTarget implements RendererTarget {
  readonly sent: { channel: string; payload: SessionDataMessage | SessionExitMessage }[] = [];
  readonly id: number;
  #destroyed = false;
  // Not a parameter property: `erasableSyntaxOnly` forbids them, because Node's
  // type stripping (which runs the Electron entry) can only erase, not emit.
  constructor(id: number) {
    this.id = id;
  }
  isDestroyed(): boolean {
    return this.#destroyed;
  }
  send(channel: string, payload: SessionDataMessage | SessionExitMessage): void {
    this.sent.push({ channel, payload });
  }
  destroy(): void {
    this.#destroyed = true;
  }
  data(): SessionDataMessage[] {
    return this.sent
      .filter((s) => s.channel === EMIT.sessionData)
      .map((s) => s.payload as SessionDataMessage);
  }
}

function setup(): { host: FakeHost; bridge: SessionBridge; clock: ReturnType<typeof manualClock> } {
  const host = new FakeHost();
  const clock = manualClock();
  return { host, bridge: new SessionBridge(host, { clock }), clock };
}

describe('SessionBridge output batching', () => {
  it('sends at most ceil(bytes / maxBytes) + 1 times for a 1 MB burst', () => {
    const { host, bridge, clock } = setup();
    const target = new FakeTarget(1);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(target, created.value.id);

    const total = 1024 * 1024;
    const chunk = 8 * 1024; // realistic pty read size — 128 onData events
    for (let written = 0; written < total; written += chunk) {
      host.feed(created.value.id, new Uint8Array(chunk).fill(0x78));
    }
    clock.advance(COALESCE.intervalMs); // whatever the size budget left behind

    const sends = target.data();
    const ceiling = Math.ceil(total / COALESCE.maxBytes) + 1;
    expect(sends.length).toBeLessThanOrEqual(ceiling);
    // …and it really did batch: 128 onData events became far fewer sends.
    expect(sends.length).toBeLessThan(128);

    const delivered = sends.reduce((n, s) => n + s.bytes.length, 0);
    expect(delivered).toBe(total);
    for (const s of sends) expect(s.bytes).toBeInstanceOf(Uint8Array);
  });

  it('a single keystroke echo still arrives, one interval later', () => {
    const { host, bridge, clock } = setup();
    const target = new FakeTarget(1);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(target, created.value.id);

    host.feed(created.value.id, new TextEncoder().encode('a'));
    expect(target.data()).toHaveLength(0);
    clock.advance(COALESCE.intervalMs);
    expect(target.data()).toHaveLength(1);
    expect(new TextDecoder().decode(target.data()[0]!.bytes)).toBe('a');
  });
});

describe('SessionBridge attachment lifecycle', () => {
  it('attaching twice from one target does not double the bytes', () => {
    const { host, bridge, clock } = setup();
    const target = new FakeTarget(1);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });

    bridge.attach(target, created.value.id);
    bridge.attach(target, created.value.id);

    host.feed(created.value.id, new TextEncoder().encode('once'));
    clock.advance(COALESCE.intervalMs);

    const text = target.data().map((d) => new TextDecoder().decode(d.bytes)).join('');
    expect(text).toBe('once');
  });

  it('fans one session out to two windows, and detaching one leaves the other', () => {
    const { host, bridge, clock } = setup();
    const a = new FakeTarget(1);
    const b = new FakeTarget(2);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(a, created.value.id);
    bridge.attach(b, created.value.id);

    host.feed(created.value.id, new TextEncoder().encode('both'));
    clock.advance(COALESCE.intervalMs);
    expect(a.data()).toHaveLength(1);
    expect(b.data()).toHaveLength(1);

    bridge.detach(a, created.value.id);
    host.feed(created.value.id, new TextEncoder().encode('only-b'));
    clock.advance(COALESCE.intervalMs);
    expect(a.data()).toHaveLength(1);
    expect(b.data()).toHaveLength(2);
  });

  it('a destroyed window is never sent to, and the session survives it', () => {
    const { host, bridge, clock } = setup();
    const target = new FakeTarget(1);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(target, created.value.id);

    target.destroy();
    host.feed(created.value.id, new TextEncoder().encode('x'));
    clock.advance(COALESCE.intervalMs);
    expect(target.sent).toHaveLength(0);

    // The v1 root finding, restated: losing the view must not lose the pty.
    bridge.detachAll(target.id);
    expect(host.list().map((s) => s.id)).toContain(created.value.id);
  });

  it('attach on an unknown session returns a typed error', () => {
    const { bridge } = setup();
    const target = new FakeTarget(1);
    const result = bridge.attach(target, sessionId('nope') as SessionID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-session');
  });
});

describe('SessionBridge exit', () => {
  it('flushes pending output before announcing the exit', () => {
    const { host, bridge } = setup();
    const target = new FakeTarget(1);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(target, created.value.id);

    // Output that has NOT yet hit either budget when the process ends — the
    // last line a program prints is exactly this case.
    host.feed(created.value.id, new TextEncoder().encode('goodbye\r\n'));
    host.exit(created.value.id, 3);

    const channels = target.sent.map((s) => s.channel);
    expect(channels).toEqual([EMIT.sessionData, EMIT.sessionExit]);
    expect(new TextDecoder().decode(target.data()[0]!.bytes)).toBe('goodbye\r\n');
    const exit = target.sent[1]!.payload as SessionExitMessage;
    expect(exit.exitCode).toBe(3);
    expect(exit.sessionId).toBe(created.value.id);
  });

  it('tells every attached window, once each', () => {
    const { host, bridge } = setup();
    const a = new FakeTarget(1);
    const b = new FakeTarget(2);
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    bridge.attach(a, created.value.id);
    bridge.attach(b, created.value.id);

    host.exit(created.value.id, 0);
    expect(a.sent.filter((s) => s.channel === EMIT.sessionExit)).toHaveLength(1);
    expect(b.sent.filter((s) => s.channel === EMIT.sessionExit)).toHaveLength(1);
  });
});

/**
 * The pane→session binding, which is what makes core's `layout.close` able to end
 * a session at all.
 *
 * It lives here rather than in `ipc.ts` for one reason: `ipc.ts` imports electron
 * and this does not, so the claim can be asserted against a REAL `LayoutStore`
 * with exact values instead of by closing a pane in a running app and looking at
 * `ps`. The store is the real one on purpose — the thing being tested is that
 * `store.close` reaches the pty, and a fake store would only prove that a method
 * was called.
 */
describe('SessionBridge → layout binding', () => {
  function withLayout(): {
    host: FakeHost;
    bridge: SessionBridge;
    store: LayoutStore;
    killed: SessionID[];
    root: RootID;
  } {
    const host = new FakeHost();
    const killed: SessionID[] = [];
    const store = new LayoutStore({
      logger: nullLogger,
      clock: systemClock,
      sessions: { kill: (id) => void killed.push(id) },
    });
    const root = rootId('window-1');
    store.open(root);
    const bridge = new SessionBridge(host, {
      clock: manualClock(),
      layout: {
        bind: (pane, session) => store.bindSession(pane, session),
        unbind: (session) => store.unbindSession(session),
      },
    });
    return { host, bridge, store, killed, root };
  }

  it('binds a created session to the pane that asked for it', () => {
    const h = withLayout();
    const pane = h.store.focused(h.root);
    expect(pane).not.toBeNull();

    const created = h.bridge.create({ cwd: '/tmp', command: '/bin/sh', paneId: pane as PaneID });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(h.store.sessionFor(pane as PaneID)).toBe(created.value.id);
  });

  it('so closing that pane ends the pty — the whole point of the binding', () => {
    const h = withLayout();
    const pane = h.store.focused(h.root) as PaneID;
    // Two panes, so the close is an ordinary one rather than the last-pane case.
    const second = h.store.split(h.root, 'row');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const a = h.bridge.create({ cwd: '/tmp', command: '/bin/sh', paneId: pane });
    const b = h.bridge.create({ cwd: '/tmp', command: '/bin/sh', paneId: second.value });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    h.store.close(second.value);

    // Exactly the closed pane's session, and nothing else's. Killing the wrong
    // one is the failure that looks like "closing a pane killed my agent".
    expect(h.killed).toEqual([b.value.id]);
    expect(h.store.sessionFor(pane)).toBe(a.value.id);
  });

  it('binds nothing for a session no pane asked for', () => {
    // A session with no `paneId` is legitimate (an extension's, later). Inventing
    // a pane for it would put a lie in the tree.
    const h = withLayout();
    const pane = h.store.focused(h.root) as PaneID;

    const created = h.bridge.create({ cwd: '/tmp', command: '/bin/sh' });

    expect(created.ok).toBe(true);
    expect(h.store.sessionFor(pane)).toBeUndefined();
  });

  it('unbinds a session that exited on its own, so the pane is not holding a corpse', () => {
    const h = withLayout();
    const pane = h.store.focused(h.root) as PaneID;
    const created = h.bridge.create({ cwd: '/tmp', command: '/bin/sh', paneId: pane });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    h.host.exit(created.value.id, 0);

    expect(h.store.sessionFor(pane)).toBeUndefined();
    // …and closing the pane now kills nothing, rather than a stale id.
    h.store.close(pane);
    expect(h.killed).toEqual([]);
  });

  it('works with no layout at all — the session smoke has none', () => {
    const { host, bridge } = setup();
    expect(() => bridge.create({ cwd: '/tmp', command: '/bin/sh' })).not.toThrow();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh' });
    expect(() => host.exit(created.value.id, 0)).not.toThrow();
  });
});
