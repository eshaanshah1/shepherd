import type { PaneID } from '@shepherd/sdk';
import {
  closing,
  containsPane,
  firstLeafId,
  neighbor,
  siblingLeaf,
  splitPane,
  type FocusDirection,
  type Pane,
  type Rect,
  type SplitAxis,
  type SplitNode,
} from '@shepherd/core/layout';
import { COMMANDS, type CommandID } from '../shared/index.ts';

/**
 * What ⌘D / ⌘⇧D / ⌘W / ⌘⌥-arrow actually mean, as a pure function.
 *
 * The menu item lives in main and the terminal lives in a DOM node, so if the
 * meaning of a key lived in a click handler it could only be checked by pressing
 * it. Here it is `(state, command) -> (state, effect)`: the tests assert the new
 * tree against the layout ops themselves, not against pixels, and the terminal
 * smoke drives the SAME function by clicking the real `MenuItem`.
 *
 * `effect` is the part a pure function cannot do: killing a session, closing a
 * window. Returning it rather than performing it is what keeps the split
 * between "what the command means" and "what the shell does about it" honest —
 * and `closed-pane` carrying the id is what makes ⌘W the one gesture in the app
 * that is allowed to end a session.
 */

export interface LayoutState {
  readonly tree: SplitNode;
  readonly focusedPaneId: PaneID | null;
}

export type CommandEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'opened-pane'; readonly paneId: PaneID }
  | { readonly kind: 'closed-pane'; readonly paneId: PaneID }
  | { readonly kind: 'close-window' };

export interface CommandOutcome {
  readonly state: LayoutState;
  readonly effect: CommandEffect;
  /** False when the command found nothing to do — the state is the same object. */
  readonly handled: boolean;
}

export interface CommandContext {
  /** The pane area, for `neighbor`'s geometry. Measured from the DOM at dispatch. */
  readonly viewport: Rect;
  readonly newPane: () => Pane;
}

const SPLIT_AXIS: Partial<Record<CommandID, SplitAxis>> = {
  // ADR 0012's vocabulary: ⌘D is a ROW of panes (side by side), ⌘⇧D a column
  // (stacked). Read off @shepherd/core/layout, never from the word.
  [COMMANDS.splitRight]: 'row',
  [COMMANDS.splitDown]: 'column',
};

const FOCUS_DIRECTION: Partial<Record<CommandID, FocusDirection>> = {
  [COMMANDS.focusLeft]: 'left',
  [COMMANDS.focusRight]: 'right',
  [COMMANDS.focusUp]: 'up',
  [COMMANDS.focusDown]: 'down',
};

export function runCommand(
  state: LayoutState,
  command: CommandID,
  context: CommandContext,
): CommandOutcome {
  const target = focusedOf(state);
  if (target === null) return unchanged(state);

  const axis = SPLIT_AXIS[command];
  if (axis !== undefined) {
    const pane = context.newPane();
    const edit = splitPane(state.tree, target, axis, pane);
    if (!edit.ok) return unchanged(state);
    return {
      state: { tree: edit.tree, focusedPaneId: pane.id },
      effect: { kind: 'opened-pane', paneId: pane.id },
      handled: true,
    };
  }

  const direction = FOCUS_DIRECTION[command];
  if (direction !== undefined) {
    const next = neighbor(state.tree, target, direction, context.viewport);
    if (next === null) return unchanged(state);
    return {
      state: { tree: state.tree, focusedPaneId: next },
      effect: { kind: 'none' },
      handled: true,
    };
  }

  if (command === COMMANDS.closePane) {
    const next = closing(state.tree, target);
    // `null` = that was the last pane. ⌘W falls through to the window, and only
    // here: closing the window on any other pane would be the classic Electron
    // bug where a split tab vanishes because one pane was closed.
    if (next === null) return { state, effect: { kind: 'close-window' }, handled: true };
    const heir = siblingLeaf(state.tree, target) ?? firstLeafId(next);
    return {
      state: { tree: next, focusedPaneId: heir },
      effect: { kind: 'closed-pane', paneId: target },
      handled: true,
    };
  }

  return unchanged(state);
}

/**
 * The pane a command acts on: the focused one, else the first leaf. A tree
 * always has a leaf, so a command is never silently dropped just because focus
 * has not been established yet (the first render, or a restored layout).
 */
export function focusedOf(state: LayoutState): PaneID | null {
  const focused = state.focusedPaneId;
  // A stale id (its pane was closed) resolves like no id at all — otherwise
  // every command after a close is a silent no-op against a pane that is gone.
  if (focused !== null && containsPane(state.tree, focused)) return focused;
  return firstLeafId(state.tree);
}

function unchanged(state: LayoutState): CommandOutcome {
  return { state, effect: { kind: 'none' }, handled: false };
}
