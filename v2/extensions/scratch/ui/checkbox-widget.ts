import { EditorView, WidgetType } from '@codemirror/view';

/**
 * The one thing in a scratch pane that is not text.
 *
 * A checkbox has no competing meaning for a click, unlike a link, whose plain
 * click has to stay "place the caret" — so this toggles on an ordinary click
 * with no modifier held.
 */
export class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  /** Where the marker character is, so a click can find it again. */
  readonly pos: number;

  /*
   * Fields and an assigning constructor rather than parameter properties:
   * `erasableSyntaxOnly` is on across this repo, and a parameter property is
   * syntax that has to be COMPILED rather than stripped.
   */
  constructor(checked: boolean, pos: number) {
    super();
    this.checked = checked;
    this.pos = pos;
  }

  /** Drives DOM reuse. Without position in it, every edit rebuilds every box. */
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  override toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'sh-scratch-check';
    /*
     * The widget must not take focus. A focused widget moves the selection, the
     * surrounding line flips to raw, and the line you just ticked jumps under
     * the pointer.
     */
    input.addEventListener('mousedown', (event) => event.preventDefault());
    return input;
  }

  /** CodeMirror must not read events inside this node as document edits. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Flip the marker character at `pos`. Returns false and changes nothing when
 * that position does not hold one.
 */
export function toggleAt(view: EditorView, pos: number): boolean {
  if (pos < 0 || pos >= view.state.doc.length) return false;
  const current = view.state.doc.sliceString(pos, pos + 1);
  if (current !== ' ' && current !== 'x' && current !== 'X') return false;
  view.dispatch({
    changes: { from: pos, to: pos + 1, insert: current === ' ' ? 'x' : ' ' },
    // The selection is deliberately NOT part of this transaction.
    scrollIntoView: false,
  });
  return true;
}
