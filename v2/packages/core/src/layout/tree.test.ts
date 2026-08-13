// Translated 1:1 from spike/seam1/Tests/SplitTreeTests.swift — one `it` per
// XCTest func, in the original order, with the original names in the title so a
// reviewer can diff the two files side by side. Two substitutions, both forced
// by M0 having no agent-state model yet (the reviewer's "keep Pane narrow"):
//   - `$0.state = .working`     -> `title` (the OSC title the program sets), the
//                                  remaining live-only field on a pane.
//   - `state == .shell` after a -> `title === ''`, same reason: the round trip
//     round trip                  must drop live state, whatever live state is.
//
// The Swift ops mutate in place and return a Bool; these return `{ tree, ok }`
// (React state wants an immutable return). Coordinates are top-left origin in
// both — a `.column` split puts the second pane at y = ratio·h, which is what
// CGRect did here and what the DOM does.

import { describe, expect, it } from 'vitest';
import { paneId } from '@shepherd/sdk';
import {
  closing,
  dividerKey,
  dividers,
  firstLeafId,
  findPane,
  frames,
  leaf,
  leafIds,
  makePane,
  neighbor,
  panes,
  setRatio,
  siblingLeaf,
  split,
  splitPane,
  updatePane,
  type SplitNode,
} from './index.ts';
import { displayTitle as displayTitleOf } from './pane.ts';
import { deserializeNode, serializeNode } from './serialize.ts';

/** `Pane(paneID: "a")` — a pane with a known id and nothing else set. */
const p = (id: string) => makePane({ id: paneId(id) });

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Names the ids in `tree` in leaf order, for the assertions that used `leafIDs`. */
const ids = (tree: SplitNode) => leafIds(tree).map(String);

