import { leafIds, type LayoutStore } from '@shepherd/core/layout';
import type { RootID } from '@shepherd/sdk';
import type { LayoutSnapshot, ViewportRect } from '../shared/index.ts';

/**
 * `LayoutStore` → the wire DTO. Electron-free on purpose, so the projection can
 * be asserted against a real store rather than by looking at a running window.
 *
 * Note which `focusedPaneId` this reports: `store.focused(root)`, which resolves
 * a stale id to the first leaf. The renderer draws the focus ring from this
 * field, so handing it the raw one would let a pane that has just been closed
 * leave the ring on nothing at all — and the renderer has no way to notice,
 * because resolving it is exactly the decision core keeps.
 *
 * Not `store.project(root)`: that is the *extension* DTO (`LayoutRoot`, with
 * `NodeID`s and a `view` discriminant), which throws away the ratios, the cwds
 * and the pane titles a renderer has to draw. Two projections of one tree is the
 * right answer here — an extension is told what a pane IS, a renderer is told
 * how to draw it.
 */
export function layoutSnapshot(store: LayoutStore, root: RootID): LayoutSnapshot | null {
  const tree = store.tree(root);
  if (tree === undefined) return null;

  const sessions: Record<string, string> = {};
  for (const pane of leafIds(tree)) {
    const session = store.sessionFor(pane);
    if (session !== undefined) sessions[pane] = session;
  }

  return {
    root,
    tree,
    focusedPaneId: store.focused(root),
    zoomedPaneId: store.zoomed(root),
    sessions,
  };
}

/**
 * A viewport rect off the wire. A renderer message is a value from another
 * process; a `NaN` width here would propagate into `frames()` and make every
 * `neighbor` lookup answer `null` — ⌘⌥← doing nothing, with nothing logged.
 */
export function parseViewport(raw: unknown): ViewportRect | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  // Non-null asserted by the loop above; spelled out so the shape is the DTO's.
  return { x: out['x'] as number, y: out['y'] as number, width: out['width'] as number, height: out['height'] as number };
}
