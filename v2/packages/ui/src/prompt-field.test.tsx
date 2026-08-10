// @vitest-environment jsdom
import { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PromptField, readValue, type PromptFieldHandle } from './prompt-field.tsx';

/**
 * `readValue` and the three handle methods that touch a Range.
 *
 * What is still NOT tested here is the point of the omission: jsdom implements
 * neither caret movement nor `execCommand`, so a test of ⌘A, ⌥←, cut/paste or
 * undo would be asserting the harness rather than the field. Those live in
 * docs/superpowers/specs/2026-08-08-composer-editing-requirements.md as a
 * by-hand checklist, which is honest about how they are verified.
 *
 * The Range work below IS testable, because jsdom implements Ranges and
 * Selections properly — it only lacks LAYOUT. That distinction is what the
 * `rectOf` case at the bottom is about.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('readValue', () => {
  const field = (html: string): HTMLElement => {
    const node = document.createElement('div');
    node.innerHTML = html;
    return node;
  };

  it('reads a pill as its TOKEN, never its label', () => {
    // The label says "Image 1" and the agent must be told "[Image #1]" — the
    // token is what a path is substituted for downstream.
    const node = field('look at <span data-token="[Image #1]">Image 1</span> please');
    expect(readValue(node)).toBe('look at [Image #1] please');
  });

  it('reads a <br> as a newline, which is how contenteditable spells one', () => {
    expect(readValue(field('one<br>two'))).toBe('one\ntwo');
  });

  it('reads a block as a newline plus its text — the other browser spelling', () => {
    expect(readValue(field('one<div>two</div>'))).toBe('one\ntwo');
  });

  it('reads plain text unchanged, which is the ordinary case', () => {
    expect(readValue(field('just a brief'))).toBe('just a brief');
  });
});

describe('the handle', () => {
  const mount = (): {
    handle: PromptFieldHandle;
    node: HTMLElement;
    changes: string[];
    cleanup: () => void;
  } => {
    const ref = createRef<PromptFieldHandle>();
    const changes: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<PromptField ref={ref} onChange={(value) => changes.push(value)} />));
    return {
      handle: ref.current!,
      node: container.querySelector<HTMLElement>('[role="textbox"]')!,
      changes,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  /** Put the caret at `offset` in the field's trailing text node. */
  const caretAt = (node: HTMLElement, offset: number): void => {
    const text = node.lastChild!;
    const range = document.createRange();
    range.setStart(text, offset);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const pill = (token: string): HTMLElement => {
    const element = document.createElement('span');
    element.dataset['token'] = token;
    element.append(token);
    return element;
  };

  it('inserts at the caret, not at the end', () => {
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('one two'));
    caretAt(node, 4);
    act(() => handle.insert(pill('[P]')));
    expect(readValue(node)).toBe('one [P]two');
    cleanup();
  });

  it('deletes `replaceBack` characters before inserting', () => {
    // The whole point of it: a typed trigger becomes the pill that stands for it,
    // rather than the pill appearing next to the text it was meant to replace.
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('fix it in #she'));
    caretAt(node, 14);
    act(() => handle.insert(pill('#shepherd'), { replaceBack: 4 }));
    expect(readValue(node)).toBe('fix it in #shepherd');
    cleanup();
  });

  it('clamps `replaceBack` to the start of the line rather than throwing', () => {
    // An over-long count would otherwise be an IndexSizeError, which in a
    // contenteditable means the editor stops taking input with no visible cause.
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('#she'));
    caretAt(node, 4);
    act(() => handle.insert(pill('#shepherd'), { replaceBack: 99 }));
    expect(readValue(node)).toBe('#shepherd');
    cleanup();
  });

  it('survives being focused first, which collapses the caret in some hosts', () => {
    /*
     * MEASURED, and it was a real defect: `focus()` on a contenteditable that
     * does not already have focus collapses the selection to the element's start.
     * Reading the caret after focusing therefore yielded `(field, 0)`, and every
     * insertion landed at the top of the field having replaced nothing. The field
     * is deliberately left unfocused here so the insert path has to focus it.
     */
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('fix it in #she'));
    caretAt(node, 14);
    expect(document.activeElement).not.toBe(node);
    act(() => handle.insert(pill('#shepherd'), { replaceBack: 4 }));
    expect(readValue(node)).toBe('fix it in #shepherd');
    cleanup();
  });

  it('leaves the caret after the trailing text, so typing continues there', () => {
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('in #s'));
    caretAt(node, 5);
    act(() => handle.insert(pill('#shepherd'), { replaceBack: 2, trailing: '!' }));
    expect(readValue(node)).toBe('in #shepherd!');

    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);
    expect(range.startContainer.textContent).toBe('!');
    expect(range.startOffset).toBe(1);
    cleanup();
  });

  it('appends when the caret is outside the field, rather than dropping the node elsewhere', () => {
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('one'));
    const outside = document.createElement('div');
    outside.append(document.createTextNode('somewhere else'));
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild!, 3);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    act(() => handle.insert(pill('[P]'), { trailing: '!' }));

    expect(readValue(node)).toBe('one[P]!');
    expect(outside.textContent).toBe('somewhere else');
    outside.remove();
    cleanup();
  });

  it('reports the caret and its own text node', () => {
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('in #she'));
    caretAt(node, 7);
    expect(handle.caretContext()).toMatchObject({ text: 'in #she', offset: 7 });
    cleanup();
  });

  it('answers null for a caret outside the field', () => {
    // A picker driven by another element's caret would read a query nobody typed.
    const { handle, cleanup } = mount();
    const outside = document.createElement('div');
    outside.append(document.createTextNode('elsewhere'));
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(handle.caretContext()).toBeNull();
    outside.remove();
    cleanup();
  });

  it('answers null from `rectOf` in a host with no layout, rather than throwing', () => {
    /*
     * jsdom does not implement `Range.getBoundingClientRect` AT ALL, and this
     * guard is what keeps a caller alive there. It shipped without one and took
     * every test of the picker down with a TypeError — the same class of defect
     * `CommandPalette` records about `scrollIntoView`: a component that dies in a
     * host without layout is one an extension cannot render in one either.
     */
    const { handle, node, cleanup } = mount();
    node.append(document.createTextNode('in #she'));
    caretAt(node, 7);
    expect(handle.caretContext()!.rectOf(3)).toBeNull();
    // Out of range is null too, and by a different door — no Range is built.
    expect(handle.caretContext()!.rectOf(99)).toBeNull();
    cleanup();
  });

  it('appends text at the end and reports it, so a button can stand for a keystroke', () => {
    const { handle, node, changes, cleanup } = mount();
    node.append(document.createTextNode('ship it'));
    act(() => handle.appendText('#'));
    expect(readValue(node)).toBe('ship it#');
    // Fires `onChange`, so nothing watching the text can tell a click from a
    // keypress — which is what makes it ONE code path.
    expect(changes.at(-1)).toBe('ship it#');
    // And the caret is after it, so the next character continues the mention.
    const range = window.getSelection()!.getRangeAt(0);
    expect(range.startOffset).toBe(1);
    expect(range.startContainer.textContent).toBe('#');
    cleanup();
  });
});