describe('SplitTree (ported from SplitTreeTests.swift)', () => {
  it('testLeafIDsAndLookup', () => {
    const tree = leaf(p('a'));
    expect(ids(tree)).toEqual(['a']);
    expect(firstLeafId(tree)).toBe('a');
    expect(findPane(tree, paneId('a'))?.id).toBe('a');
    expect(findPane(tree, paneId('nope'))).toBeNull();
  });

  it('testNestedLeafOrder', () => {
    const tree = split('row', 0.5, leaf(p('a')), split('column', 0.5, leaf(p('b')), leaf(p('c'))));
    expect(ids(tree)).toEqual(['a', 'b', 'c']);
  });

  it('testSplitReplacesLeaf', () => {
    const { tree, ok } = splitPane(leaf(p('a')), paneId('a'), 'row', p('b'));
    expect(ok).toBe(true);
    expect(ids(tree)).toEqual(['a', 'b']);
    expect(tree.kind).toBe('split');
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.axis).toBe('row');
    expect(tree.ratio).toBe(0.5);
  });

  it('testSplitUnknownPaneReturnsFalse', () => {
    const before = leaf(p('a'));
    const { tree, ok } = splitPane(before, paneId('zzz'), 'row', p('b'));
    expect(ok).toBe(false);
    expect(ids(tree)).toEqual(['a']);
    // Immutable ops: a failed split hands back the identical tree, not a copy.
    expect(tree).toBe(before);
  });

  it('testFramesRowSplit', () => {
    const tree = split('row', 0.5, leaf(p('a')), leaf(p('b')));
    const f = frames(tree, rect(0, 0, 100, 40));
    expect(f.get(paneId('a'))).toEqual(rect(0, 0, 50, 40));
    expect(f.get(paneId('b'))).toEqual(rect(50, 0, 50, 40));
  });

  it('testNeighborRight', () => {
    const tree = split('row', 0.5, leaf(p('a')), leaf(p('b')));
    const r = rect(0, 0, 100, 40);
    expect(neighbor(tree, paneId('a'), 'right', r)).toBe('b');
    expect(neighbor(tree, paneId('a'), 'left', r)).toBeNull();
  });

  it('testCloseCollapsesParentToSibling', () => {
    const tree = split('row', 0.5, leaf(p('a')), leaf(p('b')));
    const after = closing(tree, paneId('a'));
    expect(after && ids(after)).toEqual(['b']);
    expect(after?.kind).toBe('leaf');
  });

  it('testCloseOnlyLeafReturnsNil', () => {
    expect(closing(leaf(p('a')), paneId('a'))).toBeNull();
  });

  it('testSiblingLeaf', () => {
    const t = split('row', 0.5, leaf(p('1')), split('column', 0.5, leaf(p('2')), leaf(p('3'))));
    expect(siblingLeaf(t, paneId('3'))).toBe('2'); // immediate sibling leaf
    expect(siblingLeaf(t, paneId('2'))).toBe('3'); // immediate sibling leaf
    expect(siblingLeaf(t, paneId('1'))).toBe('2'); // sibling subtree's firstLeafId
    expect(siblingLeaf(leaf(p('x')), paneId('x'))).toBeNull(); // root leaf, no sibling
    expect(siblingLeaf(t, paneId('nope'))).toBeNull(); // absent
  });

  it('testUpdatePane', () => {
    const before = split('column', 0.5, leaf(p('a')), leaf(p('b')));
    const { tree, ok } = updatePane(before, paneId('b'), (pane) => ({ ...pane, title: 'vim' }));
    expect(ok).toBe(true);
    expect(findPane(tree, paneId('b'))?.title).toBe('vim');
    // The input is untouched — this is the property the Swift `mutating` op did not have.
    expect(findPane(before, paneId('b'))?.title).toBe('');
  });

  it('testDividersSingleRowSplit', () => {
    const tree = split('row', 0.5, leaf(p('a')), leaf(p('b')));
    const ds = dividers(tree, rect(0, 0, 100, 40));
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d.path).toEqual([]);
    expect(d.axis).toBe('row');
    expect(d.ratio).toBe(0.5);
    expect(d.span).toBe(100);
    expect(d.rect.x + d.rect.width / 2).toBeCloseTo(50, 3); // boundary at x=50
    expect(d.rect.height).toBeCloseTo(40, 3); // full split height
  });

  it('testDividersLeafHasNone', () => {
    expect(dividers(leaf(p('a')), rect(0, 0, 100, 40))).toEqual([]);
  });

  it('testDividersNested', () => {
    const tree = split('row', 0.5, leaf(p('a')), split('column', 0.5, leaf(p('b')), leaf(p('c'))));
    const ds = dividers(tree, rect(0, 0, 100, 40));
    expect(ds).toHaveLength(2);
    const outer = ds.find((d) => d.path.length === 0);
    const inner = ds.find((d) => d.path.join('.') === '1');
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(outer!.axis).toBe('row');
    expect(outer!.span).toBe(100);
    expect(outer!.rect.x + outer!.rect.width / 2).toBeCloseTo(50, 3);
    // Inner column split lives in the right half (x 50..100, full height 40).
    expect(inner!.axis).toBe('column');
    expect(inner!.span).toBe(40); // splitRect.height of the inner sub-rect
    expect(inner!.rect.y + inner!.rect.height / 2).toBeCloseTo(20, 3); // boundary at y=20
    expect(inner!.rect.width).toBeCloseTo(50, 3); // spans the right half
  });

  it('testDividersAsymmetricRatio', () => {
    const tree = split('row', 0.3, leaf(p('a')), leaf(p('b')));
    const ds = dividers(tree, rect(0, 0, 100, 40));
    expect(ds[0]!.rect.x + ds[0]!.rect.width / 2).toBeCloseTo(30, 3); // boundary at 30%
    expect(ds[0]!.ratio).toBe(0.3);
  });

  it('testDividerKeysAreStableAndUnique', () => {
    const tree = split('row', 0.5, leaf(p('a')), split('column', 0.5, leaf(p('b')), leaf(p('c'))));
    const r = rect(0, 0, 100, 40);
    const keys = dividers(tree, r).map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length); // unique
    expect(keys).toEqual(dividers(tree, r).map((d) => d.key)); // stable across calls
  });

  it('derives every divider key from dividerKey(path), separator and all', () => {
    // The renderer builds its own dividers while recursing and keys them with
    // this same function. Two `path.join(…)` expressions in two packages is the
    // hand-synced pair this repo keeps getting bitten by — so the format is
    // asserted here, in the package that owns it, and at a depth where the
    // separator is actually visible (at depth 1 every separator looks alike).
    const tree = split(
      'row',
      0.5,
      leaf(p('a')),
      split('column', 0.5, leaf(p('b')), split('row', 0.5, leaf(p('c')), leaf(p('d')))),
    );
    const ds = dividers(tree, rect(0, 0, 100, 40));
    expect(ds.map((d) => d.key)).toEqual(['', '1', '1.1']);
    expect(ds.map((d) => d.key)).toEqual(ds.map((d) => dividerKey(d.path)));
  });

  it('testFramesColumnSplit', () => {
    const tree = split('column', 0.5, leaf(p('a')), leaf(p('b')));
    const f = frames(tree, rect(0, 0, 40, 100));
    expect(f.get(paneId('a'))).toEqual(rect(0, 0, 40, 50));
    expect(f.get(paneId('b'))).toEqual(rect(0, 50, 40, 50));
  });

  it('testNeighborUpDown', () => {
    const tree = split('column', 0.5, leaf(p('a')), leaf(p('b')));
    const r = rect(0, 0, 40, 100);
    expect(neighbor(tree, paneId('a'), 'down', r)).toBe('b');
    expect(neighbor(tree, paneId('a'), 'up', r)).toBeNull();
    expect(neighbor(tree, paneId('b'), 'up', r)).toBe('a');
  });

  it('testSetRatioEmptyPathTargetsReceiver', () => {
    const tree = setRatio(split('row', 0.5, leaf(p('a')), leaf(p('b'))), [], 0.7);
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.ratio).toBe(0.7);
  });

  it('testSetRatioNavigatesToNestedSplit', () => {
    const tree = setRatio(
      split('row', 0.5, leaf(p('a')), split('column', 0.5, leaf(p('b')), leaf(p('c')))),
      [1],
      0.25,
    );
    if (tree.kind !== 'split') throw new Error('expected outer split');
    expect(tree.ratio).toBe(0.5); // outer unchanged
    if (tree.second.kind !== 'split') throw new Error('expected nested split');
    expect(tree.second.ratio).toBe(0.25);
  });

  it('testSetRatioClamps', () => {
    const low = setRatio(split('row', 0.5, leaf(p('a')), leaf(p('b'))), [], 0.02);
    if (low.kind !== 'split') throw new Error('expected split');
    expect(low.ratio).toBe(0.1);

    const high = setRatio(split('row', 0.5, leaf(p('a')), leaf(p('b'))), [], 0.98);
    if (high.kind !== 'split') throw new Error('expected split');
    expect(high.ratio).toBe(0.9);
  });

  it('testCodableRoundTripKeepsStructureAndIdDropsLiveState', () => {
    const { tree } = updatePane(
      split('row', 0.3, leaf(p('a')), leaf(p('b'))),
      paneId('a'),
      (pane) => ({ ...pane, userTitle: 'left', cwd: '/tmp', title: 'live osc title' }),
    );
    const wire = JSON.parse(JSON.stringify(serializeNode(tree))) as unknown;
    const back = deserializeNode(wire);
    expect(leafIds(back)).toHaveLength(2); // structure preserved
    const restored = panes(back).find((pane) => pane.userTitle === 'left');
    expect(restored?.cwd).toBe('/tmp'); // persisted fields survive
    expect(restored?.title).toBe(''); // live state dropped
    // The id SURVIVES since R1 (ADR 0036). It used to be minted fresh, which was
    // right while sessions died with the app — with `shepherdd` holding the ptys
    // a fresh id means the restored pane cannot find the session it was showing,
    // so it creates a second one and orphans the first.
    expect(restored?.id).toBe('a');
    if (back.kind !== 'split') throw new Error('expected split');
    expect(back.ratio).toBe(0.3);
  });

  it('testInitialCommandNeverPersists', () => {
    const pane = makePane({
      userTitle: 'composed',
      initialCommand: `p=$(cat '/tmp/x'); rm -f '/tmp/x'; claude "$p"\n`,
    });
    const json = JSON.stringify(serializeNode(leaf(pane)));
    expect(json).not.toContain('initialCommand');
    expect(json).not.toContain('claude');
    const back = deserializeNode(JSON.parse(json) as unknown);
    const id = firstLeafId(back);
    const restored = id === null ? null : findPane(back, id);
    expect(restored?.userTitle).toBe('composed');
    expect(restored?.initialCommand).toBeNull();
  });
});

