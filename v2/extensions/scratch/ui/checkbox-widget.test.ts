import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CheckboxWidget, toggleAt } from './checkbox-widget.ts';

function view(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

describe('the checkbox widget', () => {
  it('draws the design system control, not a browser-drawn input', () => {
    // An <input type="checkbox"> renders a box no token can reach — its fill,
    // radius and check are the platform's, so it was the one thing in the pane
    // that followed neither the palette nor the theme.
    const el = new CheckboxWidget(true, 3, 'ship it').toDOM();
    expect(el.tagName).toBe('BUTTON');
    expect(el.classList.contains('sh-ui-checkbox')).toBe(true);
  });

  it('says it is checked where a screen reader can read it', () => {
    expect(new CheckboxWidget(true, 3, 'ship it').toDOM().getAttribute('aria-checked')).toBe('true');
    expect(new CheckboxWidget(false, 3, 'ship it').toDOM().getAttribute('aria-checked')).toBe('false');
  });

  it('is named for the task, not for itself', () => {
    const el = new CheckboxWidget(false, 3, 'ship it').toDOM();
    expect(el.getAttribute('aria-label')).toBe('ship it');
    expect(el.getAttribute('title')).toBe('ship it');
  });

  it('stays out of the tab order — the document is the tab stop', () => {
    // A task list of twenty would otherwise put twenty stops between the text
    // and whatever comes after the pane.
    expect((new CheckboxWidget(false, 3, 'x').toDOM() as HTMLButtonElement).tabIndex).toBe(-1);
  });

  it('is not editable content, inside a contenteditable', () => {
    expect(new CheckboxWidget(false, 3, 'x').toDOM().getAttribute('contenteditable')).toBe('false');
  });

  it('is equal to another widget with the same state and position', () => {
    // eq drives whether CodeMirror reuses the DOM node. Getting it wrong makes
    // every keystroke rebuild every checkbox on screen.
    expect(new CheckboxWidget(true, 3, 'a').eq(new CheckboxWidget(true, 3, 'a'))).toBe(true);
    expect(new CheckboxWidget(true, 3, 'a').eq(new CheckboxWidget(false, 3, 'a'))).toBe(false);
    expect(new CheckboxWidget(true, 3, 'a').eq(new CheckboxWidget(true, 9, 'a'))).toBe(false);
    // The label is part of it too: a task whose words changed is a box whose
    // accessible name changed, and reusing the node would keep the old one.
    expect(new CheckboxWidget(true, 3, 'a').eq(new CheckboxWidget(true, 3, 'b'))).toBe(false);
  });

  it('ignores its own DOM events so CodeMirror does not treat them as edits', () => {
    expect(new CheckboxWidget(true, 3, 'x').ignoreEvent()).toBe(true);
  });

  it('toggles an unchecked marker to x', () => {
    const v = view('- [ ] ship it');
    expect(toggleAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] ship it');
  });

  it('toggles a checked marker back to a space', () => {
    const v = view('- [x] ship it');
    expect(toggleAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] ship it');
  });

  it('accepts a capital X, which is legal markdown', () => {
    const v = view('- [X] ship it');
    expect(toggleAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] ship it');
  });

  it('refuses a position that is not a marker, and changes nothing', () => {
    const v = view('- [ ] ship it');
    expect(toggleAt(v, 7)).toBe(false);
    expect(v.state.doc.toString()).toBe('- [ ] ship it');
  });

  it('refuses a position past the end of the document', () => {
    const v = view('- [ ] x');
    expect(toggleAt(v, 999)).toBe(false);
  });

  it('leaves the selection where it was', () => {
    // Clicking a checkbox must not move the caret: moving it flips the
    // surrounding line to raw, so the line you just ticked would jump.
    const v = view('- [ ] one\n- [ ] two');
    v.dispatch({ selection: { anchor: 15 } });
    toggleAt(v, 3);
    expect(v.state.selection.main.anchor).toBe(15);
  });
});
