import type { PaneID } from '@shepherd/sdk';
import type { Pane } from './pane.ts';

/**
 * ADR 0012's vocabulary, unchanged, because it is the thing most likely to be
 * inverted from intuition: **`row` means a ROW OF PANES** — ⌘D, side by side,
 * with a vertical divider between them. `column` is ⌘⇧D, panes stacked, a
 * horizontal divider. Read it off here, never from the word.
 */
export type SplitAxis = 'row' | 'column';

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/** Top-left origin, y growing downward — CSS coordinates, which is also what v1's CGRects were. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A tab's layout: a binary tree whose leaves are panes. */
export type SplitNode =
  | { readonly kind: 'leaf'; readonly pane: Pane }
  | {
      readonly kind: 'split';
      readonly axis: SplitAxis;
      readonly ratio: number;
      readonly first: SplitNode;
      readonly second: SplitNode;
    };

export const leaf = (pane: Pane): SplitNode => ({ kind: 'leaf', pane });

export const split = (
  axis: SplitAxis,
  ratio: number,
  first: SplitNode,
  second: SplitNode,
): SplitNode => ({ kind: 'split', axis, ratio, first, second });

/**
 * Every op returns a new tree plus whether it found its target. v1's ops were
 * `mutating … -> Bool`; React state wants the tree back instead, and the
 * "mutations through one normalizing funnel" rule wants the old tree intact.
 * On a miss, `tree` is the SAME object that went in — so a caller can use
 * identity to skip a re-render.
 */
export interface TreeEdit {
  readonly tree: SplitNode;
  readonly ok: boolean;
}

export function leafIds(node: SplitNode): PaneID[] {
  return node.kind === 'leaf' ? [node.pane.id] : [...leafIds(node.first), ...leafIds(node.second)];
}

export function panes(node: SplitNode): Pane[] {
  return node.kind === 'leaf' ? [node.pane] : [...panes(node.first), ...panes(node.second)];
}

export function firstLeafId(node: SplitNode): PaneID | null {
  return leafIds(node)[0] ?? null;
}

export function findPane(node: SplitNode, id: PaneID): Pane | null {
  return panes(node).find((pane) => pane.id === id) ?? null;
}

export function containsPane(node: SplitNode, id: PaneID): boolean {
  return leafIds(node).includes(id);
}

/** Replace the leaf holding `target` with a 50/50 split of it and `newPane`. */
export function splitPane(
  node: SplitNode,
  target: PaneID,
  axis: SplitAxis,
  newPane: Pane,
): TreeEdit {
  if (node.kind === 'leaf') {
    return node.pane.id === target
      ? { tree: split(axis, 0.5, node, leaf(newPane)), ok: true }
      : { tree: node, ok: false };
  }
  const inFirst = splitPane(node.first, target, axis, newPane);
  if (inFirst.ok) {
    return { tree: split(node.axis, node.ratio, inFirst.tree, node.second), ok: true };
  }
  const inSecond = splitPane(node.second, target, axis, newPane);
  if (inSecond.ok) {
    return { tree: split(node.axis, node.ratio, node.first, inSecond.tree), ok: true };
  }
  return { tree: node, ok: false };
}

/** Swap one pane for the result of `transform`. The transform must be pure. */
export function updatePane(
  node: SplitNode,
  id: PaneID,
  transform: (pane: Pane) => Pane,
): TreeEdit {
  if (node.kind === 'leaf') {
    return node.pane.id === id
      ? { tree: leaf(transform(node.pane)), ok: true }
      : { tree: node, ok: false };
  }
  const inFirst = updatePane(node.first, id, transform);
  if (inFirst.ok) {
    return { tree: split(node.axis, node.ratio, inFirst.tree, node.second), ok: true };
  }
  const inSecond = updatePane(node.second, id, transform);
  if (inSecond.ok) {
    return { tree: split(node.axis, node.ratio, node.first, inSecond.tree), ok: true };
  }
  return { tree: node, ok: false };
}

export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

/**
 * Navigate `path` (0 = first, 1 = second) to a `.split` node and set its ratio,
 * clamped so a pane can't collapse to nothing. An empty path targets `node`
 * itself. A path that doesn't land on a split is a no-op.
 */
export function setRatio(node: SplitNode, path: readonly number[], ratio: number): SplitNode {
  if (node.kind !== 'split') return node;
  if (path.length === 0) {
    return split(node.axis, clampRatio(ratio), node.first, node.second);
  }
  const rest = path.slice(1);
  if (path[0] === 0) {
    return split(node.axis, node.ratio, setRatio(node.first, rest, ratio), node.second);
  }
  if (path[0] === 1) {
    return split(node.axis, node.ratio, node.first, setRatio(node.second, rest, ratio));
  }
  return node;
}

export const clampRatio = (ratio: number): number =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

/** Where each pane sits inside `rect`. The one authority on split geometry. */
export function frames(node: SplitNode, rect: Rect): Map<PaneID, Rect> {
  const out = new Map<PaneID, Rect>();
  walk(node, rect, out);
  return out;
}

