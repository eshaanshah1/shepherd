import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer's half of the control plane, asserted at the wire.
 *
 * Electron is swapped for a recorder, in `layout-ipc.test.ts`'s idiom: handlers
 * are captured by channel and invoked directly, so what is asserted is the value
 * that would cross rather than a window's behaviour. The surface underneath is a
 * REAL `ControlSurface` over a real registry and bus — a fake one would only
 * prove that this file forwards arguments, and the interesting claims (a
 * snapshot arriving before any delta, a nudge staying outstanding until a pull)
 * belong to the object being forwarded to.
 */

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  let destroyed = false;
  const listeners = new Map<string, () => void>();
  const contents = {
    id: 7,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => void sent.push({ channel, payload }),
    once: (event: string, fn: () => void) => void listeners.set(event, fn),
  };
  return {
    handlers,
    sent,
    contents,
    destroy: () => {
      destroyed = true;
      listeners.get('destroyed')?.();
    },
    reset: () => {
      handlers.clear();
      sent.length = 0;
      listeners.clear();
      destroyed = false;
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
        void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
    },
  };
});

vi.mock('electron', () => ({ ipcMain: electron.ipcMain }));

// After the mock, so the module under test binds to the recorder.
import { CommandRegistry, ControlSurface, EventBus, TopicRegistry, emptyGrants } from '@shepherd/core';
import { KERNEL, nullLogger, s, systemClock, type Disposable } from '@shepherd/sdk';
import { EMIT, INVOKE, type ControlFrameMessage, type IpcResult } from '../shared/index.ts';
import { registerControlIpc } from './control-ipc.ts';

let live: Disposable | undefined;
let registry: CommandRegistry;
let bus: EventBus;
let topics: TopicRegistry;

const EVENT = { sender: electron.contents };

beforeEach(() => {
  electron.reset();
  registry = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
  bus = new EventBus({ clock: systemClock, logger: nullLogger });
  topics = new TopicRegistry();
});

afterEach(() => {
  live?.dispose();
  live = undefined;
});

function start(): void {
  live = registerControlIpc({
    surface: new ControlSurface({ commands: registry, bus, logger: nullLogger, topics }),
    logger: nullLogger,
  });
}

function call(channel: string, ...args: unknown[]): unknown {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler(EVENT, ...args);
}

/** Frames the page would have received, in arrival order. */
function frames(): ControlFrameMessage[] {
  return electron.sent
    .filter((message) => message.channel === EMIT.controlFrame)
    .map((message) => message.payload as ControlFrameMessage);
}

