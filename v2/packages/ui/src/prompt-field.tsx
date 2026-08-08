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

export interface PromptFieldHandle {
  /** The text, with each pill rendered as its token. */
  value(): string;
  /** Replace everything. For clearing after a successful submit. */
  setValue(text: string): void;
  /** Insert an element at the caret, as one atomic character. */
  insert(node: HTMLElement): void;
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
      insert: (node: HTMLElement) => {
        const field = host.current;
        if (field === null) return;
        field.focus();
        const selection = window.getSelection();
        // Insert at the caret when there is one INSIDE this field, else append.
        // A selection elsewhere on the page would otherwise drop the pill into
        // whatever the user last clicked.
        const range =
          selection !== null && selection.rangeCount > 0 && field.contains(selection.anchorNode)
            ? selection.getRangeAt(0)
            : null;
        if (range === null) {
          field.append(node);
        } else {
          range.deleteContents();
          range.insertNode(node);
          // Put the caret after the pill, so typing continues where you would
          // expect rather than before the thing you just pasted.
          range.setStartAfter(node);
          range.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        report();
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
