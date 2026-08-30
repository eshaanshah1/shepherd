import { describe, expect, it } from 'vitest';
import { LayoutStore } from '@shepherd/core/layout';
import { nullLogger, paneId, rootId, sessionId, systemClock, type SessionID } from '@shepherd/sdk';
import { layoutSnapshot, layoutSnapshots, parseViewport } from './layout-snapshot.ts';

/**
 * What crosses to the renderer.
 *
 * Asserted against a REAL `LayoutStore` rather than a hand-built object: the
 * projection's whole job is to agree with the store, and a fixture that restates
 * the store's answers is a second implementation that can agree with neither.
 */

const ROOT = rootId('window-1');

function store(): { store: LayoutStore; killed: SessionID[] } {
  const killed: SessionID[] = [];
  const s = new LayoutStore({
    logger: nullLogger,
    clock: systemClock,
    sessions: { release: (id) => void killed.push(id), isLive: () => true },
  });
  s.open(ROOT);
  return { store: s, killed };
}

describe('layoutSnapshot', () => {
  it('projects the tree main owns, pane ids and all', () => {
    const { store: s } = store();
    const snapshot = layoutSnapshot(s, ROOT);

    expect(snapshot?.root).toBe(ROOT);
    expect(snapshot?.tree).toBe(s.tree(ROOT));
    expect(snapshot?.focusedPaneId).toBe(s.focused(ROOT));
    expect(snapshot?.zoomedPaneId).toBeNull();
    expect(snapshot?.sessions).toEqual({});
  });

  it('carries an empty root and the line it says about itself', () => {
    const { store: s } = store();
    const empty = s.open('task:t1', undefined, { empty: true });
    s.setPlaceholder(empty, { line: 'Creating the worktree', names: ['shepherd', 'fix-login'] });

    const snapshot = layoutSnapshot(s, empty);

    expect(snapshot?.tree).toBeNull();
    expect(snapshot?.placeholder).toEqual({ line: 'Creating the worktree', names: ['shepherd', 'fix-login'] });
  });

  it('omits the key entirely for an empty root nobody explained', () => {
    // The home root at launch. Two reasons to be empty and only one has
    // anything to say — absent is how the page tells them apart.
    const { store: s } = store();
    const empty = s.open('window-2', undefined, { empty: true });

    expect(layoutSnapshot(s, empty)).not.toHaveProperty('placeholder');
  });

  /**
   * MUTATION TARGET. Projecting `state.placeholder` directly instead of asking
   * `placeholderOf` would ship `Creating the worktree` over a running agent —
   * the one way this feature can draw something untrue.
   */
  it('drops the line once the root holds a pane', () => {
    const { store: s } = store();
    const empty = s.open('task:t1', undefined, { empty: true });
    s.setPlaceholder(empty, { line: 'Starting the agent' });

    s.split(empty, 'row');

    expect(layoutSnapshot(s, empty)).not.toHaveProperty('placeholder');
  });

  it('reports a root it has never heard of as null rather than a blank tree', () => {
    const { store: s } = store();
    // The failure this prevents: an empty projection renders a window with no
    // panes and nothing anywhere saying the root was wrong.
    expect(layoutSnapshot(s, rootId('window-9'))).toBeNull();
  });

  it('carries the pane→session map, and drops a session that has exited', () => {
    const { store: s } = store();
    const pane = s.focused(ROOT);
    expect(pane).not.toBeNull();
    const session = sessionId('sess-1');

    s.bindSession(pane as ReturnType<typeof paneId>, session);
    expect(layoutSnapshot(s, ROOT)?.sessions).toEqual({ [pane as string]: session });

    s.unbindSession(session);
    expect(layoutSnapshot(s, ROOT)?.sessions).toEqual({});
  });

  it('resolves the focused pane, so a closed one never keeps the focus ring', () => {
    const { store: s } = store();
    const first = s.focused(ROOT);
    const second = s.split(ROOT, 'row');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(layoutSnapshot(s, ROOT)?.focusedPaneId).toBe(second.value);

    // Close the focused pane. The raw field would now name a pane that is gone;
    // `store.focused` resolves it, and this projection is what the ring is drawn
    // from — so it has to be the resolved one.
    s.close(second.value);
    expect(layoutSnapshot(s, ROOT)?.focusedPaneId).toBe(first);
  });

  it('a split shows up as a split, with the ratio the renderer has to draw', () => {
    const { store: s } = store();
    s.split(ROOT, 'column');
    const tree = layoutSnapshot(s, ROOT)?.tree;

    expect(tree?.kind).toBe('split');
    if (tree?.kind !== 'split') return;
    expect(tree.axis).toBe('column');
    // `store.project()` — the extension DTO — would have dropped this.
    expect(tree.ratio).toBe(0.5);
  });

  it('is plain structured-cloneable data, with no class instance in it', () => {
    // Decision A: the tree crosses as-is, so anything unclonable in it would
    // surface as a runtime IPC failure and nothing else.
    const { store: s } = store();
    s.split(ROOT, 'row');
    const snapshot = layoutSnapshot(s, ROOT);
    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });
});

describe('layoutSnapshots', () => {
  it('carries every root and the active one', () => {
    const { store: s } = store();
    s.open('task-1');
    const envelope = layoutSnapshots(s, rootId('task-1'));
    expect(envelope?.active).toBe('task-1');
    expect(envelope?.roots.map((root) => root.root)).toEqual(['window-1', 'task-1']);
  });

  it('passes `active` through verbatim rather than second-guessing it', () => {
    // The two places that set it — `layout.switchRoot`, which refuses a root
    // that does not exist, and the last-pane fall-through, which lands on home —
    // are where that invariant is kept. A second opinion here could only ever
    // disagree with them.
    const { store: s } = store();
    expect(layoutSnapshots(s, rootId('ghost'))?.active).toBe('ghost');
  });

  it('is null with no roots at all', () => {
    const empty = new LayoutStore({
      logger: nullLogger,
      clock: systemClock,
      sessions: { release: () => {}, isLive: () => true },
    });
    expect(layoutSnapshots(empty, ROOT)).toBeNull();
  });
});

describe('parseViewport', () => {
  it('accepts a rect', () => {
    expect(parseViewport({ x: 0, y: 0, width: 1000, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
    });
  });

  it('refuses a NaN rather than poisoning every neighbour lookup', () => {
    // A NaN width propagates into `frames()`, `neighbor` then answers null for
    // every direction, and ⌘⌥← does nothing with nothing logged.
    expect(parseViewport({ x: 0, y: 0, width: Number.NaN, height: 600 })).toBeNull();
    expect(parseViewport({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 600 })).toBeNull();
  });

  it('refuses anything that is not a rect', () => {
    expect(parseViewport(null)).toBeNull();
    expect(parseViewport('1000x600')).toBeNull();
    expect(parseViewport({ width: 1000, height: 600 })).toBeNull(); // no x/y
    expect(parseViewport({ x: '0', y: 0, width: 1000, height: 600 })).toBeNull();
  });
});
