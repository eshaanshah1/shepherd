// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  MAX_RATIO,
  MIN_RATIO,
  leaf,
  makePane,
  split,
  type SplitNode,
} from '@shepherd/core/layout';
import { SplitView } from './split-view.tsx';
import { all, drag, mount, one, withFixedLayout, type Mounted } from './test-dom.ts';

/**
 * Dragging a hairline, after the layout moved to main.
 *
 * The contract is finding F, and it has two halves that pull in opposite
 * directions:
 *
 *   1. **exactly one `layout.setRatio` per drag.** A command per mousemove is a
 *      60Hz IPC storm into the one funnel, with a debounced sqlite write behind
 *      it. The call COUNT is the assertion — this is the whole point of the
 *      finding, and a test that only checked the final value would pass while
 *      the app flooded the channel.
 *   2. **the divider still follows the mouse.** Which means a local preview,
 *      because the tree only comes back a round trip later. So the rendered
 *      ratio has to move on every mousemove while the command count stays 0.
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

function render(tree: SplitNode): {
  container: HTMLElement;
  onSetRatio: ReturnType<typeof vi.fn>;
} {
  restoreLayout = withFixedLayout(WIDTH, HEIGHT);
  const onSetRatio = vi.fn();
  mounted = mount(<SplitView tree={tree} onSetRatio={onSetRatio} />);
  return { container: mounted.container, onSetRatio };
}

/** The share flex gives the first child — i.e. the ratio actually on screen. */
function renderedRatio(container: HTMLElement, slot = 'first'): number {
  const child = all(container, 'split-child').find((el) => el.dataset['slot'] === slot);
  if (child === undefined) throw new Error(`no ${slot} child`);
  return Number(child.style.flexGrow);
}

function lastCall(onSetRatio: ReturnType<typeof vi.fn>): { path: number[]; ratio: number } {
  const call = onSetRatio.mock.calls.at(-1);
  if (call === undefined) throw new Error('onSetRatio was never called');
  return { path: [...(call[0] as readonly number[])], ratio: call[1] as number };
}

