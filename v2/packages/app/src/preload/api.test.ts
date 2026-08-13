import { describe, expect, it } from 'vitest';
import { BRIDGE_SURFACE, EMIT, INVOKE } from '../shared/index.ts';
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

interface Recorded {
  readonly kind: 'invoke' | 'on' | 'off';
  readonly channel: string;
  readonly args: readonly unknown[];
}

function fakeIpc(): IpcLike & {
  readonly log: Recorded[];
  emit(channel: string, payload: unknown): void;
  readonly listenerCount: number;
} {
  const log: Recorded[] = [];
  let listeners: Array<{ channel: string; fn: (event: unknown, ...args: unknown[]) => void }> = [];
  return {
    log,
    get listenerCount() {
      return listeners.length;
    },
    invoke: (channel, ...args) => {
      log.push({ kind: 'invoke', channel, args });
      return Promise.resolve({ ok: true, value: undefined });
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
    void bridge.session.kill('s1');
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

    expect(ipc.log).toHaveLength(16);
    for (const entry of ipc.log) expect(known, entry.channel).toContain(entry.channel);
  });

  it('defaults a command with no arguments to `{}`, not `undefined`', () => {
    // Every layout command's schema is an `s.object`, and `s.object` on
    // `undefined` is an `invalid-args` failure — so ⌘W, which genuinely takes no
    // arguments, would be rejected for sending none.
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);

    void bridge.commands.invoke('layout.close');

    expect(ipc.log[0]).toEqual({
      kind: 'invoke',
      channel: INVOKE.commandInvoke,
      args: ['layout.close', {}],
    });
  });

  it('passes arguments through unchanged, in order', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const bytes = new Uint8Array([1, 2, 3]);

    void bridge.session.write('s7', bytes);
    void bridge.session.resize('s7', 120, 40);

    expect(ipc.log[0]).toEqual({ kind: 'invoke', channel: INVOKE.sessionWrite, args: ['s7', bytes] });
    expect(ipc.log[1]).toEqual({
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
    expect(ipc.listenerCount).toBe(0);
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
