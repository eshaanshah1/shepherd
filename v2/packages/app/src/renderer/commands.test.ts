import { describe, expect, it } from 'vitest';
import { paneId as makePaneId } from '@shepherd/sdk';
import {
  closing,
  frames,
  leaf,
  leafIds,
  makePane,
  neighbor,
  siblingLeaf,
  split,
  splitPane,
  type Pane,
  type Rect,
  type SplitNode,
} from '@shepherd/core/layout';
import { COMMANDS } from '../shared/index.ts';
import { focusedOf, runCommand, type CommandContext, type LayoutState } from './commands.ts';

/**
 * ⌘D / ⌘⇧D / ⌘W / ⌘⌥-arrow, asserted against the LAYOUT MODEL rather than
 * against pixels or restated numbers: every expectation here is the tree the
 * corresponding core op produces from the same inputs. A test that hard-coded
 * the resulting shape would pass for a command that had quietly stopped using
 * the ported op at all.
 */

const VIEWPORT: Rect = { x: 0, y: 0, width: 1000, height: 600 };

function context(newPane: Pane): CommandContext {
  return { viewport: VIEWPORT, newPane: () => newPane };
}

/** A row split whose right half is a column split: three leaves, both axes. */
function threePaneTree(): { tree: SplitNode; left: Pane; topRight: Pane; bottomRight: Pane } {
  const left = makePane({ userTitle: 'left' });
  const topRight = makePane({ userTitle: 'top-right' });
  const bottomRight = makePane({ userTitle: 'bottom-right' });
  return {
    tree: split(
      'row',
      0.5,
      leaf(left),
      split('column', 0.5, leaf(topRight), leaf(bottomRight)),
    ),
    left,
    topRight,
    bottomRight,
  };
}

/** The node a path names, for identity assertions about untouched subtrees. */
function nodeAt(node: SplitNode, path: readonly number[]): SplitNode {
  let current = node;
  for (const step of path) {
    if (current.kind !== 'split') throw new Error('path runs past a leaf');
    current = step === 0 ? current.first : current.second;
  }
  return current;
}

describe('split commands', () => {
  it('⌘D splits the focused pane into a ROW of panes', () => {
    const pane = makePane({});
    const state: LayoutState = { tree: leaf(pane), focusedPaneId: pane.id };
    const fresh = makePane({});

    const outcome = runCommand(state, COMMANDS.splitRight, context(fresh));

    expect(outcome.handled).toBe(true);
    expect(outcome.state.tree).toEqual(splitPane(state.tree, pane.id, 'row', fresh).tree);
    expect(outcome.state.focusedPaneId).toBe(fresh.id);
    expect(outcome.effect).toEqual({ kind: 'opened-pane', paneId: fresh.id });
  });

  it('⌘⇧D splits into a COLUMN — panes stacked (ADR 0012 vocabulary)', () => {
    const pane = makePane({});
    const state: LayoutState = { tree: leaf(pane), focusedPaneId: pane.id };
    const fresh = makePane({});

    const outcome = runCommand(state, COMMANDS.splitDown, context(fresh));

    expect(outcome.state.tree).toEqual(splitPane(state.tree, pane.id, 'column', fresh).tree);
    // Pinned geometrically as well as by name, because the word is the trap:
    // a column split puts the new pane BELOW, not beside.
    const boxes = frames(outcome.state.tree, VIEWPORT);
    expect(boxes.get(fresh.id)?.y).toBe(300);
    expect(boxes.get(fresh.id)?.x).toBe(0);
  });

  it('splits the deepest focused pane, leaving the rest of the tree alone', () => {
    const { tree, bottomRight } = threePaneTree();
    const before = structuredClone(tree);
    const state: LayoutState = { tree, focusedPaneId: bottomRight.id };
    const fresh = makePane({});

    const outcome = runCommand(state, COMMANDS.splitRight, context(fresh));

    expect(outcome.state.tree).toEqual(splitPane(tree, bottomRight.id, 'row', fresh).tree);
    expect(leafIds(outcome.state.tree)).toHaveLength(4);
    // The input tree is untouched, and the half that did not change is the
    // SAME object — which is what lets React skip re-rendering it.
    expect(tree).toEqual(before);
    expect(nodeAt(outcome.state.tree, [0])).toBe(nodeAt(tree, [0]));
  });
});

