import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one thing this file owns that core does not: **which root the window is
 * showing.** That is a property of the window, not of the layout — the store
 * holds N pane groups and has no opinion about which one is on screen — so the
 * claims here are about the envelope the page receives and about who is told
 * when the answer changes.
 *
 * Electron is swapped for a recorder, in `bootstrap.test.ts`'s idiom: the
 * handlers are captured by channel and invoked directly, so what is asserted is
 * the value that would cross the wire rather than a window's behaviour.
 */

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const contents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) };
  return {
    handlers,
    sent,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
        void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
    },
    webContents: { getAllWebContents: () => [contents] },
  };
});

vi.mock('electron', () => ({ ipcMain: electron.ipcMain, webContents: electron.webContents }));

// After the mock, so the module under test binds to the recorder.
import { CommandRegistry, emptyGrants } from '@shepherd/core';
import { LayoutStore } from '@shepherd/core/layout';
import { nullLogger, rootId, systemClock, type RootID, type SessionID } from '@shepherd/sdk';
import { EMIT, INVOKE, type IpcResult, type LayoutSnapshots } from '../shared/index.ts';
import { registerLayoutIpc, type LayoutIpc } from './layout-ipc.ts';

const HOME = rootId('window-1');
const TASK = rootId('task-1');

interface Harness {
  readonly ipc: LayoutIpc;
  readonly store: LayoutStore;
  readonly switched: RootID[];
}

let live: LayoutIpc | undefined;

function harness(): Harness {
  const killed: SessionID[] = [];
  const store = new LayoutStore({
    logger: nullLogger,
    clock: systemClock,
    sessions: { kill: (id) => void killed.push(id) },
  });
  store.open(HOME);
  store.open(TASK);
  const switched: RootID[] = [];
  const ipc = registerLayoutIpc({
    store,
    registry: new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() }),
    active: HOME,
    onActiveChanged: (root) => void switched.push(root),
  });
  live = ipc;
  return { ipc, store, switched };
}

/** The last thing pushed on `layout:changed`, as the page would receive it. */
function lastPush(): LayoutSnapshots | undefined {
  const pushes = electron.sent.filter((entry) => entry.channel === EMIT.layoutChanged);
  return pushes.at(-1)?.payload as LayoutSnapshots | undefined;
}

async function get(): Promise<IpcResult<LayoutSnapshots>> {
  const handler = electron.handlers.get(INVOKE.layoutGet);
  if (handler === undefined) throw new Error('layout:get was never registered');
  return (await handler(null)) as IpcResult<LayoutSnapshots>;
}

beforeEach(() => {
  electron.handlers.clear();
  electron.sent.length = 0;
});

afterEach(() => {
  live?.dispose();
  live = undefined;
});

describe('the layout envelope', () => {
  it('answers layout:get with EVERY root and the active one', async () => {
    // The page keeps all of them mounted and hides the inactive ones, so a root
    // it was never told about would have to be BUILT on the switch — and
    // building a pane is creating a pty.
    harness();
    const result = await get();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.active).toBe('window-1');
    expect(result.value.roots.map((root) => root.root)).toEqual(['window-1', 'task-1']);
  });

  it('republishes on a change in ANY root, not just the active one', () => {
    // A hidden root's panes keep running. A push that stopped at the active root
    // would leave a task's layout frozen at whatever it looked like when you
    // last looked at it.
    const { store } = harness();
    electron.sent.length = 0;
    store.split(TASK, 'row');
    const pushed = lastPush();
    expect(pushed?.roots.find((root) => root.root === 'task-1')?.tree.kind).toBe('split');
  });

  it('reports no root at all rather than an empty window it invented', async () => {
    const store = new LayoutStore({ logger: nullLogger, clock: systemClock, sessions: { kill: () => {} } });
    live = registerLayoutIpc({
      store,
      registry: new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() }),
      active: HOME,
    });
    const result = await get();
    expect(result).toMatchObject({ ok: false, error: { code: 'no-root' } });
  });
});

describe('the active root', () => {
  it('setActive moves it, tells its listener, and pushes in the same turn', () => {
    const { ipc, switched } = harness();
    electron.sent.length = 0;

    ipc.setActive(TASK);

    expect(ipc.getActive()).toBe('task-1');
    // Presence is wired to this callback. Without it `isFrontPane` answers about
    // a root nobody can see and attention clears on unseen panes (ADR 0020).
    expect(switched).toEqual(['task-1']);
    expect(lastPush()?.active).toBe('task-1');
  });

  it('setting the root that is already active changes nothing and says nothing', () => {
    const { ipc, switched } = harness();
    electron.sent.length = 0;
    ipc.setActive(HOME);
    expect(switched).toEqual([]);
    expect(electron.sent).toEqual([]);
  });

  it('a viewport rect lands on the ACTIVE root', () => {
    // Every root is drawn into the same stage and the hidden ones measure 0x0,
    // so the rect the page just measured describes exactly this one. A root that
    // never got one has a degenerate frame and `focusDirection` answers null in
    // every direction, silently.
    const { ipc, store } = harness();
    const handler = electron.handlers.get(INVOKE.layoutViewport);
    if (handler === undefined) throw new Error('layout:viewport was never registered');

    handler(null, { x: 0, y: 0, width: 800, height: 600 });
    expect(store.viewport(HOME)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(store.viewport(TASK)).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    ipc.setActive(TASK);
    handler(null, { x: 0, y: 0, width: 400, height: 300 });
    expect(store.viewport(TASK)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('refuses a viewport that is not finite, rather than poisoning every frame', () => {
    const { store } = harness();
    const handler = electron.handlers.get(INVOKE.layoutViewport);
    const result = handler?.(null, { x: 0, y: 0, width: Number.NaN, height: 600 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(store.viewport(HOME)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
