import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { cn } from './cn.ts';

/**
 * A prompt field that can hold things that are not text.
 *
 * A `<textarea>` holds a string, so a pasted image can only ever be a token in
 * it — `[Image #1]` as literal characters. This is a `contenteditable`, which
 * can hold an element, so a pasted image renders as the `Pill` it is, inline,
 * exactly where it was pasted.
 *
 * **The entire risk of that swap is editing behaviour a textarea gives free**,
 * and it is worth naming what has to keep working, because the way this goes
 * wrong is subtle and only shows up under a real cursor: ⌘A, ⌥←/→ by word,
 * ⌘←/→ to the line's ends, ⌘⌫, cut/copy/paste, ⌘Z/⌘⇧Z, and shift+any-of-them
 * extending a selection. See
 * docs/superpowers/specs/2026-08-08-composer-editing-requirements.md.
 *
 * Two rules keep them working, and they are both about restraint:
 *
 *   1. **Reimplement none of them.** contenteditable inherits every one from
 *      the OS. They break when a handler calls `preventDefault()` on a key it
 *      did not need, or rewrites the DOM under the caret while you type. So
 *      this component touches the DOM on paste and on mount, and at no other
 *      time — in particular `value` is NOT written back on every keystroke,
 *      which would collapse the selection and destroy the undo stack.
 *   2. **A pill is one character.** `contenteditable="false"` makes the caret
 *      step over it rather than into it, so one backspace takes the whole pill
 *      instead of eating its label a letter at a time.
 *
 * It is deliberately uncontrolled. A controlled contenteditable — rewriting
 * `innerHTML` from state on every change — is the standard way to build this
 * and it is what breaks undo, IME composition and the caret; the field owns its
 * own DOM, and `onChange` reports outward.
 */

/**
 * Where the caret is, and where one character of its line sits on screen.
 *
 * A READ, and only a read — which is what lets it exist beside the restraint
 * rule above. That rule bans rewriting the DOM under the caret while somebody is
 * typing; measuring it is the opposite of that.
 *
 * It reports the caret's own **text node**, deliberately, rather than the whole
 * field's text. A trigger character is a fact about the line you are on, and
 * flattening the field would make an offset that no Range can be built from —
 * the field's children include pills and `<div>` line boxes.
 */
export interface CaretContext {
  /** The caret's text node, in full. */
  readonly text: string;
  /** The caret's offset into `text`. */
  readonly offset: number;
  /** The bounding rect of the single character at `index`, in viewport space. */
  rectOf(index: number): DOMRect | null;
}

export interface PromptFieldHandle {
  /** The text, with each pill rendered as its token. */
  value(): string;
  /** Replace everything. For clearing after a successful submit. */
  setValue(text: string): void;
  /**
   * Insert an element at the caret, as one atomic character.
   *
   * `replaceBack` deletes that many characters immediately before the caret
   * first, which is what turns a typed trigger (`#shep`) into the pill that
   * stands for it. It is a count rather than a range because the caller knows
   * how many characters it asked the user to type and does not know — and must
   * not have to know — how this field represents them.
   *
   * `trailing` is text placed after the node with the caret after IT, so typing
   * continues in a text node rather than immediately against an atomic element.
   * Callers pass a non-breaking space: an ordinary one at the end of a line is
   * collapsed away by the browser, and the caret then lands back against the
   * pill where the next character reads as part of it.
   */
  insert(
    node: HTMLElement,
    options?: { readonly replaceBack?: number; readonly trailing?: string },
  ): void;
  /**
   * Focus the field, put the caret at the very end, and type `text` there.
   *
   * For a control that stands for a gesture — a button that means "start a
   * mention" — so the button performs exactly what a keystroke would, including
   * firing `onChange`. Anything watching the text therefore cannot tell the two
   * apart, which is the point: one code path, whether the `#` was typed or
   * clicked.
   */
  appendText(text: string): void;
  /** Null when the caret is not inside this field, or is not in a text node. */
  caretContext(): CaretContext | null;
  focus(): void;
}

export interface PromptFieldProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onPaste' | 'children'> {
  readonly placeholder?: string;
  /** Fired after any edit, with the current text. Never writes back. */
  readonly onChange?: (value: string) => void;
  /**
   * A paste carrying files (an image from the clipboard). Return true to say
   * it was handled, and the default text paste is suppressed for that event
   * only — a paste of plain text still goes through the browser, which is what
   * keeps it plain and keeps undo intact.
   */
  readonly onPasteFiles?: (files: readonly File[]) => boolean;
}

/**
 * The text of a node, with an element counted as its `data-token`.
 *
 * Reading `textContent` alone would return the pill's LABEL ("Image"), so the
 * brief would say "Image" where it means `[Image #1]` and the path substitution
 * downstream would find nothing to replace.
 */
export function readValue(root: HTMLElement): string {
  let out = '';
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      continue;
    }
    const element = node as HTMLElement;
    const token = element.dataset['token'];
    if (token !== undefined) {
      out += token;
      continue;
    }
    // A `<br>` or a `<div>` is how contenteditable represents a newline; both
    // browsers' shapes are covered by asking for the block's own text.
    if (element.tagName === 'BR') out += '\n';
    else out += `\n${readValue(element)}`;
  }
  return out;
}

