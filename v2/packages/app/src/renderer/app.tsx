import { useCallback, useState, type ReactNode } from 'react';
import type { PaneID } from '@shepherd/sdk';
import {
  closing,
  firstLeafId,
  leaf,
  leafIds,
  makePane,
  siblingLeaf,
  splitPane,
  type SplitAxis,
  type SplitNode,
} from '@shepherd/core/layout';
import { SplitView } from './split-view.tsx';

/**
 * The M0 shell. It owns a tree and a focused pane id, and every gesture is a
 * call to a ported core op — which is the point of this phase: the layout is
 * proven, in a real window, before a PTY is attached to a leaf of it.
 *
 * The split/close controls are buttons rather than menu accelerators on
 * purpose. ⌘D / ⌘⇧D / ⌘W as menu items would be consumed before a terminal
 * sees them (v1's workbench-keys lesson), and the right place to settle that
 * fight is the phase where xterm is present to lose it.
 */

function seedTree(): SplitNode {
  // A row split whose second child is a column split: three leaves, two
  // dividers, both axes, one nesting level. The smallest tree that can be wrong
  // in an interesting way.
  return {
    kind: 'split',
    axis: 'row',
    ratio: 0.56,
    first: leaf(makePane({ userTitle: 'shepherd', cwd: '/Users/you/code/shepherd' })),
    second: {
      kind: 'split',
      axis: 'column',
      ratio: 0.5,
      first: leaf(makePane({ userTitle: 'agent', cwd: '/Users/you/code/shepherd/v2' })),
      second: leaf(makePane({ userTitle: 'logs', cwd: '/Users/you/code/shepherd/docs' })),
    },
  };
}

export function App(): ReactNode {
  const [tree, setTree] = useState<SplitNode>(seedTree);
  const [focused, setFocused] = useState<PaneID | null>(null);

  // Focus is derived, not asserted: a pane that has been closed must not stay
  // the focused id, and the seed's ids are minted inside `useState` so there is
  // nothing to name before the first render.
  const paneIds = leafIds(tree);
  const focusedId = focused !== null && paneIds.includes(focused) ? focused : (paneIds[0] ?? null);

  const split = useCallback(
    (axis: SplitAxis) => {
      if (focusedId === null) return;
      const pane = makePane({});
      const edit = splitPane(tree, focusedId, axis, pane);
      if (!edit.ok) return;
      setTree(edit.tree);
      setFocused(pane.id);
    },
    [tree, focusedId],
  );

  const close = useCallback(() => {
    if (focusedId === null) return;
    const next = closing(tree, focusedId);
    // `null` means the last pane. In the real app that closes the tab; here
    // there is no tab, so the gesture is simply refused.
    if (next === null) return;
    const heir = siblingLeaf(tree, focusedId);
    setTree(next);
    setFocused(heir ?? firstLeafId(next));
  }, [tree, focusedId]);

  return (
    <div className="sh-app">
      <header className="sh-bar">
        <span className="sh-brand">SHEPHERD</span>
        <span className="sh-bar-sep" />
        <button className="sh-key" onClick={() => split('row')} type="button">
          SPLIT RIGHT
        </button>
        <button className="sh-key" onClick={() => split('column')} type="button">
          SPLIT DOWN
        </button>
        <button className="sh-key" onClick={close} type="button" disabled={paneIds.length < 2}>
          CLOSE PANE
        </button>
        <span className="sh-bar-spacer" />
        <span className="sh-plate">
          PANES · {paneIds.length}
          <span className="sh-plate-dim"> / M0 · NO SESSIONS</span>
        </span>
      </header>
      <main className="sh-stage">
        <SplitView
          tree={tree}
          onTreeChange={setTree}
          focusedPaneId={focusedId}
          onFocusPane={setFocused}
          home="/Users/you"
        />
      </main>
    </div>
  );
}
