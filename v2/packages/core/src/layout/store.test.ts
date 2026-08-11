import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  manualClock,
  paneId,
  type PaneID,
  rootId,
  type RootID,
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
let live: Set<SessionID>;
let sessions: SessionSink;
let ids: number;

beforeEach(() => {
  records = [];
  clock = manualClock(0);
  logger = createLogger({ clock, level: 'debug', sink: (_l, r) => records.push(r) });
  killed = [];
  live = new Set();
  // R1: the restore path asks whether a persisted binding is still alive, and
  // the daemon is what answers. Tests drive it through this set.
  sessions = { kill: (id) => killed.push(id), isLive: (id) => live.has(id) };
  ids = 0;
});

const messages = () => records.map((r) => r.message);
/** Deterministic pane ids, so a test can name the pane it means. */
const newPane = () => `p${++ids}`;

function build(storage?: KV): LayoutStore {
  return new LayoutStore({ logger, clock, sessions, newPane, ...(storage ? { storage } : {}) });
}

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 600 };

/**
 * A store with a home root and one task root, wired through the registry with
 * the shell's own active-root state modelled. The root-level commands are all
 * about the interplay between those two, so a helper that only ever had one
 * root could not exercise any of them.
 */
function wiredRoots() {
  const store = build();
  const registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
  const home = rootId('window-1');
  let active = home;
  const switched: RootID[] = [];
  registerLayoutCommands({
    store,
    registry,
    homeRoot: home,
    activeRoot: () => active,
    onSwitchRoot: (root) => {
      switched.push(root);
      active = root;
    },
    onLastPaneClosed: () => {},
  });
  store.open(home);
  store.open('task-1');
  return { store, registry, home, switched, activeRoot: () => active };
}

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

  /**
   * ADR 0036's three cases. This is the milestone R1 exists for, seen from the
   * layout: a relaunch must REATTACH rather than orphan.
   */
  it('restores pane ids and REATTACHES a session the daemon still holds', () => {
    const kv = fakeKV();
    const first = build(kv);
    const root = first.open();
    first.split(root, 'row');
    first.bindSession(paneId('p1'), sessionId('s-1'));
    first.flush();

    ids = 100; // the second store mints from a different sequence
    live = new Set([sessionId('s-1')]); // the daemon still has it
    const second = build(kv);
    const restored = second.open();

    expect(second.panes(restored)).toHaveLength(2);
    // The id survives, which is what lets the binding below mean anything.
    expect(second.panes(restored)).toContain('p1');
    expect(second.sessionFor(paneId('p1'))).toBe('s-1');
  });

  it('drops a binding whose session has ENDED, so the pane creates one', () => {
    const kv = fakeKV();
    const first = build(kv);
    const root = first.open();
    first.split(root, 'row');
    first.bindSession(paneId('p1'), sessionId('s-1'));
    first.flush();

    ids = 100;
    live = new Set(); // the daemon has nothing — a cold start, or it crashed
    const second = build(kv);
    const restored = second.open();

    expect(second.panes(restored)).toContain('p1');
    // Unbound, so the renderer creates — which is exactly the pre-R1 behaviour,
    // and the reason a stale binding is a claim rather than a fact.
    expect(second.sessionFor(paneId('p1'))).toBeUndefined();
  });

  /**
   * The negative control that matters: believing a binding without checking is
   * the whole failure mode ADR 0036's verification exists to prevent. If
   * `isLive` were ignored, the test above would pass this one's setup too.
   */
  it('asks the daemon about every claim rather than trusting the file', () => {
    const kv = fakeKV();
    const first = build(kv);
    const root = first.open();
    first.split(root, 'row');
    first.bindSession(paneId('p1'), sessionId('s-1'));
    first.bindSession(paneId('p2'), sessionId('s-2'));
    first.flush();

    ids = 100;
    live = new Set([sessionId('s-2')]); // only one of the two survived
    const second = build(kv);
    second.open();

    expect(second.sessionFor(paneId('p1'))).toBeUndefined();
    expect(second.sessionFor(paneId('p2'))).toBe('s-2');
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

/**
 * A root that holds NO panes.
 *
 * The state that makes the app's empty state reachable. Before this, `close`
 * left the last pane's tree intact and the shell closed the window, so a
 * zero-pane projection could not exist — and "you have no tasks" was drawn as a
 * live shell in whatever directory was current, which after deleting the last
 * task is usually one that has just been removed from disk.
 */
describe('a root can hold no panes', () => {
  it('opens empty when asked, with no pane and nothing focused', () => {
    const store = build();
    const root = store.open('window-1', undefined, { empty: true });
    expect(store.panes(root)).toEqual([]);
    expect(store.tree(root)).toBeUndefined();
    expect(store.focused(root)).toBeNull();
    // It EXISTS, which is the distinction `hasRoot` was split out to carry: the
    // old `tree(root) === undefined` answered both questions with one value.
    expect(store.hasRoot(root)).toBe(true);
    expect(store.roots()).toEqual([root]);
  });

  it('still opens with a pane by default, so nothing else had to change', () => {
    const store = build();
    const root = store.open();
    expect(store.panes(root)).toEqual(['p1']);
  });

  /**
   * MUTATION TARGET. Reverting `close` to leave the tree intact (its behaviour
   * before this change) must fail HERE and nowhere else in the old suite —
   * `wasLastPane`, the session kill and the `onLastPaneClosed` fall-through are
   * all still true when the tree is left alone, which is exactly why the defect
   * survived: every existing test passed.
   */
  it('closing the last pane empties the root instead of leaving the tree intact', () => {
    const store = build();
    const root = store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));

    const outcome = store.close(paneId('p1'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p1', endedSession: 's-1', wasLastPane: true } });
    expect(store.panes(root)).toEqual([]);
    expect(store.tree(root)).toBeUndefined();
    expect(store.focused(root)).toBeNull();
    // The root survives its last pane. Closing it is `removeRoot`'s job.
    expect(store.hasRoot(root)).toBe(true);
    expect(killed).toEqual(['s-1']);
  });

  it('announces the emptying, or the window would keep drawing the pane', () => {
    const store = build();
    const root = store.open();
    const seen: RootID[] = [];
    store.onDidChange((changed) => seen.push(changed));
    store.close(paneId('p1'));
    expect(seen).toEqual([root]);
  });

  it('splitting an empty root gives it its first pane', () => {
    // ⌘D on the empty state has to do something other than log `nothing to
    // split`, and it is the only way back in from the keyboard.
    const store = build();
    const root = store.open('window-1', undefined, { empty: true });
    const seeded = store.split(root, 'row', { cwd: '/tmp/seed' });
    expect(seeded).toEqual({ ok: true, value: 'p1' });
    expect(store.panes(root)).toEqual(['p1']);
    expect(store.focused(root)).toBe('p1');
    expect(store.pane(paneId('p1'))?.cwd).toBe('/tmp/seed');
    // And the next one really splits.
    expect(store.split(root, 'row').ok).toBe(true);
    expect(store.panes(root)).toHaveLength(2);
  });

  it('persists an emptied root as a null tree, and restores it empty', () => {
    // Dropping it from the payload instead would bring it back MINTED, refilling
    // the empty state with a shell the user closed on purpose.
    const storage = fakeKV();
    const first = build(storage);
    first.open();
    first.close(paneId('p1'));
    first.flush();

    const payload = storage.raw.get('layout') as { roots: { id: string; tree: unknown }[] };
    expect(payload.roots).toEqual([
      { id: 'window-1', group: 'window-1', tree: null, focusedPaneId: null },
    ]);

    const second = build(storage);
    const root = second.open();
    expect(second.hasRoot(root)).toBe(true);
    expect(second.panes(root)).toEqual([]);
  });

  it('projects a paneless root with no regions rather than an empty one', () => {
    // `regions` is a Partial record, so an absent key already means "nothing
    // here" — an extension reading it needs no new case.
    const store = build();
    const root = store.open('window-1', undefined, { empty: true });
    expect(store.project(root)).toEqual({
      id: 'window-1',
      group: 'window-1',
      regions: {},
      focused: null,
      zoomed: null,
    });
  });

  it('answers the pane queries without walking a tree that is not there', () => {
    const store = build();
    const root = store.open('window-1', undefined, { empty: true });
    expect(store.pane(paneId('p1'))).toBeNull();
    expect(store.rootOf(paneId('p1'))).toBeUndefined();
    expect(store.zoomed(root)).toBeNull();
    expect(store.focusDirection(root, 'left')).toEqual({ ok: true, value: null });
    expect(store.setRatio(root, [0], 0.5)).toEqual({ ok: false, error: 'window-1 has no panes' });
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
  function wired(storage?: KV) {
    const store = build(storage);
    const registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
    const lastPaneClosed = vi.fn();
    const home = rootId('window-1');
    // The shell's own state, modelled: which root the window shows, and the one
    // call that changes it. Mutable, because a test that could not change it
    // could not tell "defaults to the active root" from "defaults to the first".
    let active = home;
    const switched: RootID[] = [];
    const subscription = registerLayoutCommands({
      store,
      registry,
      homeRoot: home,
      activeRoot: () => active,
      onSwitchRoot: (root) => {
        switched.push(root);
        active = root;
      },
      onLastPaneClosed: lastPaneClosed,
    });
    const root = store.open();
    store.setViewport(root, VIEWPORT);
    return {
      store,
      registry,
      root,
      home,
      lastPaneClosed,
      subscription,
      switched,
      activeRoot: () => active,
    };
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

  it('defaults to the ACTIVE root once a second one exists', async () => {
    // The whole reason `activeRoot` is injected. This used to mean "the only
    // root there is", which held right up until a second root existed and then
    // broke every menu gesture at once — ⌘D and ⌘W send no `root` on purpose.
    const { registry, store, root, switched } = wired();
    await registry.invoke(LAYOUT_COMMANDS.openRoot, { root: 'task-1' }, USER);
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task-1' }, USER);
    expect(switched).toEqual(['task-1']);

    const split = await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    expect(split.ok).toBe(true);
    // The split landed in the root being looked at, and the home root is untouched.
    expect(store.panes(rootId('task-1'))).toHaveLength(2);
    expect(store.panes(root)).toHaveLength(1);
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
    registerLayoutCommands({
      store,
      registry,
      homeRoot: rootId('window-1'),
      activeRoot: () => rootId('window-1'),
      onSwitchRoot: () => {},
      onLastPaneClosed: () => {},
    });
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

describe('a root is opened once, and shaped only when it is minted', () => {
  it('applies the init to the first pane of a FRESH root', () => {
    const store = build();
    const root = store.open('task-1', { cwd: '/w/api', userTitle: 'api', initialCommand: 'claude\n' });
    const pane = store.pane(store.focused(root)!);
    expect(pane?.cwd).toBe('/w/api');
    expect(pane?.userTitle).toBe('api');
    expect(pane?.initialCommand).toBe('claude\n');
  });

  it('ignores the init when the root is RESTORED from disk', () => {
    // A restored root already has the panes the user left there. Re-pointing one
    // at a cwd — or re-arming a command the persisted shape deliberately drops —
    // would make every relaunch replay whatever created the root.
    const kv = fakeKV();
    const first = build(kv);
    first.open('task-1', { cwd: '/w/api' });
    first.flush();

    const second = build(kv);
    const root = second.open('task-1', { cwd: '/somewhere/else', initialCommand: 'claude\n' });
    const pane = second.pane(second.focused(root)!);
    expect(pane?.cwd).toBe('/w/api');
    expect(pane?.initialCommand).toBeNull();
  });

  it('answers a LIVE root as-is rather than re-reading storage', () => {
    // Re-restoring a live root replaces its tree with fresh pane ids, which
    // orphans every session binding and leaves the ptys running with nothing
    // pointing at them. `layout.openRoot` makes that reachable at runtime.
    const kv = fakeKV();
    const store = build(kv);
    const root = store.open('task-1');
    store.split(root, 'row');
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.flush();

    expect(store.open('task-1')).toBe(root);
    expect(store.panes(root)).toEqual(['p1', 'p2']);
    expect(store.sessionFor(paneId('p1'))).toBe('s-1');
  });
});

describe('removing a root', () => {
  it('stops it being persisted', () => {
    // `#writeNow` serializes whatever is in the map, so a root removed without a
    // write comes back on every launch forever.
    const kv = fakeKV();
    const store = build(kv);
    store.open('window-1');
    store.open('task-1');
    store.flush();
    expect(store.persistedRoots()).toEqual(['window-1', 'task-1']);

    expect(store.removeRoot(rootId('task-1'))).toEqual({ ok: true, value: undefined });
    store.flush();
    expect(store.persistedRoots()).toEqual(['window-1']);
    expect(store.roots()).toEqual(['window-1']);
  });

  it('notifies, so the shell can republish and viewing can be re-evaluated', () => {
    const store = build();
    store.open('task-1');
    const seen: string[] = [];
    store.onDidChange((root) => seen.push(root));
    store.removeRoot(rootId('task-1'));
    expect(seen).toEqual(['task-1']);
  });

  it('kills nothing — layout.close is the one terminator', () => {
    const store = build();
    store.open('task-1');
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.removeRoot(rootId('task-1'));
    expect(killed).toEqual([]);
  });

  it('drops pending initial input for panes that never got a session', () => {
    const store = build();
    const root = store.open('task-1');
    const pane = store.focused(root)!;
    store.setInitialInput(pane, 'claude\n');
    store.removeRoot(rootId('task-1'));
    expect(store.takeInitialInput(pane)).toBeUndefined();
  });

  it('reports a root that was never there', () => {
    expect(build().removeRoot(rootId('ghost'))).toEqual({ ok: false, error: 'no root ghost' });
  });
});

describe('persistedRoots', () => {
  it('lists what a relaunch would have to open, before anything is open', () => {
    // Main opens every one of these at launch. Reading only the home root would
    // leave a task's layout on disk and invisible — and the next write would
    // then persist the roots that HAD been opened and drop the rest.
    const kv = fakeKV();
    const first = build(kv);
    first.open('window-1');
    first.open('task-1');
    first.flush();

    expect(build(kv).persistedRoots()).toEqual(['window-1', 'task-1']);
  });

  it('is empty rather than throwing on a blob it does not recognize', () => {
    const kv = fakeKV();
    kv.set('layout', { schemaVersion: 99, roots: [] });
    expect(build(kv).persistedRoots()).toEqual([]);
  });

  it('is empty with no storage at all', () => {
    expect(build().persistedRoots()).toEqual([]);
  });
});

describe('the root-level commands', () => {
  it('switchRoot hands an existing root to the shell', async () => {
    const { registry, switched } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task-1' }, USER);
    expect(result).toEqual({ ok: true, value: { root: 'task-1' } });
    expect(switched).toEqual(['task-1']);
  });

  it('switchRoot refuses a root that does not exist, informatively', async () => {
    // Switching to nothing leaves the window drawing nothing, with the failure
    // visible only as a blank stage.
    const { registry, switched } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'ghost' }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no root ghost');
    expect(switched).toEqual([]);
  });

  it('switchRoot goes to an EMPTY root, which is still a root', async () => {
    // `hasRoot`, not `tree(root) === undefined`. The old spelling answered both
    // questions with one value and would report "no root" about a root that is
    // open and on which the window draws the empty state.
    const { registry, store, switched } = wiredRoots();
    store.open('empty-1', undefined, { empty: true });
    const result = await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'empty-1' }, USER);
    expect(result).toEqual({ ok: true, value: { root: 'empty-1' } });
    expect(switched).toEqual(['empty-1']);
  });

  it('openRoot FILLS a root that exists but holds no panes', async () => {
    /*
     * The other half of the same split. `openRoot` means "there is a root here
     * with something in it" — that is what every caller does with the answer —
     * so an existence check would leave an emptied home root a dead end: it
     * would report `created: false` with `pane: null` forever.
     */
    const { registry, store } = wiredRoots();
    store.open('empty-1', undefined, { empty: true });
    const result = await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      { root: 'empty-1', cwd: '/tmp/refill', title: 'back' },
      USER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ root: 'empty-1', created: true });
    expect(store.panes(rootId('empty-1'))).toHaveLength(1);
    const pane = store.pane(store.focused(rootId('empty-1')) as PaneID);
    expect(pane?.cwd).toBe('/tmp/refill');
    expect(pane?.userTitle).toBe('back');
  });

  it('closeRoot closes an EMPTY root rather than reporting it missing', async () => {
    const { registry, store } = wiredRoots();
    store.open('empty-1', undefined, { empty: true });
    const result = await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'empty-1' }, USER);
    expect(result).toEqual({ ok: true, value: { root: 'empty-1', closedPanes: 0 } });
    expect(store.hasRoot(rootId('empty-1'))).toBe(false);
  });

  it('openRoot mints a root and shapes its first pane', async () => {
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      { root: 'task-2', cwd: '/w/api', title: 'api', initialCommand: 'claude\n' },
      USER,
    );
    expect(result).toMatchObject({ ok: true, value: { root: 'task-2', created: true } });
    const pane = store.pane(store.focused(rootId('task-2'))!);
    expect(pane?.cwd).toBe('/w/api');
    expect(pane?.userTitle).toBe('api');
    expect(pane?.initialCommand).toBe('claude\n');
  });

  it('openRoot on a root that is already open is not a second root', async () => {
    const { registry, store } = wiredRoots();
    const before = store.panes(rootId('task-1'));
    const result = await registry.invoke(LAYOUT_COMMANDS.openRoot, { root: 'task-1' }, USER);
    expect(result).toEqual({ ok: true, value: { root: 'task-1', pane: before[0], created: false } });
    expect(store.panes(rootId('task-1'))).toEqual(before);
  });

  it('closeRoot ends every session in it, through the sink', async () => {
    // ADR 0022: `layout.close` is the one terminator. Dropping the root without
    // draining it would leak a live pty per pane with nothing pointing at it.
    const { registry, store } = wiredRoots();
    store.split(rootId('task-1'), 'row');
    const [a, b] = store.panes(rootId('task-1'));
    store.bindSession(a!, sessionId('s-a'));
    store.bindSession(b!, sessionId('s-b'));

    const result = await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'task-1' }, USER);
    expect(result).toMatchObject({ ok: true, value: { root: 'task-1', closedPanes: 2 } });
    expect(killed).toEqual(['s-a', 's-b']);
    expect(store.roots()).toEqual(['window-1']);
  });

  it('closeRoot switches off a root it just removed', async () => {
    const { registry, switched, activeRoot } = wiredRoots();
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task-1' }, USER);
    await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'task-1' }, USER);
    expect(switched).toEqual(['task-1', 'window-1']);
    expect(activeRoot()).toBe('window-1');
  });

  it('closeRoot leaves the active root alone when it closed another one', async () => {
    const { registry, switched } = wiredRoots();
    await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'task-1' }, USER);
    expect(switched).toEqual([]);
  });

  it('refuses to close the home root', async () => {
    // It is what everything falls back to; closing it leaves the window with no
    // root to draw and no root to switch to.
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'window-1' }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('home root');
    expect(store.roots()).toContain('window-1');
  });

  it('closeRoot reports a root that does not exist', async () => {
    const { registry } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'ghost' }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no root ghost');
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

describe('a root belongs to a group', () => {
  it('defaults a root to a group of its own', () => {
    const store = build();
    store.open('window-1');
    expect(store.groupOf(rootId('window-1'))).toBe('window-1');
    expect(store.rootsInGroup('window-1')).toEqual([rootId('window-1')]);
  });

  it('puts roots opened with the same group together, in creation order', () => {
    const store = build();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.open('task:t1/tab-2', {}, { group: 'task:t1' });
    expect(store.rootsInGroup('task:t1')).toEqual([rootId('task:t1'), rootId('task:t1/tab-2')]);
  });

  it('answers undefined for a root it does not hold', () => {
    expect(build().groupOf(rootId('nope'))).toBeUndefined();
  });

  it('drops a removed root out of its group', () => {
    const store = build();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.open('task:t1/tab-2', {}, { group: 'task:t1' });
    store.removeRoot(rootId('task:t1/tab-2'));
    expect(store.rootsInGroup('task:t1')).toEqual([rootId('task:t1')]);
  });

  it('round-trips a group through storage', () => {
    const storage = fakeKV();
    const first = build(storage);
    first.open('task:t1', {}, { group: 'task:t1' });
    first.open('task:t1/tab-2', {}, { group: 'task:t1' });
    first.flush();

    const second = build(storage);
    second.open('task:t1');
    second.open('task:t1/tab-2');
    expect(second.rootsInGroup('task:t1')).toEqual([rootId('task:t1'), rootId('task:t1/tab-2')]);
  });

  it('reads a payload written before groups existed as one group per root', () => {
    // The whole reason this stays `schemaVersion: 1`: an older payload has no
    // `group`, and every root in it is its own — which is exactly how the app
    // behaved before groups existed, rather than a migration.
    const storage = fakeKV();
    storage.set('layout', {
      schemaVersion: 1,
      roots: [
        { id: 'window-1', tree: { kind: 'leaf', pane: { id: 'old-1' } }, focusedPaneId: 'old-1' },
      ],
    });
    const store = build(storage);
    store.open('window-1');
    expect(store.groupOf(rootId('window-1'))).toBe('window-1');
  });
});

describe('newTab', () => {
  it('mints the next tab of a group and gives it a pane', () => {
    const store = build();
    store.open('task:t1', {}, { group: 'task:t1' });
    const minted = store.newTab('task:t1');
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.value).toBe(rootId('task:t1/tab-2'));
    expect(store.panes(minted.value)).toHaveLength(1);
    expect(store.rootsInGroup('task:t1')).toEqual([rootId('task:t1'), minted.value]);
  });

  it('skips an id that is already taken', () => {
    const store = build();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.open('task:t1/tab-2', {}, { group: 'task:t1' });
    const minted = store.newTab('task:t1');
    expect(minted.ok && minted.value).toBe(rootId('task:t1/tab-3'));
  });

  it('skips an id that is only on disk, so a restore cannot collide with it', () => {
    // Live ids alone are not enough: the shell opens a persisted root lazily, so
    // a tab minted before its sibling was opened would take an id that is about
    // to be restored — and `open` is idempotent, so nothing would throw. It
    // would silently hand the new tab the old tab's panes.
    const storage = fakeKV();
    const first = build(storage);
    first.open('task:t1', {}, { group: 'task:t1' });
    first.newTab('task:t1');
    first.flush();

    const second = build(storage);
    second.open('task:t1');
    const minted = second.newTab('task:t1');
    expect(minted.ok && minted.value).toBe(rootId('task:t1/tab-3'));
  });

  it('carries the seed onto the tab it mints', () => {
    const store = build();
    store.open('task:t1', {}, { group: 'task:t1' });
    const minted = store.newTab('task:t1', { cwd: '/tmp/wt' });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const pane = store.focused(minted.value);
    expect(pane === null ? null : store.pane(pane)?.cwd).toBe('/tmp/wt');
  });

  it('refuses a group with no name', () => {
    expect(build().newTab('')).toEqual({ ok: false, error: 'a tab needs a group' });
  });
});