describe('PaneDivider drag', () => {
  it('sends exactly ONE setRatio for a drag, whatever it passes through', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [600, 300],
      [640, 300],
      [680, 300],
      [700, 300],
    ]);

    expect(onSetRatio).toHaveBeenCalledTimes(1);
    expect(lastCall(onSetRatio)).toEqual({ path: [], ratio: 0.7 });
  });

  it('previews every move locally while sending nothing at all', () => {
    // The other half of the finding: this is what makes the one-command version
    // still feel like a drag. If a future edit "simplifies" the preview away, the
    // count above still passes and the divider stops moving until mouse-up.
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);
    const divider = one(container, 'divider');

    act(() =>
      divider.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 300 }),
      ),
    );
    expect(renderedRatio(container)).toBeCloseTo(0.5, 10);

    for (const [x, expected] of [
      [600, 0.6],
      [700, 0.7],
      [300, 0.3],
    ] as const) {
      act(() => globalThis.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 300 })));
      expect(renderedRatio(container)).toBeCloseTo(expected, 10);
      expect(renderedRatio(container, 'second')).toBeCloseTo(1 - expected, 10);
    }
    expect(onSetRatio).not.toHaveBeenCalled();

    act(() => globalThis.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 300 })));
    expect(onSetRatio).toHaveBeenCalledTimes(1);
    expect(lastCall(onSetRatio).ratio).toBeCloseTo(0.3, 10);
  });

  it('holds the dragged position after mouse-up, then yields to the tree', () => {
    // The snap-back trap: the command is a round trip through main, and clearing
    // the preview on mouse-up puts the divider back where it started for however
    // many frames that takes — which reads as the drag having been rejected.
    const a = leaf(makePane({}));
    const b = leaf(makePane({}));
    const { container } = render(split('row', 0.5, a, b));

    drag(one(container, 'divider'), [
      [500, 300],
      [800, 300],
    ]);
    expect(renderedRatio(container)).toBeCloseTo(0.8, 10);

    // The other side of it: once a tree arrives the preview must be gone, or a
    // ratio changed by anyone else (the CLI, another window) can never be drawn.
    // 0.62 is a value the drag did not produce, so only the tree can explain it.
    mounted?.rerender(<SplitView tree={split('row', 0.62, a, b)} />);
    expect(renderedRatio(container)).toBeCloseTo(0.62, 10);
  });

  it('clamps with the model’s own clamp, so what you drag is what you commit', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [4000, 300], // well past the right edge — a raw ratio of 4.0
    ]);

    // Both the picture and the command, and the SAME number in each: the preview
    // uses `clampRatio`, which is the function `setRatio` applies in core. Not a
    // second opinion about what is legal — the same one.
    expect(renderedRatio(container)).toBe(MAX_RATIO);
    expect(lastCall(onSetRatio).ratio).toBe(MAX_RATIO);

    drag(one(container, 'divider'), [
      [500, 300],
      [-900, 300],
    ]);
    expect(lastCall(onSetRatio).ratio).toBe(MIN_RATIO);
  });

  it('never mutates the tree it was given', () => {
    // React compares state by identity and the persisted DTO is written from
    // main's object; a view that edited it in place would give you a layout that
    // neither re-renders nor round-trips.
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const before = structuredClone(tree);
    const { container } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [600, 300],
      [700, 300],
    ]);

    expect(tree).toEqual(before);
    expect(tree.kind === 'split' && tree.ratio).toBe(0.5);
  });

  it('reads the cross axis for a column split', () => {
    const tree = split('column', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);

    // clientX is deliberately nonsense here: a column divider must ignore it.
    drag(one(container, 'divider'), [
      [0, 300],
      [999, 150],
    ]);

    expect(lastCall(onSetRatio).ratio).toBeCloseTo(150 / HEIGHT, 10);
  });

  it('addresses the nested split by its own path, not the root', () => {
    const tree = split('row', 0.5, leaf(makePane({})), split('column', 0.5, leaf(makePane({})), leaf(makePane({}))));
    const { container, onSetRatio } = render(tree);

    const nested = all(container, 'divider').find((el) => el.dataset['dividerKey'] === '1');
    expect(nested).toBeDefined();
    drag(nested as HTMLElement, [
      [700, 300],
      [700, 480],
    ]);

    expect(lastCall(onSetRatio)).toEqual({ path: [1], ratio: 480 / HEIGHT });
    // The root did not move — neither in the command nor on screen.
    expect(onSetRatio).toHaveBeenCalledTimes(1);
    expect(renderedRatio(container)).toBeCloseTo(0.5, 10);
  });

  it('refuses to compute a ratio from an unmeasured container', () => {
    // jsdom's real behaviour: every rect is 0×0. Dividing by it yields NaN,
    // which clamps to NaN and renders a pane of no width — so the drag must be
    // dropped instead. No `withFixedLayout` here, on purpose.
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const onSetRatio = vi.fn();
    mounted = mount(<SplitView tree={tree} onSetRatio={onSetRatio} />);

    drag(one(mounted.container, 'divider'), [
      [500, 300],
      [700, 300],
    ]);

    expect(onSetRatio).not.toHaveBeenCalled();
  });

  it('a press with no movement commits nothing', () => {
    // A click on a hairline is not a resize. Committing here would put a no-op
    // through the funnel and a debounced write behind it on every stray click.
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);
    const divider = one(container, 'divider');

    act(() =>
      divider.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 300 }),
      ),
    );
    act(() => globalThis.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 300 })));

    expect(onSetRatio).not.toHaveBeenCalled();
  });

  it('stops following the mouse after the button is released', () => {
    const tree = split('row', 0.5, leaf(makePane({})), leaf(makePane({})));
    const { container, onSetRatio } = render(tree);

    drag(one(container, 'divider'), [
      [500, 300],
      [700, 300],
    ]);
    expect(onSetRatio).toHaveBeenCalledTimes(1);

    act(() => globalThis.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 300 })));
    expect(onSetRatio).toHaveBeenCalledTimes(1);
    expect(renderedRatio(container)).toBeCloseTo(0.7, 10);
  });
});
