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
import { SessionLifetime, type SessionHolder } from '../session/lifetime.ts';
import { LayoutStore, type SessionSink } from './store.ts';
import { LAYOUT_COMMANDS, registerLayoutCommands } from './commands.ts';
import { leaf, leafIds } from './tree.ts';
import { makePane } from './pane.ts';
import { deserializeNode, serializeNode } from './serialize.ts';

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
/** What the sink was told to let go of — a RELEASE now, not a kill (ADR 0052). */
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
  sessions = { release: (id) => killed.push(id), isLive: (id) => live.has(id) };
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

describe('a close is a DETACH, and the lifetime decides the rest (ADR 0052)', () => {
  /** A store whose sink releases into a real `SessionLifetime`. */
  function withLifetime(holders: SessionHolder[]) {
    const ended: SessionID[] = [];
    const lifetime = new SessionLifetime({ end: (id) => void ended.push(id), logger });
    for (const holder of holders) lifetime.addHolder(holder);
    const store = new LayoutStore({
      logger,
      clock,
      newPane,
      sessions: { release: (id) => void lifetime.release(id, 'app'), isLive: (id) => live.has(id) },
    });
    return { store, ended, lifetime };
  }

  it('ends the session when this client was the only one holding it', () => {
    // The single-client case, which must behave exactly as it did before.
    const { store, ended } = withLifetime([]);
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.close(paneId('p1'));
    expect(ended).toEqual(['s-1']);
  });

  it('does NOT end a session another client is watching', () => {
    // The whole point. A phone open on an agent is a reason the pty outlives
    // this window's decision to stop drawing it.
    const { store, ended } = withLifetime([
      { reason: 'viewing', principals: (id) => (id === sessionId('s-1') ? ['device:phone'] : []) },
    ]);
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    const outcome = store.close(paneId('p1'));

    expect(outcome).toEqual({ ok: true, value: { closed: 'p1', detachedSession: 's-1', wasLastPane: true } });
    expect(ended).toEqual([]);
    // Detached all the same: this window no longer shows it.
    expect(store.sessionFor(paneId('p1'))).toBeUndefined();
    expect(store.paneForSession(sessionId('s-1'))).toBeUndefined();
  });

  it('stops holding the session once the pane is closed, so the LAST client to let go ends it', () => {
    // The detach has to be real, not just reported. If the pane→session map
    // still named the session, this window would hold it forever and the phone
    // letting go would end nothing — a pty alive with no client anywhere.
    const watchers = new Set<string>(['device:phone']);
    const { store, ended, lifetime } = withLifetime([
      { reason: 'viewing', principals: (id) => (id === sessionId('s-1') ? [...watchers] : []) },
    ]);
    lifetime.addHolder({
      reason: 'a pane of this window shows it',
      principals: (id) => (store.paneForSession(id) === undefined ? [] : ['app']),
    });
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));

    store.close(paneId('p1'));
    expect(ended).toEqual([]);

    watchers.delete('device:phone');
    lifetime.release(sessionId('s-1'), 'device:phone');
    expect(ended).toEqual(['s-1']);
  });
});

