import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  manualClock,
  paneId,
  type PaneID,
  s,
  sessionId,
  type Caller,
  type KV,
  type LogRecord,
  type Logger,
  type ManualClock,
  type SessionID,
} from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants } from '../commands/authorize.ts';
import { LayoutStore, type SessionSink } from './store.ts';
import { LAYOUT_COMMANDS, registerLayoutCommands } from './commands.ts';
import { leafIds } from './tree.ts';

const USER: Caller = { kind: 'user' };

/** A KV backed by a Map — the store's contract is get/set, not SQLite. */
function fakeKV(): KV & { readonly raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: <T>(key: string) => raw.get(key) as T | undefined,
    set: (key, value) => void raw.set(key, value),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()],
  };
}

let records: LogRecord[];
let logger: Logger;
let clock: ManualClock;
let killed: SessionID[];
let sessions: SessionSink;
let ids: number;

beforeEach(() => {
  records = [];
  clock = manualClock(0);
  logger = createLogger({ clock, level: 'debug', sink: (_l, r) => records.push(r) });
  killed = [];
  sessions = { kill: (id) => killed.push(id) };
  ids = 0;
});

const messages = () => records.map((r) => r.message);
/** Deterministic pane ids, so a test can name the pane it means. */
const newPane = () => `p${++ids}`;

function build(storage?: KV): LayoutStore {
  return new LayoutStore({ logger, clock, sessions, newPane, ...(storage ? { storage } : {}) });
}

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 600 };

describe('a root', () => {
  it('opens with one pane, focused', () => {
    const store = build();
    const root = store.open();
    expect(store.panes(root)).toEqual(['p1']);
    expect(store.focused(root)).toBe('p1');
  });

  it('splits, focusing the new pane and inheriting the cwd', () => {
    const store = build();
    const root = store.open();
    store.observe(paneId('p1'), { cwd: '/src/app' });

    const split = store.split(root, 'row');
    expect(split).toEqual({ ok: true, value: 'p2' });
    expect(store.panes(root)).toEqual(['p1', 'p2']);
    expect(store.focused(root)).toBe('p2');
    expect(store.pane(paneId('p2'))?.cwd).toBe('/src/app');
  });

  it('splitting clears zoom', () => {
    // A zoomed pane starving its brand-new sibling to 0x0 is a split the user
    // cannot see.
    const store = build();
    const root = store.open();
    store.zoom(paneId('p1'));
    expect(store.zoomed(root)).toBe('p1');
    store.split(root, 'row');
    expect(store.zoomed(root)).toBeNull();
  });

  it('resolves a stale focus rather than going silently no-op', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row'); // focus = p2
    store.close(paneId('p2'));
    // p2 is gone; `focused` must not keep returning it or every later command
    // targets a pane that does not exist.
    expect(store.focused(root)).toBe('p1');
  });
});

describe('focus by direction', () => {
  it('moves to the geometric neighbour using the PUSHED viewport', () => {
    // Core has no DOM. The renderer publishes the rect on resize, exactly as v1
    // fed the content rect to its store — which is what lets a focus command take
    // no rect argument and therefore be invokable from the CLI.
    const store = build();
    const root = store.open();
    store.setViewport(root, VIEWPORT);
    store.split(root, 'row'); // p1 | p2, focus on p2

    expect(store.focusDirection(root, 'left')).toEqual({ ok: true, value: 'p1' });
    expect(store.focused(root)).toBe('p1');
  });

  it('the edge of the layout is null, not an error', () => {
    const store = build();
    const root = store.open();
    store.setViewport(root, VIEWPORT);
    const result = store.focusDirection(root, 'left');
    expect(result).toEqual({ ok: true, value: null });
  });

  it('finds nothing when no viewport has been pushed yet', () => {
    // A zero-size rect gives every pane the same empty frame, so there is no
    // neighbour to resolve. It must answer "nowhere to go" rather than throw.
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    expect(store.focusDirection(root, 'left')).toEqual({ ok: true, value: null });
  });
});