describe('the group commands', () => {
  it('openRoot mints a root into a named group', async () => {
    const { registry, store } = wiredRoots();
    await registry.invoke(LAYOUT_COMMANDS.openRoot, { root: 'task:t1', group: 'task:t1' }, USER);
    expect(store.groupOf(rootId('task:t1'))).toBe('task:t1');
  });

  it('newTab opens a sibling of the active root and switches to it', async () => {
    const { registry, store, switched } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1' }, USER);

    const result = await registry.invoke(LAYOUT_COMMANDS.newTab, {}, USER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ root: 'task:t1/tab-2' });
    expect(store.rootsInGroup('task:t1')).toEqual([rootId('task:t1'), rootId('task:t1/tab-2')]);
    expect(switched.at(-1)).toBe('task:t1/tab-2');
  });

  it('newTab inherits the cwd of the pane you were looking at', async () => {
    // What makes ⌘⇧T inside a task land in that task's worktree without the
    // kernel knowing what a worktree is.
    const { registry, store } = wiredRoots();
    store.open('task:t1', { cwd: '/tmp/wt' }, { group: 'task:t1' });
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1' }, USER);

    await registry.invoke(LAYOUT_COMMANDS.newTab, {}, USER);
    const pane = store.focused(rootId('task:t1/tab-2'));
    expect(pane === null ? null : store.pane(pane)?.cwd).toBe('/tmp/wt');
  });

  it('closeGroup ends every session in every tab', async () => {
    // `store.close` is the ONE terminator (ADR 0022). Dropping the roots without
    // draining them leaks a live pty per pane with nothing pointing at it.
    const { registry, store } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.newTab('task:t1');
    for (const root of store.rootsInGroup('task:t1')) {
      const pane = store.focused(root);
      if (pane !== null) store.bindSession(pane, sessionId(`s-${root}`));
    }

    const result = await registry.invoke(LAYOUT_COMMANDS.closeGroup, { group: 'task:t1' }, USER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ closedRoots: 2, closedPanes: 2 });
    expect(killed).toEqual(['s-task:t1', 's-task:t1/tab-2']);
    expect(store.rootsInGroup('task:t1')).toEqual([]);
  });

  it('closeGroup refuses a group nobody opened', async () => {
    const { registry } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.closeGroup, { group: 'task:ghost' }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no group task:ghost');
  });

  it('closeGroup leaves the home root alone, so the window has somewhere to fall back to', async () => {
    const { registry, store, home } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.closeGroup, { group: 'window-1' }, USER);
    expect(result.ok).toBe(true);
    expect(store.hasRoot(home)).toBe(true);
  });

  it('listRoots reports a group, filtered, with one resolved label per tab', async () => {
    const { registry, store } = wiredRoots();
    store.open('task:t1', { userTitle: 'api' }, { group: 'task:t1' });
    store.newTab('task:t1');

    const result = await registry.invoke(LAYOUT_COMMANDS.listRoots, { group: 'task:t1' }, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value as readonly { root: string; group: string; label: string }[];
    expect(rows.map((row) => row.root)).toEqual(['task:t1', 'task:t1/tab-2']);
    expect(rows[0]?.label).toBe('api');
    expect(rows.every((row) => row.group === 'task:t1')).toBe(true);
  });

  it('listRoots reports the session each tab is showing', async () => {
    const { registry, store } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.bindSession(store.focused(rootId('task:t1')) as PaneID, sessionId('s-1'));

    const result = await registry.invoke(LAYOUT_COMMANDS.listRoots, { group: 'task:t1' }, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value as readonly { focusedSession: string | null }[];
    expect(rows[0]?.focusedSession).toBe('s-1');
  });
});

describe('closing a tab falls through to its sibling', () => {
  it('lands on a sibling tab rather than throwing you out of the group', async () => {
    // Falling straight home would mean closing tab 2 of a task threw you out of
    // the task — the tab you were not looking at is right there.
    const { registry, store, activeRoot } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    store.newTab('task:t1');
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1/tab-2' }, USER);

    await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'task:t1/tab-2' }, USER);
    expect(activeRoot()).toBe('task:t1');
  });

  it('lands on home when the group has no tabs left', async () => {
    const { registry, store, activeRoot, home } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1' }, USER);

    await registry.invoke(LAYOUT_COMMANDS.closeRoot, { root: 'task:t1' }, USER);
    expect(activeRoot()).toBe(home);
  });
});
