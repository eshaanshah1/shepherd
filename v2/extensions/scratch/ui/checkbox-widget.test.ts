import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CheckboxWidget, toggleAt } from './checkbox-widget.ts';

function view(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

describe('the checkbox widget', () => {
  it('draws an input that is checked when the marker says so', () => {
    expect((new CheckboxWidget(true, 3).toDOM() as HTMLInputElement).checked).toBe(true);
  });

  it('draws an unchecked input for an empty marker', () => {
    expect((new CheckboxWidget(false, 3).toDOM() as HTMLInputElement).checked).toBe(false);
  });

  it('is equal to another widget with the same state and position', () => {
    // eq drives whether CodeMirror reuses the DOM node. Getting it wrong makes
    // every keystroke rebuild every checkbox on screen.
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(true, 3))).toBe(true);
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(false, 3))).toBe(false);
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(true, 9))).toBe(false);
  });

  it('ignores its own DOM events so CodeMirror does not treat them as edits', () => {
    expect(new CheckboxWidget(true, 3).ignoreEvent()).toBe(true);
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