describe('closing a pane detaches its session', () => {
  it('releases the bound session and reports which', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.bindSession(paneId('p1'), sessionId('s-1'));
    store.bindSession(paneId('p2'), sessionId('s-2'));

    const outcome = store.close(paneId('p2'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p2', detachedSession: 's-2', wasLastPane: false } });
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

  it('the last pane reports wasLastPane and still releases its session', () => {
    const store = build();
    store.open();
    store.bindSession(paneId('p1'), sessionId('s-1'));
    const outcome = store.close(paneId('p1'));
    expect(outcome).toEqual({ ok: true, value: { closed: 'p1', detachedSession: 's-1', wasLastPane: true } });
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

  it('observes a title and a cwd onto the pane', () => {
    const store = build();
    store.open();

    expect(store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' }).ok).toBe(true);

    expect(store.pane(paneId('p1'))?.title).toBe('vim');
    expect(store.pane(paneId('p1'))?.cwd).toBe('/w/api');
  });

  /**
   * A shell re-emits its title and cwd on every prompt. Rewriting the pane for
   * an unchanged value pushes a full snapshot to the renderer and schedules a
   * write, to say nothing happened.
   */
  it('says nothing when an observation changes nothing', () => {
    const store = build();
    store.open();
    store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' });

    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });

    expect(store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' }).ok).toBe(true);
    expect(notifications).toBe(0);

    // …and a real change still gets through.
    store.observe(paneId('p1'), { title: 'zsh' });
    expect(notifications).toBe(1);
  });

  /** A partial patch leaves the other field alone rather than clearing it. */
  it('keeps the field an observation does not mention', () => {
    const store = build();
    store.open();
    store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' });

    store.observe(paneId('p1'), { title: 'zsh' });

    expect(store.pane(paneId('p1'))?.cwd).toBe('/w/api');
  });

  it('still refuses a pane it does not have', () => {
    const store = build();
    store.open();
    expect(store.observe(paneId('nope'), { title: 'x' }).ok).toBe(false);
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

  describe('and it can say why', () => {
    it('carries the line and the names it was given', () => {
      const store = build();
      const root = store.open('window-1', undefined, { empty: true });
      expect(store.placeholderOf(root)).toBeUndefined();

      expect(store.setPlaceholder(root, { line: 'Creating the worktree', names: ['shepherd'] })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(store.placeholderOf(root)).toEqual({ line: 'Creating the worktree', names: ['shepherd'] });
    });

    /**
     * MUTATION TARGET. This is the one way the feature can LIE — a wait drawn
     * over a running agent — so it is guarded by the read rather than by every
     * writer remembering to clear.
     */
    it('says nothing once the root holds a pane, whatever was set', () => {
      const store = build();
      const root = store.open('window-1', undefined, { empty: true });
      store.setPlaceholder(root, { line: 'Starting the agent' });

      store.split(root, 'row');

      expect(store.panes(root)).toHaveLength(1);
      expect(store.placeholderOf(root)).toBeUndefined();
    });

    it('is not read back after the pane is closed again either', () => {
      // Seeding CLEARS it, so emptying the root a second time cannot resurrect
      // a line about work that finished long ago.
      const store = build();
      const root = store.open('window-1', undefined, { empty: true });
      store.setPlaceholder(root, { line: 'Starting the agent' });
      store.split(root, 'row');

      store.close(store.focused(root)!);

      expect(store.tree(root)).toBeUndefined();
      expect(store.placeholderOf(root)).toBeUndefined();
    });

    it('accepts a write on a root that has since been filled, rather than failing', () => {
      // The caller is a slow job reporting progress; by the time it reports, the
      // thing it waited for may have landed. That is the success case.
      const store = build();
      const root = store.open();
      expect(store.setPlaceholder(root, { line: 'Linking agent files' })).toEqual({ ok: true, value: undefined });
    });

    it('refuses a root that does not exist', () => {
      const store = build();
      expect(store.setPlaceholder(rootId('ghost'), { line: 'Naming the task' })).toEqual({
        ok: false,
        error: 'no root ghost',
      });
    });

    it('announces a change once, and an identical re-set not at all', () => {
      // Provisioning re-reports its step; the renderer re-renders every mounted
      // root on a push.
      const store = build();
      const root = store.open('window-1', undefined, { empty: true });
      const seen: string[] = [];
      store.onDidChange((changed) => seen.push(String(changed)));

      store.setPlaceholder(root, { line: 'Naming the task', names: ['shepherd'] });
      store.setPlaceholder(root, { line: 'Naming the task', names: ['shepherd'] });
      expect(seen).toEqual(['window-1']);

      // …but a change to the NAMES alone is a change, not just the line.
      store.setPlaceholder(root, { line: 'Naming the task', names: ['shepherd', 'relay'] });
      expect(seen).toEqual(['window-1', 'window-1']);
    });
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
    expect(outcome).toEqual({ ok: true, value: { closed: 'p1', detachedSession: 's-1', wasLastPane: true } });
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

  /**
   * MUTATION TARGET for the whole feature. Dropping `empty` — or letting it fall
   * through to the seeding paths below it — puts a shell back in the root, which
   * is the pane the agent then splits beside and nothing reclaims.
   */
  it('openRoot mints a root with NO pane when asked, and says why', async () => {
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      {
        root: 'task:t9',
        group: 'task:t9',
        // Passed and ignored: there is no pane to shape. A caller that stopped
        // needing a first pane must not have to strip its old arguments.
        cwd: '/w/api',
        title: 'api',
        empty: true,
        placeholder: { line: 'Creating the worktree', names: ['shepherd'] },
      },
      USER,
    );

    expect(result).toEqual({ ok: true, value: { root: 'task:t9', pane: null, created: false } });
    expect(store.hasRoot(rootId('task:t9'))).toBe(true);
    expect(store.panes(rootId('task:t9'))).toEqual([]);
    expect(store.groupOf(rootId('task:t9'))).toBe('task:t9');
    expect(store.placeholderOf(rootId('task:t9'))).toEqual({
      line: 'Creating the worktree',
      names: ['shepherd'],
    });
  });

  it('openRoot then FILLS that same root with one pane, never a split', async () => {
    // The whole point of the paneless mint: what lands later is the root's
    // first pane and fills the stage, rather than a sibling of a shell.
    const { registry, store } = wiredRoots();
    await registry.invoke(LAYOUT_COMMANDS.openRoot, { root: 'task:t9', empty: true }, USER);

    const filled = await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      { root: 'task:t9', cwd: '/w/api', initialCommand: 'claude\n' },
      USER,
    );

    expect(filled).toMatchObject({ ok: true, value: { root: 'task:t9', created: true } });
    expect(store.panes(rootId('task:t9'))).toHaveLength(1);
    expect(store.placeholderOf(rootId('task:t9'))).toBeUndefined();
  });

  it('setPlaceholder updates the line while the wait is still on', async () => {
    const { registry, store } = wiredRoots();
    await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      { root: 'task:t9', empty: true, placeholder: { line: 'Naming the task' } },
      USER,
    );

    const moved = await registry.invoke(
      LAYOUT_COMMANDS.setPlaceholder,
      { root: 'task:t9', placeholder: { line: 'Starting the agent' } },
      USER,
    );

    expect(moved).toEqual({ ok: true, value: { root: 'task:t9', placed: true } });
    expect(store.placeholderOf(rootId('task:t9'))).toEqual({ line: 'Starting the agent' });
  });

  /**
   * MUTATION TARGET, and it was found by `smoke:m3` rather than by any unit test.
   *
   * The caller is a slow job reporting progress against a root the user has not
   * opened — the ORDINARY case for most of a task's provisioning. As a refusal
   * it logged a dispatcher warning per step for work that was going fine.
   */
  it('setPlaceholder is a quiet no-op for a root nobody has opened', async () => {
    const { registry } = wiredRoots();
    const result = await registry.invoke(
      LAYOUT_COMMANDS.setPlaceholder,
      { root: 'task:never-opened', placeholder: { line: 'Naming the task' } },
      USER,
    );

    // …but not SILENT: `placed` is in the answer, so a genuinely wrong root id
    // is still findable.
    expect(result).toEqual({ ok: true, value: { root: 'task:never-opened', placed: false } });
  });

  it('setPlaceholder with no placeholder stops the root saying anything', async () => {
    const { registry, store } = wiredRoots();
    await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      { root: 'task:t9', empty: true, placeholder: { line: 'Naming the task' } },
      USER,
    );

    await registry.invoke(LAYOUT_COMMANDS.setPlaceholder, { root: 'task:t9' }, USER);

    expect(store.placeholderOf(rootId('task:t9'))).toBeUndefined();
    // …and the root is still there, empty. Clearing a line is not closing a tab.
    expect(store.hasRoot(rootId('task:t9'))).toBe(true);
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

  it('newTab into a NAMED group takes that group\u2019s cwd, not the one on screen', async () => {
    /*
     * A `group` argument makes this a tab of somebody else's group, and the
     * directory has to come from there. Inheriting "the pane you were looking
     * at" is right only for the unqualified gesture — an extension asking for a
     * tab in a task while Home is on screen would otherwise mint a shell in
     * Home's directory and call it a tab of the task.
     */
    const { registry, store } = wiredRoots();
    store.open('task:t1', { cwd: '/tmp/wt' }, { group: 'task:t1' });
    // And the window stays on Home, which is the whole case.

    await registry.invoke(LAYOUT_COMMANDS.newTab, { group: 'task:t1' }, USER);
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

  /*
   * Without this field a palette verb cannot act on "the tab I am in": an
   * extension can find the root holding a PANE it owns, but a command invoked
   * from ⌘K has no pane to start from.
   */
  it('listRoots marks exactly the root the user is on, and follows a switch', async () => {
    const { registry, store, home } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });

    const before = await registry.invoke(LAYOUT_COMMANDS.listRoots, {}, USER);
    if (!before.ok) throw new Error('listRoots refused');
    const first = before.value as readonly { root: string; active: boolean }[];
    expect(first.filter((row) => row.active).map((row) => row.root)).toEqual([String(home)]);

    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1' }, USER);

    const after = await registry.invoke(LAYOUT_COMMANDS.listRoots, {}, USER);
    if (!after.ok) throw new Error('listRoots refused');
    const second = after.value as readonly { root: string; active: boolean }[];
    expect(second.filter((row) => row.active).map((row) => row.root)).toEqual(['task:t1']);
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

describe('a read-only pane', () => {
  it('round-trips readOnly and snapshotFile through serialize/deserialize', () => {
    const pane = makePane({ id: paneId('p-1'), cwd: '/w', readOnly: true, snapshotFile: '/a/p-1.term' });
    const persisted = serializeNode(leaf(pane));

    expect(persisted).toEqual({
      kind: 'leaf',
      pane: { cwd: '/w', id: 'p-1', readOnly: true, snapshotFile: '/a/p-1.term' },
    });

    const back = deserializeNode(persisted);
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.readOnly).toBe(true);
    expect(back.pane.snapshotFile).toBe('/a/p-1.term');
  });

  it('writes neither field for an ordinary pane, so an old reader sees what it always did', () => {
    const persisted = serializeNode(leaf(makePane({ id: paneId('p-2') })));
    expect(persisted).toEqual({ kind: 'leaf', pane: { id: 'p-2' } });
  });

  it('reads a record written before read-only panes existed as an ordinary pane', () => {
    const back = deserializeNode({ kind: 'leaf', pane: { id: 'p-3' } });
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.readOnly).toBe(false);
    expect(back.pane.snapshotFile).toBeNull();
  });

  it('refuses a snapshotFile that is not a string, rather than rendering a blank pane', () => {
    expect(() => deserializeNode({ kind: 'leaf', pane: { snapshotFile: 7 } })).toThrow(
      'pane.snapshotFile must be a string',
    );
  });
});

describe('a pane that is a contributed view (ADR 0044)', () => {
  it('round-trips its type and state through serialize/deserialize', () => {
    // Persisted, unlike `initialCommand`: a review tab is a place the user put
    // something, so a relaunch owes them the tab back. What it does not owe them
    // is the contents — `state` names the subject and the view re-reads it.
    const pane = makePane({ id: paneId('p-1'), view: { type: 'github.review', state: { task: 't-1' } } });
    const persisted = serializeNode(leaf(pane));

    expect(persisted).toEqual({
      kind: 'leaf',
      pane: { id: 'p-1', view: { type: 'github.review', state: { task: 't-1' } } },
    });

    const back = deserializeNode(persisted);
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.view).toEqual({ type: 'github.review', state: { task: 't-1' } });
  });

  it('writes no `view` for an ordinary pane, so an old reader sees what it always did', () => {
    const persisted = serializeNode(leaf(makePane({ id: paneId('p-2') })));
    expect(persisted).toEqual({ kind: 'leaf', pane: { id: 'p-2' } });
  });

  it('omits `state` rather than writing it as undefined', () => {
    const persisted = serializeNode(leaf(makePane({ id: paneId('p-3'), view: { type: 'github.review' } })));
    expect(persisted).toEqual({ kind: 'leaf', pane: { id: 'p-3', view: { type: 'github.review' } } });
  });

  it('reads a record written before view panes existed as an ordinary pane', () => {
    const back = deserializeNode({ kind: 'leaf', pane: { id: 'p-4' } });
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.view).toBeNull();
  });

  it('DROPS a malformed view rather than refusing the whole tree', () => {
    // The opposite trade from `snapshotFile`, and deliberately: a bad axis is a
    // window with no shape, while a bad view is one pane — and restoring it as an
    // ordinary empty pane loses less than refusing to restore the window.
    for (const view of [7, null, [], { state: 1 }, { type: '' }, { type: 3 }]) {
      const back = deserializeNode({ kind: 'leaf', pane: { id: 'p-5', view } });
      if (back.kind !== 'leaf') throw new Error('expected a leaf');
      expect(back.pane.view).toBeNull();
    }
  });
});

describe('opening a contributed view (ADR 0044)', () => {
  it('layout.split puts the view on the new pane', async () => {
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(
      LAYOUT_COMMANDS.split,
      { axis: 'row', view: { type: 'github.review', state: { task: 't-1' } } },
      USER,
    );
    expect(result.ok).toBe(true);
    const pane = result.ok ? store.pane(paneId(String(result.value))) : undefined;
    expect(pane?.view).toEqual({ type: 'github.review', state: { task: 't-1' } });
  });

  it('layout.newTab opens a view tab, named by `title`', async () => {
    // Without `title` every contributed tab would be called `term`: a view pane
    // has no program, so nothing ever sets an OSC title on it.
    const { registry, store } = wiredRoots();
    store.open('task:t1', {}, { group: 'task:t1' });
    await registry.invoke(LAYOUT_COMMANDS.switchRoot, { root: 'task:t1' }, USER);

    await registry.invoke(
      LAYOUT_COMMANDS.newTab,
      { view: { type: 'github.review' }, title: 'review' },
      USER,
    );
    const focused = store.focused(rootId('task:t1/tab-2'));
    const pane = focused === null ? undefined : store.pane(focused);
    expect(pane?.view).toEqual({ type: 'github.review' });
    expect(pane?.userTitle).toBe('review');
  });

  it('leaves an ordinary split with no view at all', async () => {
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(LAYOUT_COMMANDS.split, { axis: 'row' }, USER);
    const pane = result.ok ? store.pane(paneId(String(result.value))) : undefined;
    expect(pane?.view).toBeNull();
  });
});

describe('a root opened with a shape', () => {
  it('reproduces the axes, the ratios and the pane ids it was given', () => {
    const store = build();
    store.open('r-1', undefined, {
      tree: {
        kind: 'split',
        axis: 'column',
        ratio: 0.25,
        first: { kind: 'leaf', pane: { id: 'p-a', readOnly: true, snapshotFile: '/a.term' } },
        second: { kind: 'leaf', pane: { id: 'p-b', readOnly: true, snapshotFile: '/b.term' } },
      },
    });

    const tree = store.tree(rootId('r-1'));
    if (tree?.kind !== 'split') throw new Error('expected a split');
    expect(tree.axis).toBe('column');
    expect(tree.ratio).toBeCloseTo(0.25);
    expect(store.panes(rootId('r-1'))).toEqual(['p-a', 'p-b']);
    expect(store.pane(paneId('p-a'))?.snapshotFile).toBe('/a.term');
  });

  it('mints an ordinary single-pane root when the shape cannot be read', () => {
    const store = build();
    store.open('r-2', undefined, { tree: { kind: 'split', axis: 'sideways' } as never });
    expect(store.panes(rootId('r-2'))).toHaveLength(1);
    expect(store.tree(rootId('r-2'))?.kind).toBe('leaf');
    expect(messages().some((m) => m.includes('could not open r-2 with the given shape'))).toBe(true);
  });

  it('opens a root through the command with the shape it was given', async () => {
    const { registry, store } = wiredRoots();
    const result = await registry.invoke(
      LAYOUT_COMMANDS.openRoot,
      {
        root: 'r-3',
        tree: {
          kind: 'split',
          axis: 'row',
          ratio: 0.5,
          first: { kind: 'leaf', pane: { id: 'p-c' } },
          second: { kind: 'leaf', pane: { id: 'p-d' } },
        },
      },
      USER,
    );
    expect(result.ok).toBe(true);
    expect(store.panes(rootId('r-3'))).toEqual(['p-c', 'p-d']);
  });
});

describe('a placeholder over a root that holds captured screens', () => {
  it('is answered, because nothing in that root is live', () => {
    const store = build();
    store.open('r-4', undefined, {
      tree: { kind: 'leaf', pane: { id: 'p-e', readOnly: true, snapshotFile: '/e.term' } },
    });
    store.setPlaceholder(rootId('r-4'), {
      line: 'Archived',
      action: { command: 'x.restore', label: 'Restore', args: { task: 't1' } },
    });

    expect(store.placeholderOf(rootId('r-4'))?.action?.label).toBe('Restore');
  });

  it('is still refused over a root with a LIVE pane — the case the guard exists for', () => {
    const store = build();
    store.open('r-5');
    store.setPlaceholder(rootId('r-5'), { line: 'Creating the worktree' });
    expect(store.placeholderOf(rootId('r-5'))).toBeUndefined();
  });

  it('is refused over a mixed root, where one pane is live', () => {
    const store = build();
    store.open('r-6', undefined, {
      tree: {
        kind: 'split',
        axis: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', pane: { id: 'p-f', readOnly: true, snapshotFile: '/f.term' } },
        second: { kind: 'leaf', pane: { id: 'p-g' } },
      },
    });
    store.setPlaceholder(rootId('r-6'), { line: 'Archived' });
    expect(store.placeholderOf(rootId('r-6'))).toBeUndefined();
  });

  it('announces a changed action, so the button cannot go stale', () => {
    const store = build();
    store.open('r-7', undefined, {
      tree: { kind: 'leaf', pane: { id: 'p-h', readOnly: true, snapshotFile: '/h.term' } },
    });
    const seen: RootID[] = [];
    store.onDidChange((root) => seen.push(root));
    store.setPlaceholder(rootId('r-7'), {
      line: 'Archived',
      action: { command: 'x.restore', label: 'Restore', args: { task: 't1' } },
    });
    store.setPlaceholder(rootId('r-7'), {
      line: 'Archived',
      action: { command: 'x.restore', label: 'Restore', args: { task: 't2' } },
    });
    expect(seen.filter((root) => root === 'r-7')).toHaveLength(2);
  });
});

describe('a given shape beats a persisted one', () => {
  /**
   * The m3 smoke's finding, as a unit test.
   *
   * Shelving a task removes its root, but the layout's write is debounced — so a
   * task revealed in the same breath found its own pre-archive record still on
   * disk. It came back as LIVE panes in a worktree that had just been deleted,
   * and the log said `restored 1 pane(s)`, which is also what a working restore
   * says.
   */
  it('opens the shape the caller gave, not the one still sitting in storage', () => {
    const storage = fakeKV();
    const first = build(storage);
    first.open('r-8');
    first.flush();

    const second = build(storage);
    second.open('r-8', undefined, {
      tree: { kind: 'leaf', pane: { id: 'p-fresh', readOnly: true, snapshotFile: '/a.term' } },
    });

    expect(second.panes(rootId('r-8'))).toEqual(['p-fresh']);
    expect(second.pane(paneId('p-fresh'))?.readOnly).toBe(true);
  });

  it('still restores the persisted one when no shape is given', () => {
    const storage = fakeKV();
    const first = build(storage);
    first.open('r-9');
    first.split(rootId('r-9'), 'row');
    first.flush();

    const second = build(storage);
    second.open('r-9');
    expect(second.panes(rootId('r-9'))).toHaveLength(2);
  });
});

/**
 * A pane's own glyph and actions.
 *
 * The three assertions that matter are about what does NOT happen: a title-only
 * rename must not clear a glyph, and neither field may reach disk. The first is
 * what ⌘⇧R does; the second is `serialize.ts`'s whole reason for being a separate
 * DTO, and a field added to `Pane` without a thought is exactly what it catches.
 */
describe('LayoutStore — what a pane presents', () => {
  const action = { id: 'install', label: 'Install skill', glyph: 'skill' };

  it('carries neither a glyph nor an action by default', () => {
    const store = build();
    store.open();
    expect(store.pane(paneId('p1'))?.icon).toBeNull();
    expect(store.pane(paneId('p1'))?.actions).toEqual([]);
  });

  it('takes a glyph and an action alongside the title', () => {
    const store = build();
    store.open();
    store.rename(paneId('p1'), 'deploy-checks', { icon: 'skill', actions: [action] });
    const pane = store.pane(paneId('p1'));
    expect(pane?.userTitle).toBe('deploy-checks');
    expect(pane?.icon).toBe('skill');
    expect(pane?.actions).toEqual([action]);
  });

  it('leaves both alone when a rename passes neither', () => {
    const store = build();
    store.open();
    store.rename(paneId('p1'), 'deploy-checks', { icon: 'skill', actions: [action] });
    store.rename(paneId('p1'), 'my notes');
    const pane = store.pane(paneId('p1'));
    expect(pane?.userTitle).toBe('my notes');
    expect(pane?.icon).toBe('skill');
    expect(pane?.actions).toEqual([action]);
  });

  it('clears a glyph on an explicit null and actions on an empty list', () => {
    const store = build();
    store.open();
    store.rename(paneId('p1'), 'deploy-checks', { icon: 'skill', actions: [action] });
    store.rename(paneId('p1'), null, { icon: null, actions: [] });
    const pane = store.pane(paneId('p1'));
    expect(pane?.icon).toBeNull();
    expect(pane?.actions).toEqual([]);
  });

  it('refuses a pane it does not have', () => {
    const store = build();
    store.open();
    expect(store.rename(paneId('nope'), 'x', { icon: 'skill' }).ok).toBe(false);
  });

  it('persists neither — a restored pane republishes them', () => {
    const kv = fakeKV();
    const first = build(kv);
    first.open();
    first.rename(paneId('p1'), 'deploy-checks', { icon: 'skill', actions: [action] });
    first.flush();

    const second = build(kv);
    const restored = second.open();
    const pane = second.pane(second.panes(restored)[0]!);
    expect(pane?.userTitle).toBe('deploy-checks');
    expect(pane?.icon).toBeNull();
    expect(pane?.actions).toEqual([]);
  });

  /*
   * The payload itself, not just the restored value: a glyph that reached disk
   * under some other key would satisfy the test above and still be a field the
   * persistence layer had silently started writing.
   */
  it('writes a payload byte-identical to one from before it existed', () => {
    // `newPane` is a counter shared across this file, so each store's pane has
    // its own id and the payloads are compared with those normalised away.
    const write = (kv: KV & { readonly raw: Map<string, unknown> }, present: boolean): string => {
      const store = build(kv);
      const root = store.open();
      const pane = store.panes(root)[0]!;
      store.rename(pane, 'deploy-checks', present ? { icon: 'skill', actions: [action] } : {});
      store.flush();
      return JSON.stringify([...kv.raw]).replaceAll(pane, 'PANE');
    };

    expect(write(fakeKV(), true)).toBe(write(fakeKV(), false));
  });
});

/**
 * `layout.listRoots` carries the focused pane's glyph.
 *
 * Beside its label and for the label's own stated reason: the rail and the tab
 * strip both draw a row for a root, and two consumers resolving it apart is the
 * hand-synced pair this codebase keeps getting bitten by.
 */
describe('layout.listRoots — the focused pane’s glyph', () => {
  const rootsFrom = async (store: LayoutStore, registry: CommandRegistry) => {
    const answer = await registry.invoke(LAYOUT_COMMANDS.listRoots, {}, USER);
    if (!answer.ok) throw new Error('listRoots refused');
    return answer.value as readonly { root: string; icon: string | null }[];
  };

  function wired(): { store: LayoutStore; registry: CommandRegistry } {
    const store = build();
    const registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
    registerLayoutCommands({
      store,
      registry,
      onLastPaneClosed: () => {},
      activeRoot: () => rootId('window-1'),
      homeRoot: rootId('window-1'),
      onSwitchRoot: () => {},
    });
    store.open();
    return { store, registry };
  }

  it('answers null for a pane that publishes none', async () => {
    const { store, registry } = wired();
    expect((await rootsFrom(store, registry))[0]?.icon).toBeNull();
  });

  it('answers the glyph the pane published', async () => {
    const { store, registry } = wired();
    store.rename(paneId('p1'), 'deploy-checks', { icon: 'skill' });
    expect((await rootsFrom(store, registry))[0]?.icon).toBe('skill');
  });

  it('follows the glyph as the pane changes it', async () => {
    const { store, registry } = wired();
    store.rename(paneId('p1'), 'deploy-checks', { icon: 'skill' });
    store.rename(paneId('p1'), 'to-do', { icon: 'notes' });
    expect((await rootsFrom(store, registry))[0]?.icon).toBe('notes');
  });
});