export const PromptField = forwardRef<PromptFieldHandle, PromptFieldProps>(function PromptField(
  { placeholder, onChange, onPasteFiles, className, ...rest },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);

  const report = useCallback(() => {
    const node = host.current;
    if (node !== null) onChange?.(readValue(node));
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      value: () => (host.current === null ? '' : readValue(host.current)),
      setValue: (text: string) => {
        if (host.current === null) return;
        host.current.textContent = text;
        report();
      },
      insert: (
        node: HTMLElement,
        options?: { readonly replaceBack?: number; readonly trailing?: string },
      ) => {
        const field = host.current;
        if (field === null) return;
        const trailing =
          options?.trailing === undefined || options.trailing === ''
            ? null
            : document.createTextNode(options.trailing);
        const selection = window.getSelection();
        /*
         * Read the caret BEFORE focusing, and take a CLONE of it.
         *
         * Both halves are measured rather than defensive. `focus()` on a
         * contenteditable that does not already have focus collapses the
         * selection to the element's start — so reading the range afterwards
         * hands back `(field, 0)`, and an insertion aimed at the caret silently
         * lands at the top of the field instead, replacing nothing. And a live
         * range from `getRangeAt` belongs to the selection, so the
         * `removeAllRanges` below would detach the very thing being positioned.
         *
         * Insert at the caret when there is one INSIDE this field, else append: a
         * selection elsewhere on the page would otherwise drop the pill into
         * whatever the user last clicked.
         */
        const range =
          selection !== null && selection.rangeCount > 0 && field.contains(selection.anchorNode)
            ? selection.getRangeAt(0).cloneRange()
            : null;
        field.focus();
        if (range === null) {
          field.append(node);
          if (trailing !== null) field.append(trailing);
        } else {
          /*
           * Widen the range backwards over the characters the caller is
           * replacing, so ONE `deleteContents` removes the trigger text and the
           * selection together. Clamped to the text node's own start: a count
           * longer than the line would otherwise throw an IndexSizeError, and a
           * picker whose query spans a line break is a query that has already
           * closed.
           */
          const back = options?.replaceBack ?? 0;
          if (back > 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
            range.setStart(range.startContainer, Math.max(range.startOffset - back, 0));
          }
          range.deleteContents();
          range.insertNode(node);
          // Put the caret after the pill, so typing continues where you would
          // expect rather than before the thing you just pasted.
          range.setStartAfter(node);
          range.collapse(true);
          if (trailing !== null) {
            range.insertNode(trailing);
            /*
             * INSIDE the trailing text node, not after it. `setStartAfter` would
             * put the caret in the field element beside the node, and
             * `caretContext` reports only a caret that is in a text node — so the
             * next trigger typed right after a pill would find no context at all.
             * Landing in text is the whole reason `trailing` exists.
             */
            range.setStart(trailing, trailing.length);
            range.collapse(true);
          }
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        report();
      },
      appendText: (text: string) => {
        const field = host.current;
        if (field === null || text === '') return;
        field.focus();
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        const typed = document.createTextNode(text);
        range.insertNode(typed);
        // Caret after what was typed, so the next keystroke continues it — a
        // caret left before it would make the button insert text you then type
        // backwards into.
        range.setStart(typed, text.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        report();
      },
      caretContext: () => {
        const field = host.current;
        if (field === null) return null;
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE || !field.contains(node)) return null;
        const text = node.textContent ?? '';
        return {
          text,
          offset: range.startOffset,
          rectOf: (index: number) => {
            if (index < 0 || index >= text.length) return null;
            // A Range over exactly one character. `getBoundingClientRect` on a
            // COLLAPSED range answers a zero-width rect that some engines place
            // at the line's start, which is why this spans the character rather
            // than sitting before it.
            const probe = document.createRange();
            probe.setStart(node, index);
            probe.setEnd(node, index + 1);
            /*
             * A host with no layout has no rect, and says so by not implementing
             * the method at all — jsdom is one. Answering null is what keeps a
             * caller from throwing there, which is the rule `CommandPalette`
             * already records about `scrollIntoView`: a component that dies in a
             * host without layout is a component an extension cannot render in
             * one either, and its tests are the first casualty.
             */
            if (typeof probe.getBoundingClientRect !== 'function') return null;
            return probe.getBoundingClientRect();
          },
        };
      },
      focus: () => host.current?.focus(),
    }),
    [report],
  );

  // The placeholder is CSS (`:empty::before`), and "empty" has to mean empty:
  // a contenteditable that has been typed in and cleared keeps a stray `<br>`,
  // which defeats `:empty` and hides the placeholder forever.
  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    const clean = (): void => {
      if (node.childNodes.length === 1 && (node.firstChild as HTMLElement | null)?.tagName === 'BR') {
        node.replaceChildren();
      }
    };
    node.addEventListener('input', clean);
    return () => node.removeEventListener('input', clean);
  }, []);

  return (
    <div
      {...rest}
      ref={host}
      className={cn('sh-ui-prompt', className)}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      onInput={report}
      onPaste={(event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length > 0 && onPasteFiles?.(files) === true) {
          event.preventDefault();
          return;
        }
        /**
         * Plain text, plainly. A paste from a browser carries HTML, and
         * contenteditable will happily inline its fonts and colours; this takes
         * the text and lets `insertText` do it, which keeps ONE undo entry and
         * leaves the caret where the OS would.
         */
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined || text === '') return;
        event.preventDefault();
        document.execCommand('insertText', false, text);
      }}
    />
  );
});