describe('closing a pane ends its session', () => {
  it('kills the bound session and reports which', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.bindSession(paneId('p2'), sessionId('s-2'));

    const outcome = store.close(paneId('p2'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p2', endedSession: 's-2', wasLastPane: false } });
    expect(killed).toEqual(['s-2']);
    // The other session is untouched — closing one pane is not closing a tab.
    expect(store.sessionFor(paneId('p1'))).toBe('s-1');
  });

  it('a pane with no session closes cleanly', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    const outcome = store.close(paneId('p2'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p2', wasLastPane: false } });
    expect(killed).toEqual([]);
  });

  it('the last pane reports wasLastPane and still ends its session', () => {
    const store = build();
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    const outcome = store.close(paneId('p1'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p1', endedSession: 's-1', wasLastPane: true } });
    expect(killed).toEqual(['s-1']);
  });

  it('focus lands on the sibling', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.close(paneId('p1'));
    expect(store.focused(root)).toBe('p2');
  });

  it('NOTHING else ends a session', () => {
    // The whole rebuild rests on this. A focus change, a rename, an observed cwd,
    // a re-projection — none of them is allowed to reach `kill`.
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.bindSession(paneId('p1'), sessionId('s-1'));

    store.focusPane(paneId('p1'));
    store.rename(paneId('p1'), 'renamed');
    store.observe(paneId('p1'), { cwd: '/elsewhere', title: 'vim' });
    store.zoom(paneId('p1'));
    store.setViewport(root, VIEWPORT);
    store.project(root);

    expect(killed).toEqual([]);
  });

  it('a session that exits on its own unbinds without closing the pane', () => {
    const store = build();
    const root = store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.unbindSession(sessionId('s-1'));
    expect(store.sessionFor(paneId('p1'))).toBeUndefined();
    expect(store.panes(root)).toEqual(['p1']);
    expect(killed).toEqual([]);
  });

  it('rebinding a pane drops the old reverse mapping', () => {
    const store = build();
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.bindSession(paneId('p1'), sessionId('s-2'));
    expect(store.paneForSession(sessionId('s-1'))).toBeUndefined();
    expect(store.paneForSession(sessionId('s-2'))).toBe('p1');
  });
});

describe('persistence', () => {
  it('is debounced, not written per mutation', () => {
    // v1 re-encoded its whole state on every `cd`. A drag or a burst of splits
    // would do the same here without this.
    const kv = fakeKV();
    const store = build(kv);
    const root = store.open();
    store.split(root, 'row');
    store.split(root, 'column');
    expect(kv.raw.size).toBe(0);

    clock.advance(400);
    expect(kv.raw.has('layout')).toBe(true);
  });

  it('flush() writes immediately — what app-quit needs', () => {
    const kv = fakeKV();
    const store = build(kv);
    store.open();
    store.flush();
    expect(kv.raw.has('layout')).toBe(true);
  });

  it('carries schemaVersion IN the payload', () => {
    const kv = fakeKV();
    const store = build(kv);
    store.open();
    store.flush();
    expect((kv.raw.get('layout') as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it('zoom alone never schedules a write', () => {
    const kv = fakeKV();
    const store = build(kv);
    store.open();
    clock.advance(400); // drain the open()
    kv.raw.clear();

    store.zoom(paneId('p1'));
    clock.advance(400);
    expect(kv.raw.size).toBe(0);
  });

  it('restores the tree shape with FRESH pane ids and no sessions', () => {
    // Live state never survives a restart, and reusing an id would let a stale
    // binding from the previous run resolve to a new pane.
    const kv = fakeKV();
    const first = build(kv);
    const root = first.open();
    first.split(root, 'row');
    first.bindSession(paneId('p1'), sessionId('s-1'));
    first.flush();

    ids = 100; // the second store mints from a different sequence
    const second = build(kv);
    const restored = second.open();
    expect(second.panes(restored)).toHaveLength(2);
    expect(second.panes(restored)).not.toContain('p1');
    expect(second.sessionFor(second.panes(restored)[0]!)).toBeUndefined();
  });

  it('restores cwd and userTitle, but not the live title', () => {
    const kv = fakeKV();
    const first = build(kv);
    first.open();
    first.observe(paneId('p1'), { cwd: '/src/app', title: 'vim' });
    first.rename(paneId('p1'), 'the one');
    first.flush();

    const second = build(kv);
    const restored = second.open();
    const pane = second.pane(second.panes(restored)[0]!);
    expect(pane?.cwd).toBe('/src/app');
    expect(pane?.userTitle).toBe('the one');
    expect(pane?.title).toBe('');
  });

  it('starts fresh on a corrupt tree rather than refusing to open', () => {
    // This is a restore path. Throwing here costs a window that never opens; the
    // cost of ignoring it is one lost layout.
    const kv = fakeKV();
    kv.set('layout', { schemaVersion: 1, roots: [{ id: 'window-1', tree: { kind: 'nonsense' }, focusedPaneId: null }] });
    const store = build(kv);
    const root = store.open();
    expect(store.panes(root)).toHaveLength(1);
    expect(messages().some((m) => m.includes('could not restore'))).toBe(true);
  });

  it('starts fresh on an unrecognized schemaVersion', () => {
    const kv = fakeKV();
    kv.set('layout', { schemaVersion: 99, roots: [] });
    const store = build(kv);
    expect(store.panes(store.open())).toHaveLength(1);
    expect(messages().some((m) => m.includes('schemaVersion'))).toBe(true);
  });
});

describe('change notification', () => {
  it('fires on a structural change and survives a throwing listener', () => {
    const store = build();
    const seen: string[] = [];
    store.onDidChange(() => {
      throw new Error('listener bug');
    });
    store.onDidChange((root) => seen.push(root));

    const root = store.open();
    store.split(root, 'row');
    expect(seen.length).toBeGreaterThan(1);
    expect(messages().some((m) => m.includes('listener bug'))).toBe(true);
  });

  it('does NOT fire for a viewport push', () => {
    // Geometry does not change the tree, and notifying would re-render the
    // renderer that just told us its size — a loop.
    const store = build();
    const root = store.open();
    let count = 0;
    store.onDidChange(() => count++);
    store.setViewport(root, VIEWPORT);
    expect(count).toBe(0);
  });
});

describe('projection', () => {
  it('renders a terminal leaf for a bound pane and an empty view otherwise', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.bindSession(paneId('p1'), sessionId('s-1'));

    const projected = store.project(root);
    expect(projected?.regions.main).toMatchObject({
      kind: 'split',
      axis: 'row',
      children: [
        { kind: 'leaf', id: 'p1', view: { kind: 'terminal', sessionId: 's-1' } },
        { kind: 'leaf', id: 'p2', view: { kind: 'view', type: 'terminal.empty' } },
      ],
    });
  });

  it('reports focus and zoom', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.zoom(paneId('p2'));
    expect(store.project(root)).toMatchObject({ focused: 'p2', zoomed: 'p2' });
  });
});

describe('as commands', () => {
  function wired() {
    const store = build();
    const registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
    const lastPaneClosed = vi.fn();
    const subscription = registerLayoutCommands({ store, registry, onLastPaneClosed: lastPaneClosed });
    const root = store.open();
    store.setViewport(root, VIEWPORT);
    return { store, registry, root, lastPaneClosed, subscription };
  }

  it('splits through the registry', async () => {
    const { registry, store, root } = wired();
    const result = await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    expect(result).toEqual({ ok: true, value: 'p2' });
    expect(store.panes(root)).toEqual(['p1', 'p2']);
  });

  it('defaults to the only root, so a keystroke names nothing', async () => {
    const { registry } = wired();
    const result = await registry.invoke(LAYOUT_COMMANDS.focusDirection, { direction: 'left' }, USER);
    expect(result).toEqual({ ok: true, value: { focused: null } });
  });

  it('close defaults to the focused pane', async () => {
    const { registry, store, root } = wired();
    await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER); // focus = p2
    const result = await registry.invoke(LAYOUT_COMMANDS.close, {}, USER);
    expect(result).toMatchObject({ ok: true, value: { closed: 'p2', wasLastPane: false } });
    expect(store.panes(root)).toEqual(['p1']);
  });

  it('names a pane when a CLI or an extension asks about one it does not focus', async () => {
    const { registry, store, root } = wired();
    await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    await registry.invoke(LAYOUT_COMMANDS.close, { pane: 'p1' }, USER);
    expect(store.panes(root)).toEqual(['p2']);
  });

  it('only the LAST pane reaches the window', async () => {
    // Any other pane closing a window is the classic Electron bug where a split
    // disappears because one of its panes was closed.
    const { registry, lastPaneClosed } = wired();
    await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    await registry.invoke(LAYOUT_COMMANDS.close, {}, USER);
    expect(lastPaneClosed).not.toHaveBeenCalled();

    await registry.invoke(LAYOUT_COMMANDS.close, {}, USER);
    expect(lastPaneClosed).toHaveBeenCalledTimes(1);
  });

  it('a store failure becomes a typed command error, not a throw', async () => {
    const { registry } = wired();
    const result = await registry.invoke(LAYOUT_COMMANDS.focusPane, { pane: 'ghost' }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('handler-failed');
      expect(result.error.message).toContain('ghost');
    }
  });

  it('validates arguments before touching the store', async () => {
    const { registry, store, root } = wired();
    const result = await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'diagonal' }, USER);
    expect(result.ok).toBe(false);
    expect(store.panes(root)).toEqual(['p1']);
  });

  it('every layout command demands the layout permission', async () => {
    // So an extension cannot reshape the user's window without having asked.
    const store = build();
    const registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
    registerLayoutCommands({ store, registry, onLastPaneClosed: () => {} });
    store.open();

    const caller: Caller = { kind: 'device', deviceId: 'phone' };
    for (const id of Object.values(LAYOUT_COMMANDS)) {
      const result = await registry.invoke(id, {}, caller);
      expect(result.ok, `${id} should be denied`).toBe(false);
      if (!result.ok) expect(result.error.code, `${id}`).toBe('denied');
    }
  });

  it('disposing unregisters the whole table', () => {
    const { registry, subscription } = wired();
    subscription.dispose();
    for (const id of Object.values(LAYOUT_COMMANDS)) expect(registry.has(id)).toBe(false);
  });

  it('setRatio clamps rather than accepting a degenerate split', async () => {
    const { registry, store, root } = wired();
    await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    await registry.invoke(LAYOUT_COMMANDS.setRatio, { path: [], ratio: 0.001 }, USER);
    const tree = store.tree(root);
    expect(tree?.kind).toBe('split');
    if (tree?.kind === 'split') expect(tree.ratio).toBeGreaterThanOrEqual(0.1);
  });

  it('rejects a non-finite ratio', async () => {
    const { registry } = wired();
    await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    const result = await registry.invoke(LAYOUT_COMMANDS.setRatio, { path: [], ratio: Number.NaN }, USER);
    // The schema catches it first: `s.number()` is finite-only precisely so a NaN
    // cannot reach a split ratio.
    expect(result.ok).toBe(false);
  });
});

describe('leafIds still describes the tree the store holds', () => {
  it('agrees with panes()', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.split(root, 'column');
    expect(leafIds(store.tree(root)!)).toEqual(store.panes(root));
  });
});

describe('the initial-input seam (M3 D10)', () => {
  it('hands a pane’s initial command over exactly once', () => {
    // v1's hardest rule here: `takeInitialInput` is THE seam, and it is one-shot.
    // Two ways to type the first thing into a session is how a resume races a
    // prompt; a seam that can fire twice is how a prompt is submitted twice.
    const store = build();
    const root = store.open();
    const pane = store.focused(root) as PaneID;
    store.setInitialInput(pane, 'claude --resume abc\n');

    expect(store.takeInitialInput(pane)).toBe('claude --resume abc\n');
    expect(store.takeInitialInput(pane)).toBeUndefined();
  });

  it('is absent for a pane that was never given one', () => {
    const store = build();
    const root = store.open();
    expect(store.takeInitialInput(store.focused(root) as PaneID)).toBeUndefined();
  });

  it('is absent for a pane that does not exist', () => {
    expect(build().takeInitialInput(paneId('nope'))).toBeUndefined();
  });

  it('never reaches disk — a relaunch must not re-run a command', () => {
    // `serialize.ts` excludes `initialCommand` on purpose. Setting one and
    // restoring must not resurrect it, or every relaunch replays the prompt.
    const storage = fakeKV();
    const first = build(storage);
    const root = first.open();
    first.setInitialInput(first.focused(root) as PaneID, 'claude "do the thing"\n');
    first.flush();

    const second = build(storage);
    const restored = second.open();
    expect(second.takeInitialInput(second.focused(restored) as PaneID)).toBeUndefined();
  });
});