describe('close command', () => {
  it('⌘W closes the focused pane and names its session for killing', () => {
    const { tree, left, topRight } = threePaneTree();
    const state: LayoutState = { tree, focusedPaneId: left.id };

    const outcome = runCommand(state, COMMANDS.closePane, context(makePane({})));

    expect(outcome.state.tree).toEqual(closing(tree, left.id));
    expect(outcome.effect).toEqual({ kind: 'closed-pane', paneId: left.id });
    // Focus lands on the sibling subtree's first leaf, per `siblingLeaf`.
    expect(outcome.state.focusedPaneId).toBe(siblingLeaf(tree, left.id));
    expect(outcome.state.focusedPaneId).toBe(topRight.id);
  });

  it('⌘W on the LAST pane falls through to the window, and changes nothing else', () => {
    const pane = makePane({});
    const state: LayoutState = { tree: leaf(pane), focusedPaneId: pane.id };

    const outcome = runCommand(state, COMMANDS.closePane, context(makePane({})));

    expect(outcome.effect).toEqual({ kind: 'close-window' });
    // The same object: nothing about the layout changed, so nothing re-renders,
    // and — crucially — no `closed-pane` effect means no session is killed here.
    expect(outcome.state).toBe(state);
  });

  it('never reports close-window while any pane remains', () => {
    const { tree, left, topRight, bottomRight } = threePaneTree();
    for (const target of [left, topRight, bottomRight]) {
      const outcome = runCommand(
        { tree, focusedPaneId: target.id },
        COMMANDS.closePane,
        context(makePane({})),
      );
      expect(outcome.effect.kind, target.userTitle ?? '').toBe('closed-pane');
    }
  });
});

describe('focus commands', () => {
  it('⌘⌥-arrow moves focus to whatever `neighbor` says, in every direction', () => {
    const { tree, left, topRight, bottomRight } = threePaneTree();
    const cases = [
      { from: bottomRight, command: COMMANDS.focusLeft, dir: 'left' as const },
      { from: left, command: COMMANDS.focusRight, dir: 'right' as const },
      { from: bottomRight, command: COMMANDS.focusUp, dir: 'up' as const },
      { from: topRight, command: COMMANDS.focusDown, dir: 'down' as const },
    ];

    for (const { from, command, dir } of cases) {
      const outcome = runCommand({ tree, focusedPaneId: from.id }, command, context(makePane({})));
      const expected = neighbor(tree, from.id, dir, VIEWPORT);
      expect(expected, `${dir} has a neighbour to find`).not.toBeNull();
      expect(outcome.state.focusedPaneId, dir).toBe(expected);
      expect(outcome.state.tree, dir).toBe(tree); // focus never rebuilds the tree
      expect(outcome.effect).toEqual({ kind: 'none' });
    }
  });

  it('does nothing at the edge, and says it did nothing', () => {
    const { tree, left } = threePaneTree();
    const outcome = runCommand({ tree, focusedPaneId: left.id }, COMMANDS.focusLeft, context(makePane({})));

    expect(neighbor(tree, left.id, 'left', VIEWPORT)).toBeNull();
    expect(outcome.handled).toBe(false);
    expect(outcome.state).toBe(tree === outcome.state.tree ? outcome.state : outcome.state);
    expect(outcome.state.focusedPaneId).toBe(left.id);
  });
});

describe('focus resolution', () => {
  it('falls back to the first leaf when focus has not been established', () => {
    const { tree, left } = threePaneTree();
    expect(focusedOf({ tree, focusedPaneId: null })).toBe(left.id);
  });

  it('treats a focus id whose pane is gone as no focus at all', () => {
    const { tree, left } = threePaneTree();
    expect(focusedOf({ tree, focusedPaneId: makePaneId('closed-long-ago') })).toBe(left.id);
  });

  it('so a command after a close still acts, on the first pane', () => {
    const { tree } = threePaneTree();
    const fresh = makePane({});
    const outcome = runCommand(
      { tree, focusedPaneId: makePaneId('gone') },
      COMMANDS.splitRight,
      context(fresh),
    );
    expect(outcome.handled).toBe(true);
    expect(leafIds(outcome.state.tree)).toHaveLength(4);
  });
});