// Not in the Swift suite: an explicit pin for the one piece of vocabulary that
// inverts if you read it from intuition (ADR 0012). `.row` = ⌘D = a ROW OF
// PANES side by side; `.column` = ⌘⇧D = panes stacked.
describe('SplitAxis vocabulary (ADR 0012)', () => {
  it('row lays panes side by side; column stacks them', () => {
    const row = frames(split('row', 0.5, leaf(p('a')), leaf(p('b'))), rect(0, 0, 100, 40));
    expect(row.get(paneId('a'))).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    expect(row.get(paneId('b'))).toEqual({ x: 50, y: 0, width: 50, height: 40 });

    const column = frames(split('column', 0.5, leaf(p('a')), leaf(p('b'))), rect(0, 0, 40, 100));
    expect(column.get(paneId('a'))).toEqual({ x: 0, y: 0, width: 40, height: 50 });
    expect(column.get(paneId('b'))).toEqual({ x: 0, y: 50, width: 40, height: 50 });
  });
});

describe('Pane.displayTitle', () => {
  it('prefers the user name, then the program title, then `term`', () => {
    const base = makePane({ id: paneId('a') });
    expect(displayTitleOf({ ...base })).toBe('term');
    expect(displayTitleOf({ ...base, title: 'vim' })).toBe('vim');
    expect(displayTitleOf({ ...base, title: 'vim', userTitle: 'api' })).toBe('api');
  });

  /**
   * The cwd is drawn BESIDE the name, never as it. A label that is a path says
   * where you are twice — the pane head already prints the directory — and says
   * what is running nowhere.
   */
  it('never answers with the cwd, however deep it is', () => {
    expect(displayTitleOf(makePane({ cwd: '/Users/x' }))).toBe('term');
    expect(displayTitleOf(makePane({ cwd: '/Users/someone-else/code' }))).toBe('term');
    expect(displayTitleOf(makePane({ cwd: '/a/b/c', title: 'vim' }))).toBe('vim');
  });

  it('treats an empty name as no name, so a cleared title falls through', () => {
    // The mirror reports `title: ''` when a shell goes back to its prompt, and
    // that has to read as "nothing is running" rather than as a name.
    expect(displayTitleOf(makePane({ title: '', userTitle: '' }))).toBe('term');
  });
});