describe('control:invoke', () => {
  it('reaches the one verb table and answers with a value', async () => {
    registry.register('demo.echo', { schema: s.object({ x: s.int() }), handler: (a) => a.x + 1 });
    start();
    await expect(call(INVOKE.controlInvoke, 'demo.echo', { x: 1 })).resolves.toEqual({ ok: true, value: 2 });
  });

  it('reports a failure as a VALUE with the registry\'s own code', async () => {
    // A rejected `invoke` reaches the renderer as an Error whose message Electron
    // has mangled and whose `code` is gone.
    start();
    await expect(call(INVOKE.controlInvoke, 'nope', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown-command' },
    });
  });

  it('refuses a command that is not a string, rather than asking the registry', async () => {
    start();
    await expect(call(INVOKE.controlInvoke, 42, {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
  });

  it('asserts USER itself — the page never names a caller', async () => {
    // A renderer that could name its own caller kind could name `{kind:'agent'}`
    // and inherit an agent's grants. The attribution is made by the side that
    // knows, which is this one.
    const callers: string[] = [];
    registry.register('demo.who', {
      schema: s.nothing(),
      handler: (_a, caller) => void callers.push(caller.kind),
    });
    start();
    await call(INVOKE.controlInvoke, 'demo.who', {});
    expect(callers).toEqual(['user']);
  });
});

/**
 * `control:list` — what the palette reads.
 *
 * The filter is HERE rather than in the page, and it is not this handler's
 * policy: the SDK documents `title` as "shown in the palette ... Absent = not
 * user-facing". Until a channel read that field, `layout.zoom`, `layout.rename`
 * and every `tasks.*` verb had a user-facing name and no way for a user to say
 * it.
 */
describe('control:list', () => {
  function withCommands(): void {
    registry.register('layout.zoom', { title: 'Toggle Zoom', schema: s.nothing(), handler: () => undefined });
    // No title: its author said it is plumbing, not a verb a user names.
    registry.register('internal.reconcile', { schema: s.nothing(), handler: () => undefined });
    registry.register('tasks.create', {
      title: 'Tasks: New Task',
      permission: 'layout',
      schema: s.nothing(),
      handler: () => undefined,
    });
  }

  /**
   * MUTATION TARGET. Dropping the filter — returning the list straight through —
   * leaves every other assertion in this file green and puts an untitled command
   * in the palette with an empty label. The narrowed return type is the other
   * half of the guard: `title: string`, not `title?: string`.
   */
  it('returns only the commands that have a title', () => {
    withCommands();
    start();
    expect(call(INVOKE.controlList)).toEqual({
      ok: true,
      value: [
        { id: 'layout.zoom', title: 'Toggle Zoom' },
        { id: 'tasks.create', title: 'Tasks: New Task' },
      ],
    });
  });

  it('does not filter by permission, so there is one authorization model', () => {
    // Every palette command is invoked as `{kind:'user'}`, which `authorize`
    // allows unconditionally — pre-filtering here would be a second model that
    // could disagree with the real one. `control:invoke` decides.
    withCommands();
    start();
    const result = call(INVOKE.controlList) as IpcResult<readonly { id: string }[]>;
    expect(result.ok && result.value.map((command) => command.id)).toContain('tasks.create');
  });
});

describe('control:subscribe', () => {
  it('sends the topic\'s snapshot before any delta', () => {
    // The whole Stage 2 claim: a page never folds a change onto a state it never
    // saw, and never has to merge a late snapshot under an early event.
    topics.declare({ topic: 'demo.state', delivery: 'push', snapshot: () => ({ count: 3 }) });
    start();

    call(INVOKE.controlSubscribe, 'sub-1', 'demo.state');
    bus.emit('demo.state', { count: 4 }, KERNEL);

    expect(frames().map((message) => message.frame)).toEqual([
      { kind: 'snapshot', topic: 'demo.state', seq: 0, value: { count: 3 } },
      expect.objectContaining({ kind: 'event', seq: 1, payload: { count: 4 } }),
    ]);
  });

  it('addresses every frame to the subscription that asked for it', () => {
    // One channel carries them all, so the id is the only thing that routes a
    // frame back to its follower.
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    call(INVOKE.controlSubscribe, 'b', 'demo.two');
    bus.emit('demo.two', 1, KERNEL);
    expect(frames().map((message) => message.subscription)).toEqual(['b']);
  });

  it('refuses a second subscription with an id already in use', () => {
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    expect(call(INVOKE.controlSubscribe, 'a', 'demo.two')).toMatchObject({
      ok: false,
      error: { code: 'duplicate-subscription' },
    });
  });

  it('stops after control:unsubscribe', () => {
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    call(INVOKE.controlUnsubscribe, 'a');
    bus.emit('demo.one', 1, KERNEL);
    expect(frames()).toEqual([]);
  });

  it('never sends into a destroyed page', () => {
    // The frame arrives from a bus listener, so an unguarded `send` on a dead
    // `WebContents` throws inside whatever emitted.
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    electron.destroy();
    expect(() => bus.emit('demo.one', 1, KERNEL)).not.toThrow();
  });

  it('drops a destroyed page\'s subscriptions rather than leaking a listener per reload', () => {
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    electron.destroy();
    // Re-registering the same id must now succeed: the old one is gone.
    expect(call(INVOKE.controlSubscribe, 'a', 'demo.one')).toMatchObject({ ok: true });
  });
});

describe('control:pull', () => {
  it('is what lets a nudge topic nudge again', () => {
    topics.declare({ topic: 'views.changed', delivery: 'nudge' });
    start();
    call(INVOKE.controlSubscribe, 'a', 'views.changed');

    for (let i = 0; i < 10; i++) bus.emit('views.changed', 'tasks.tree', KERNEL);
    expect(frames()).toHaveLength(1);

    call(INVOKE.controlPull, 'a');
    expect(frames()).toHaveLength(2);
    expect(frames()[1]?.frame).toMatchObject({ kind: 'nudge', coalesced: 9 });
  });

  it('reports a pull for a subscription that is gone', () => {
    // A reader pulling a dead subscription waits forever for a nudge nobody can
    // send, and it has to be able to tell that from "you are caught up".
    start();
    expect(call(INVOKE.controlPull, 'nope')).toMatchObject({
      ok: false,
      error: { code: 'unknown-subscription' },
    });
  });
});

describe('teardown', () => {
  it('removes every channel it registered', () => {
    start();
    for (const channel of [
      INVOKE.controlInvoke,
      INVOKE.controlList,
      INVOKE.controlSubscribe,
      INVOKE.controlPull,
      INVOKE.controlUnsubscribe,
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(true);
    }
    live?.dispose();
    live = undefined;
    expect([...electron.handlers.keys()]).toEqual([]);
  });

  it('stops delivering to a subscription it held', () => {
    start();
    call(INVOKE.controlSubscribe, 'a', 'demo.one');
    live?.dispose();
    live = undefined;
    bus.emit('demo.one', 1, KERNEL);
    expect(frames()).toEqual([]);
  });
});
