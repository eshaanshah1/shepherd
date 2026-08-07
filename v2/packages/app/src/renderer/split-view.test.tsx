// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  dividers,
  frames,
  leaf,
  makePane,
  split,
  type Rect,
  type SplitNode,
} from '@shepherd/core/layout';
import { SplitView } from './split-view.tsx';
import { all, mount, one, type Mounted } from './test-dom.ts';

/**
 * What the DOM owes the tree.
 *
 * The assertions are written against `frames()` and `dividers()` rather than
 * against literal numbers on purpose: the renderer and the model must be the
 * same function of the same tree, and a test that restates the expected
 * geometry by hand is a second implementation that can agree with neither.
 */

const RECT: Rect = { x: 0, y: 0, width: 1000, height: 600 };

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function render(tree: SplitNode): HTMLElement {
  mounted = mount(<SplitView tree={tree} />);
  return mounted.container;
}

/** A child's share of its parent, as flex resolves it. */
function growOf(el: HTMLElement): number {
  return Number(el.style.flexGrow);
}

describe('SplitView', () => {
  it('renders a leaf as exactly one pane container, with no divider', () => {
    const pane = makePane({ userTitle: 'only' });
    const container = render(leaf(pane));

    const panes = all(container, 'pane');
    expect(panes).toHaveLength(1);
    expect(panes[0]?.dataset['paneId']).toBe(pane.id);
    expect(all(container, 'divider')).toHaveLength(0);
    expect(all(container, 'split')).toHaveLength(0);
  });

  it('lays a `row` split out side by side at the ratios frames() computes', () => {
    // ADR 0012's vocabulary, which is the thing most likely to be inverted:
    // `row` = a ROW OF PANES = side by side = a vertical hairline.
    const a = makePane({ userTitle: 'a' });
    const b = makePane({ userTitle: 'b' });
    const tree = split('row', 0.62, leaf(a), leaf(b));
    const container = render(tree);

    expect(one(container, 'split').style.flexDirection).toBe('row');

    const [first, second] = all(container, 'split-child');
    expect(first?.dataset['slot']).toBe('first');
    expect(second?.dataset['slot']).toBe('second');

    const f = frames(tree, RECT);
    expect(growOf(first as HTMLElement)).toBeCloseTo((f.get(a.id) as Rect).width / RECT.width, 10);
    expect(growOf(second as HTMLElement)).toBeCloseTo((f.get(b.id) as Rect).width / RECT.width, 10);
    // …and the two shares are the whole of the parent, hairline aside.
    expect(growOf(first as HTMLElement) + growOf(second as HTMLElement)).toBeCloseTo(1, 10);
  });

  it('stacks a `column` split, and divides its height rather than its width', () => {
    const a = makePane({});
    const b = makePane({});
    const tree = split('column', 0.25, leaf(a), leaf(b));
    const container = render(tree);

    expect(one(container, 'split').style.flexDirection).toBe('column');

    const f = frames(tree, RECT);
    const [first] = all(container, 'split-child');
    expect(growOf(first as HTMLElement)).toBeCloseTo((f.get(a.id) as Rect).height / RECT.height, 10);
    expect(one(container, 'divider').dataset['axis']).toBe('column');
  });

  it('renders a nested tree as 3 panes and 2 dividers keyed the way dividers() keys them', () => {
    const a = makePane({ userTitle: 'a' });
    const b = makePane({ userTitle: 'b' });
    const c = makePane({ userTitle: 'c' });
    const tree = split('row', 0.5, leaf(a), split('column', 0.4, leaf(b), leaf(c)));
    const container = render(tree);

    expect(all(container, 'pane')).toHaveLength(3);
    expect(all(container, 'pane').map((el) => el.dataset['paneId'])).toEqual([a.id, b.id, c.id]);

    const rendered = all(container, 'divider').map((el) => el.dataset['dividerKey']);
    expect(rendered).toEqual(dividers(tree, RECT).map((d) => d.key));
    expect(rendered).toEqual(['', '1']); // the root's, then the nested split's
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('keys a divider three levels down the way dividers() does', () => {
    // Depth matters to this assertion and to nothing else: at depth 1 a path is
    // a single number, so `join('.')` and `join('-')` are the same string and a
    // locally reinvented key looks correct. This tree has a `1.1` in it.
    const tree = split(
      'row',
      0.5,
      leaf(makePane({})),
      split('column', 0.5, leaf(makePane({})), split('row', 0.5, leaf(makePane({})), leaf(makePane({})))),
    );
    const container = render(tree);

    const rendered = all(container, 'divider').map((el) => el.dataset['dividerKey']);
    expect(rendered).toEqual(dividers(tree, RECT).map((d) => d.key));
    expect(rendered).toEqual(['', '1', '1.1']);
    expect(all(container, 'pane')).toHaveLength(4);
  });

  it('marks the focused pane and leaves the others dimmable', () => {
    const a = makePane({});
    const b = makePane({});
    const container = render(split('row', 0.5, leaf(a), leaf(b)));
    expect(all(container, 'pane').map((el) => el.dataset['focused'])).toEqual(['false', 'false']);

    mounted?.rerender(<SplitView tree={split('row', 0.5, leaf(a), leaf(b))} focusedPaneId={b.id} />);
    expect(all(container, 'pane').map((el) => el.dataset['focused'])).toEqual(['false', 'true']);
  });

  it('survives a leaf becoming a split in place', () => {
    // The hook-order trap: if one component both early-returned for a leaf and
    // called useRef for a split, this rerender would change its hook count.
    const a = makePane({});
    const b = makePane({});
    const container = render(leaf(a));
    expect(all(container, 'pane')).toHaveLength(1);

    mounted?.rerender(<SplitView tree={split('row', 0.5, leaf(a), leaf(b))} />);
    expect(all(container, 'pane')).toHaveLength(2);
    expect(all(container, 'divider')).toHaveLength(1);
  });

  it('keeps a pane element across a snapshot that is a fresh clone of the same tree', () => {
    // Every `layout:changed` push arrives structure-cloned, so nothing in a new
    // snapshot is object-identical to the last one. Finding G: identity has to
    // come from the PANE ID, not from the object — otherwise a push that changed
    // one pane's title rebuilds every pane's DOM under it.
    const a = makePane({ userTitle: 'a' });
    const b = makePane({ userTitle: 'b' });
    const container = render(split('row', 0.5, leaf(a), leaf(b)));
    const before = all(container, 'pane');

    mounted?.rerender(<SplitView tree={structuredClone(split('row', 0.5, leaf(a), leaf(b)))} />);

    const after = all(container, 'pane');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('takes the focused pane id as a plain string, the way it comes off the wire', () => {
    // `LayoutSnapshot.focusedPaneId` is `string | null`, not the branded `PaneID`:
    // a structured clone carries no brand, and a view that demanded one would
    // have to launder it on the way in.
    const a = makePane({});
    const b = makePane({});
    const container = render(split('row', 0.5, leaf(a), leaf(b)));

    mounted?.rerender(
      <SplitView tree={split('row', 0.5, leaf(a), leaf(b))} focusedPaneId={String(b.id)} />,
    );
    expect(all(container, 'pane').map((el) => el.dataset['focused'])).toEqual(['false', 'true']);
  });
});