function walk(node: SplitNode, rect: Rect, out: Map<PaneID, Rect>): void {
  if (node.kind === 'leaf') {
    out.set(node.pane.id, rect);
    return;
  }
  const [r1, r2] = childRects(node.axis, node.ratio, rect);
  walk(node.first, r1, out);
  walk(node.second, r2, out);
}

function childRects(axis: SplitAxis, ratio: number, rect: Rect): [Rect, Rect] {
  if (axis === 'row') {
    const w = rect.width * ratio;
    return [
      { x: rect.x, y: rect.y, width: w, height: rect.height },
      { x: rect.x + w, y: rect.y, width: rect.width - w, height: rect.height },
    ];
  }
  const h = rect.height * ratio;
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: h },
    { x: rect.x, y: rect.y + h, width: rect.width, height: rect.height - h },
  ];
}

/**
 * One draggable hairline: the split's `path` from the root, its axis/ratio, the
 * zero-thickness boundary strip on the split line, and `span` — the split
 * rect's extent along the axis, which is what the drag math divides by.
 */
export interface SplitDivider {
  readonly path: readonly number[];
  readonly axis: SplitAxis;
  readonly ratio: number;
  readonly rect: Rect;
  readonly span: number;
  /** Stable across calls and unique within a tree — safe as a React key. */
  readonly key: string;
}

/**
 * A divider's identity, derived from its path and nothing else.
 *
 * Exported because the renderer builds its dividers while recursing the tree
 * and must produce the same key `dividers()` does. Two `path.join('.')`
 * expressions in two packages is exactly the hand-synced pair this codebase
 * keeps getting bitten by, so there is one function and both call it.
 */
export const dividerKey = (path: readonly number[]): string => path.join('.');

/** Flat list of every split's divider, resolved with the same math as `frames`. A leaf has none. */
export function dividers(node: SplitNode, rect: Rect, path: readonly number[] = []): SplitDivider[] {
  if (node.kind !== 'split') return [];
  const [r1, r2] = childRects(node.axis, node.ratio, rect);
  const boundary: Rect =
    node.axis === 'row'
      ? { x: rect.x + rect.width * node.ratio, y: rect.y, width: 0, height: rect.height }
      : { x: rect.x, y: rect.y + rect.height * node.ratio, width: rect.width, height: 0 };
  const here: SplitDivider = {
    path,
    axis: node.axis,
    ratio: node.ratio,
    rect: boundary,
    span: node.axis === 'row' ? rect.width : rect.height,
    key: dividerKey(path),
  };
  return [
    here,
    ...dividers(node.first, r1, [...path, 0]),
    ...dividers(node.second, r2, [...path, 1]),
  ];
}

/** The geometrically nearest pane in `dir` — what ⌘⌥-arrow moves focus to. */
export function neighbor(
  node: SplitNode,
  from: PaneID,
  dir: FocusDirection,
  rect: Rect,
): PaneID | null {
  const f = frames(node, rect);
  const src = f.get(from);
  if (src === undefined) return null;
  const ox = src.x + src.width / 2;
  const oy = src.y + src.height / 2;

  let bestId: PaneID | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [id, r] of f) {
    if (id === from) continue;
    const dx = r.x + r.width / 2 - ox;
    const dy = r.y + r.height / 2 - oy;
    // The axis with the larger component wins, so a diagonal neighbour only
    // answers for the direction it mostly lies in.
    const inDir =
      dir === 'left'
        ? dx < 0 && Math.abs(dx) >= Math.abs(dy)
        : dir === 'right'
          ? dx > 0 && Math.abs(dx) >= Math.abs(dy)
          : dir === 'up'
            ? dy < 0 && Math.abs(dy) >= Math.abs(dx)
            : dy > 0 && Math.abs(dy) >= Math.abs(dx);
    if (!inDir) continue;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * The pane to focus after closing `id`: the first leaf of its sibling subtree,
 * since the split it lives under collapses to that sibling. `null` if `id` is
 * the root leaf (no sibling) or isn't in the tree.
 */
export function siblingLeaf(node: SplitNode, id: PaneID): PaneID | null {
  if (node.kind !== 'split') return null;
  if (node.first.kind === 'leaf' && node.first.pane.id === id) return firstLeafId(node.second);
  if (node.second.kind === 'leaf' && node.second.pane.id === id) return firstLeafId(node.first);
  return siblingLeaf(node.first, id) ?? siblingLeaf(node.second, id);
}

/**
 * The tree with `id` removed; its parent split collapses to the sibling.
 * `null` means `id` was the only leaf — the caller should close the tab.
 */
export function closing(node: SplitNode, id: PaneID): SplitNode | null {
  if (node.kind === 'leaf') return node.pane.id === id ? null : node;
  if (containsPane(node.first, id)) {
    const first = closing(node.first, id);
    return first === null ? node.second : split(node.axis, node.ratio, first, node.second);
  }
  if (containsPane(node.second, id)) {
    const second = closing(node.second, id);
    return second === null ? node.first : split(node.axis, node.ratio, node.first, second);
  }
  return node;
}
