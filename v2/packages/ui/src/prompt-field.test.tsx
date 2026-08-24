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

  it('is a tabbable candidate, or a focus trap cannot find it', () => {
    /*
     * A `contenteditable` div reports `tabIndex === -1` in Chromium, so every
     * walker that asks the DOM what is tabbable in a container skips it —
     * including the one Radix's focus trap uses to pick what a modal focuses on
     * open. That is how the ⌘T composer opened with its `#repo` button focused
     * and the brief, the only field on the card, not.
     */
    const { node, cleanup } = mount();
    expect(node.tabIndex).toBe(0);
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

  /**
   * The selection the field paints for itself.
   *
   * jsdom implements Ranges and Selections properly and only lacks LAYOUT, so
   * what is testable here is the decision — that the layer is emptied when there
   * is nothing selected, that a selection elsewhere on the page is ignored, and
   * that the listener is released. The GEOMETRY (one bar per line, at the line's
   * own height) needs real rects and was measured in a browser instead; jsdom
   * answers zero-size rects for everything, so asserting positions here would
   * assert the harness.
   */
  const layerOf = (node: HTMLElement): HTMLElement => {
    const found = node.parentElement?.querySelector<HTMLElement>('.sh-ui-prompt-band');
    if (!found) throw new Error('no band layer');
    return found;
  };

  const selectAll = (node: HTMLElement): void => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };

  it('gives the band its own layer, outside the contenteditable', () => {
    // The rule at the top of this file bans rewriting the DOM under the caret.
    // Paint that lived INSIDE the editable would be content: it would land in
    // `readValue`, in the undo stack, and under the user's arrow keys.
    const { node, cleanup } = mount();
    const layer = layerOf(node);
    expect(node.contains(layer)).toBe(false);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    cleanup();
  });

  it('clears the band when the selection collapses', () => {
    const { node, cleanup } = mount();
    node.append(document.createTextNode('in a test'));
    selectAll(node);
    caretAt(node, 0);
    document.dispatchEvent(new Event('selectionchange'));
    expect(layerOf(node).childElementCount).toBe(0);
    cleanup();
  });

  it('ignores a selection that is not in this field', () => {
    // `selectionchange` fires on `document`, so every field in the app hears
    // every selection anywhere. One `contains` call is what that costs.
    const { node, cleanup } = mount();
    node.append(document.createTextNode('in a test'));
    const elsewhere = document.createElement('p');
    elsewhere.append('some other text');
    document.body.append(elsewhere);
    selectAll(elsewhere);
    expect(layerOf(node).childElementCount).toBe(0);
    elsewhere.remove();
    cleanup();
  });

  it('stops listening once unmounted, so a closed composer leaks no handler', () => {
    const { node, cleanup } = mount();
    node.append(document.createTextNode('in a test'));
    cleanup();
    expect(() => document.dispatchEvent(new Event('selectionchange'))).not.toThrow();
  });
});

/**
 * The two paste hooks, and which of them a given paste belongs to.
 *
 * jsdom has no `execCommand`, so the INSERT half is unassertable here (see the
 * note at the top of this file). What is assertable is the branch: whether the
 * default insert was reached at all. So `execCommand` is stubbed and its being
 * called is the claim — which is the field's own decision rather than the
 * harness's behaviour.
 */
describe('pasting', () => {
  const mount = (
    props: {
      onPasteText?: (text: string) => boolean;
      onPasteFiles?: (files: readonly File[]) => boolean;
    } = {},
  ): { node: HTMLElement; inserted: string[]; cleanup: () => void } => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<PromptField {...props} />));
    const inserted: string[] = [];
    const owner = document as unknown as { execCommand?: unknown };
    const had = 'execCommand' in owner;
    const previous = owner.execCommand;
    owner.execCommand = (_name: string, _ui: boolean, value: string) => {
      inserted.push(value);
      return true;
    };
    return {
      node: container.querySelector<HTMLElement>('[role="textbox"]')!,
      inserted,
      cleanup: () => {
        if (had) owner.execCommand = previous;
        else delete owner.execCommand;
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  /**
   * A paste, built by hand: jsdom's `ClipboardEvent` carries no `clipboardData`,
   * so the one thing the handler reads has to be attached to the event.
   */
  const paste = (node: HTMLElement, data: { text?: string; files?: readonly File[] }): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: data.files ?? [],
        getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : ''),
      },
    });
    act(() => void node.dispatchEvent(event));
    return event;
  };

  it('hands the plain text over and skips the default insert when it is claimed', () => {
    const seen: string[] = [];
    const dom = mount({
      onPasteText: (text) => {
        seen.push(text);
        return true;
      },
    });
    const event = paste(dom.node, { text: 'https://x.atlassian.net/browse/A-1' });
    expect(seen).toEqual(['https://x.atlassian.net/browse/A-1']);
    expect(dom.inserted).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    dom.cleanup();
  });

  it('falls through to the ordinary insert when the hook declines', () => {
    const dom = mount({ onPasteText: () => false });
    paste(dom.node, { text: 'plain words' });
    expect(dom.inserted).toEqual(['plain words']);
    dom.cleanup();
  });

  it('inserts plainly when there is no hook at all', () => {
    const dom = mount();
    paste(dom.node, { text: 'plain words' });
    expect(dom.inserted).toEqual(['plain words']);
    dom.cleanup();
  });

  /**
   * Files win. An image from the clipboard is not a text paste, and a field that
   * asked the text hook first would hand it a filename.
   */
  it('offers a paste carrying files to onPasteFiles, and never to onPasteText', () => {
    const order: string[] = [];
    const dom = mount({
      onPasteFiles: () => {
        order.push('files');
        return true;
      },
      onPasteText: () => {
        order.push('text');
        return true;
      },
    });
    paste(dom.node, { text: 'ignored', files: [new File(['x'], 'a.png', { type: 'image/png' })] });
    expect(order).toEqual(['files']);
    dom.cleanup();
  });

  it('reaches the text hook when the file hook declines the files it was given', () => {
    const order: string[] = [];
    const dom = mount({
      onPasteFiles: () => {
        order.push('files');
        return false;
      },
      onPasteText: () => {
        order.push('text');
        return true;
      },
    });
    paste(dom.node, { text: 'a.png', files: [new File(['x'], 'a.png', { type: 'image/png' })] });
    expect(order).toEqual(['files', 'text']);
    dom.cleanup();
  });
});
