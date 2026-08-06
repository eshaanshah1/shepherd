// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RATIO,
  MIN_RATIO,
  leaf,
  makePane,
  setRatio,
  split,
  type SplitNode,
} from '@shepherd/core/layout';
import { SplitView } from './split-view.tsx';
import { all, drag, mount, one, withFixedLayout, type Mounted } from './test-dom.ts';

/**
 * Dragging a hairline.
 *
 * The contract has two halves and both are load-bearing:
 *   1. a drag produces `setRatio(tree, path, clamped)` — the same op the model
 *      exposes, applied to the same path, so a gesture and a scripted layout
 *      change cannot disagree; and
 *   2. the tree that went in is untouched. React state is compared by identity
 *      and the persisted DTO is written from this object; a view that edits it
 *      in place gives you a layout that neither re-renders nor round-trips.
 */

const WIDTH = 1000;
const HEIGHT = 600;

let mounted: Mounted | undefined;
let restoreLayout: (() => void) | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  restoreLayout?.();
  restoreLayout = undefined;
});

function render(tree: SplitNode): { container: HTMLElement; onTreeChange: ReturnType<typeof vi.fn> } {
  restoreLayout = withFixedLayout(WIDTH, HEIGHT);
  const onTreeChange = vi.fn();
  mounted = mount(<SplitView tree={tree} onTreeChange={onTreeChange} />);
  return { container: mounted.container, onTreeChange };
}

function lastTree(onTreeChange: ReturnType<typeof vi.fn>): SplitNode {
  const call = onTreeChange.mock.calls.at(-1);
  if (call === undefined) throw new Error('onTreeChange was never called');
  return call[0] as SplitNode;
}

function rootRatio(node: SplitNode): number {
  if (node.kind !== 'split') throw new Error('not a split');
  return node.ratio;
}

function firstChild(node: SplitNode): SplitNode {
  if (node.kind !== 'split') throw new Error('not a split');
  return node.first;
}

describe('PaneDivider drag', () => {
  it('turns a horizontal drag into setRatio(path, ratio) on the root split', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onTreeChange } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [700, 300],
    ]);

    expect(onTreeChange).toHaveBeenCalledTimes(1);
    // The literal contract: the same call the model would have made.
    expect(lastTree(onTreeChange)).toEqual(setRatio(tree, [], 0.7));
    expect(rootRatio(lastTree(onTreeChange))).toBeCloseTo(0.7, 10);
  });

  it('clamps a drag past the edge instead of collapsing a pane', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onTreeChange } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [4000, 300], // well past the right edge — a raw ratio of 4.0
    ]);

    expect(lastTree(onTreeChange)).toEqual(setRatio(tree, [], MAX_RATIO));
    expect(rootRatio(lastTree(onTreeChange))).toBe(MAX_RATIO);

    drag(one(container, 'divider'), [
      [500, 300],
      [-900, 300],
    ]);
    expect(rootRatio(lastTree(onTreeChange))).toBe(MIN_RATIO);
  });

  it('never mutates the tree it was given', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const before = structuredClone(tree);
    const { container, onTreeChange } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [600, 300],
      [640, 300],
      [700, 300],
    ]);

    expect(onTreeChange).toHaveBeenCalledTimes(3); // one per move, none for the press
    expect(tree).toEqual(before);
    expect(rootRatio(tree)).toBe(0.5);
    expect(lastTree(onTreeChange)).not.toBe(tree);
    // The subtree the drag did not touch is the SAME object — the ops rebuild
    // the spine and share everything else, which is what makes an identity
    // check in React a meaningful "did this change".
    expect(firstChild(lastTree(onTreeChange))).toBe(firstChild(tree));
  });

  it('reads the cross axis for a column split', () => {
    const tree = split('column', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onTreeChange } = render(tree);

    // clientX is deliberately nonsense here: a column divider must ignore it.
    drag(one(container, 'divider'), [
      [0, 300],
      [999, 150],
    ]);

    expect(rootRatio(lastTree(onTreeChange))).toBeCloseTo(150 / HEIGHT, 10);
  });

  it('addresses the nested split by its own path, not the root', () => {
    const tree = split('row', 0.5, leaf(makePane({})), split('column', 0.5, leaf(makePane({})), leaf(makePane({}))));
    const { container, onTreeChange } = render(tree);

    const nested = all(container, 'divider').find((el) => el.dataset['dividerKey'] === '1');
    expect(nested).toBeDefined();
    drag(nested as HTMLElement, [
      [700, 300],
      [700, 480],
    ]);

    expect(lastTree(onTreeChange)).toEqual(setRatio(tree, [1], 480 / HEIGHT));
    expect(rootRatio(lastTree(onTreeChange))).toBe(0.5); // the root did not move
  });

  it('refuses to compute a ratio from an unmeasured container', () => {
    // jsdom's real behaviour: every rect is 0×0. Dividing by it yields NaN,
    // which clamps to NaN and renders a pane of no width — so the drag must be
    // dropped instead. No `withFixedLayout` here, on purpose.
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const onTreeChange = vi.fn();
    mounted = mount(<SplitView tree={tree} onTreeChange={onTreeChange} />);

    drag(one(mounted.container, 'divider'), [
      [500, 300],
      [700, 300],
    ]);

    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it('stops following the mouse after the button is released', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onTreeChange } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [700, 300],
    ]);
    const after = onTreeChange.mock.calls.length;

    globalThis.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 300 }));
    expect(onTreeChange.mock.calls.length).toBe(after);
  });
});
