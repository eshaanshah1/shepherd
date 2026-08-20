import { EditorView, WidgetType } from '@codemirror/view';
import { checkboxDOM } from '@shepherd/ui';

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
  /** What this box is FOR — the task's own words, as its accessible name. */
  readonly label: string;

  /*
   * Fields and an assigning constructor rather than parameter properties:
   * `erasableSyntaxOnly` is on across this repo, and a parameter property is
   * syntax that has to be COMPILED rather than stripped.
   */
  constructor(checked: boolean, pos: number, label: string) {
    super();
    this.checked = checked;
    this.pos = pos;
    this.label = label;
  }

  /** Drives DOM reuse. Without position in it, every edit rebuilds every box. */
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos && other.label === this.label;
  }

  override toDOM(): HTMLElement {
    /*
     * The design system's control, not a browser-drawn one.
     *
     * `<input type="checkbox">` renders a box no token can reach: its fill, its
     * radius and its check are the platform's, so it was the one thing in this
     * pane that did not follow the palette and did not follow the theme.
     * `checkboxDOM` is the primitive built as DOM rather than React, which is
     * what a CodeMirror widget can mount — widgets are created and destroyed on
     * scroll, so a React root per checkbox is not a thing to do.
     */
    const box = checkboxDOM({ checked: this.checked, label: this.label, className: 'sh-scratch-check' });
    /*
     * Out of the tab order. The DOCUMENT is the tab stop here; a task list of
     * twenty would otherwise put twenty stops between the text and whatever is
     * after the pane.
     */
    box.tabIndex = -1;
    // Inside a contenteditable, or the browser treats the control as content.
    box.setAttribute('contenteditable', 'false');
    /*
     * The widget must not take focus. A focused widget moves the selection, the
     * surrounding line flips to raw, and the line you just ticked jumps under
     * the pointer.
     */
    box.addEventListener('mousedown', (event) => event.preventDefault());
    return box;
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
