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
  /**
   * Insert an element at the very END, wherever the caret is.
   *
   * The element analogue of `appendText`, and it exists because neither of the
   * other two could say this: `insert` is CARET-relative, which is right for a
   * typed trigger and wrong for a control outside the field that has no caret to
   * be relative to; `appendText` is end-relative but takes a string.
   *
   * The gap showed up the first time a repo was chosen from a menu in the
   * control row rather than by typing `#`. The field is not focused at that
   * moment, so `insert` had nowhere to put the pill.
   *
   * `trailing` is the same non-breaking space `insert` takes, and for the same
   * reason: the caret lands in text rather than against an atomic element.
   */
  appendNode(node: HTMLElement, options?: { readonly trailing?: string }): void;
  /**
   * Take an element back out, and report the edit.
   *
   * The other half of `appendNode`: a control that can add a pill from outside
   * the field has to be able to remove one, or the only way back is Backspace
   * over a character the user did not type. Removing the node directly and
   * firing `input` by hand would work and is what the composer did first — this
   * exists so that the field, not its caller, owns when a change is announced.
   */
  removeNode(node: HTMLElement): void;
  /**
   * Focus the field and put a collapsed caret at the very end.
   *
   * The thing neither `focus()` nor `appendText('')` could do: `focus()` says
   * nothing about where the caret lands, and `appendText` returns early on an
   * empty string. A control OUTSIDE the field that edits its content needs
   * exactly this afterwards — it has taken focus itself, and handing it back
   * without saying where the caret goes leaves whatever the last selection was.
   */
  caretToEnd(): void;
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
  /**
   * A paste carrying plain text. Return true to say it was handled, and the
   * default insert is skipped for that event only.
   *
   * Offered AFTER `onPasteFiles`, because an image from the clipboard is not a
   * text paste and a field that asked this first would hand it a filename.
   *
   * Claiming a paste costs the browser's own undo entry for it — that is what
   * the note on `onPasteFiles` is about — so a consumer should claim the
   * smallest set of pastes it needs rather than every one it is offered.
   */
  readonly onPasteText?: (text: string) => boolean;
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
  /**
   * `tabIndex` defaults to 0, and it is not decoration.
   *
   * Chromium reports `tabIndex === -1` for a `contenteditable` div — it is
   * focusable, but not in the sequential order the DOM can be asked about. So
   * every walker that looks for "the tabbable things in here" skips this field,
   * including the one Radix's focus trap uses to decide what a modal focuses on
   * open: the composer's brief was passed over and the `#repo` button below it
   * took focus instead. Measured in Electron's Chromium, not assumed.
   */
  { placeholder, onChange, onPasteFiles, onPasteText, className, tabIndex = 0, ...rest },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);

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
      appendNode: (node, options) => {
        const field = host.current;
        if (field === null) return;
        field.focus();
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        range.insertNode(node);
        let after: Node = node;
        const trailing = options?.trailing;
        if (trailing !== undefined && trailing !== '') {
          const text = document.createTextNode(trailing);
          node.after(text);
          after = text;
        }
        /*
         * A FRESH range for the caret, not the one that did the inserting.
         *
         * `Range.insertNode` mutates its range to SURROUND the node it inserted,
         * so reusing it here handed the selection a range spanning the pill —
         * and a pill dropped in from the control row arrived highlighted, as
         * though it had been selected rather than added. The next keystroke
         * would have replaced it.
         *
         * Re-deriving is the fix rather than re-collapsing, because the mutated
         * range's endpoints are not the ones this wants: the caret belongs after
         * the trailing text, and the range knows only about the node.
         */
        const caret = document.createRange();
        caret.setStartAfter(after);
        caret.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(caret);
        report();
      },
      caretToEnd: () => {
        const field = host.current;
        if (field === null) return;
        field.focus();
        const range = document.createRange();
        range.selectNodeContents(field);
        // The END of the contents, and COLLAPSED. `selectNodeContents` alone is a
        // selection of everything, which is the state this exists to leave.
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      },
      removeNode: (node) => {
        if (host.current === null || !host.current.contains(node)) return;
        /*
         * The non-breaking space `appendNode` and `insert` put after a pill goes
         * with it. Leaving it behind accumulates one invisible character per
         * add-and-remove, and they are invisible in the exact place a person is
         * counting characters — the end of the sentence they are writing.
         */
        const next = node.nextSibling;
        if (next !== null && next.nodeType === Node.TEXT_NODE && next.textContent === '\u00A0') {
          next.remove();
        }
        node.remove();
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

  /*
   * Paint the selection ourselves, as one rounded bar per line.
   *
   * A browser's `::selection` cannot take a `border-radius`, and it is drawn per
   * text run rather than per line — so a token in the middle of a selection ends
   * up with its own shaped hole and the band's ends are always square. Both are
   * things this surface has to get right, because a brief is mostly tokens.
   *
   * The mechanism is a read, which is what lets it exist beside the restraint
   * rule at the top of this file: it measures a Range and writes to a layer that
   * is NOT inside the contenteditable, so it never touches the edited DOM, never
   * moves the caret and never pushes anything onto the undo stack. The layer is
   * `aria-hidden` and untouchable — it is paint, not content.
   *
   * One bar per LINE, not per rect. `getClientRects` hands back a rect per run
   * and they overlap: measured on one line, a pill reports the whole line box
   * (h=26) while the text either side reports the font's own box (h=21), and the
   * pill's inner label reports a third rect inside the second. Taking the union
   * per line and drawing it at the line's own height is what turns that into the
   * single continuous band a reader sees — and it is why a pill needs no selected
   * state of its own any more: the band is already behind it.
   */
  useEffect(() => {
    const node = host.current;
    const layer = band.current;
    if (node === null || layer === null) return;

    const paint = (): void => {
      const selection = window.getSelection();
      const live =
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        node.contains(selection.anchorNode);
      if (!live) {
        layer.replaceChildren();
        return;
      }
      const range = selection.getRangeAt(0);
      // A host with no layout answers no rects — jsdom is one — and a field that
      // threw there would take every renderer test with it (`rectOf`'s rule).
      if (typeof range.getClientRects !== 'function') return;
      const box = node.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

      /**
       * The bar is the TEXT's own box, not the line box.
       *
       * That is what keeps the leading readable: a band as tall as the line box
       * leaves no gap between one selected line and the next, so a paragraph
       * reads as a solid slab and the line-height looks half what it is. It is
       * also the height the browser's own `::selection` uses everywhere else in
       * the app, so a selection here is the same shape as a selection anywhere —
       * this only rounds it and makes it continuous.
       *
       * MEASURED off a text node rather than taken from the rects, and that is
       * the point of the walk. The rects are not one shape: on a single line a
       * text run reports the font's box, a `Pill` reports its own box, and the
       * pill's label reports a third inside that. Taking the smallest of them
       * made the band's height depend on WHAT was selected — a run with a token
       * in it came out shorter than one without, which is a band that changes
       * size as you drag.
       *
       * Text inside a token is skipped for the same reason: a pill sets its own
       * `line-height`, so its label answers the chip's box and not the line's.
       */
      const textBox = (): number | null => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
          if ((text.textContent ?? '').length === 0) continue;
          if (text.parentElement?.closest('.sh-ui-pill') != null) continue;
          const probe = document.createRange();
          probe.setStart(text, 0);
          probe.setEnd(text, 1);
          const height = probe.getBoundingClientRect().height;
          if (height > 0) return height;
        }
        return null;
      };

      /** min-left and max-right per line, keyed by which line the rect is on. */
      const lines = new Map<number, { left: number; right: number }>();
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        const top = rect.top - box.top;
        const index = Math.round(top / lineHeight);
        const left = rect.left - box.left;
        const right = left + rect.width;
        const seen = lines.get(index);
        if (seen === undefined) lines.set(index, { left, right });
        else {
          seen.left = Math.min(seen.left, left);
          seen.right = Math.max(seen.right, right);
        }
      }

      // A field holding nothing but tokens — or a host with no layout — falls
      // back to the line box rather than drawing a bar nobody can see.
      const barHeight = textBox() ?? lineHeight;
      const barOffset = (lineHeight - barHeight) / 2;

      layer.replaceChildren(
        ...[...lines.entries()].map(([index, span]) => {
          const bar = document.createElement('i');
          bar.className = 'sh-ui-prompt-band__bar';
          bar.style.transform = `translate(${span.left}px, ${index * lineHeight + barOffset}px)`;
          bar.style.inlineSize = `${span.right - span.left}px`;
          bar.style.blockSize = `${barHeight}px`;
          return bar;
        }),
      );
    };

    document.addEventListener('selectionchange', paint);
    // The rects are viewport-relative and the field scrolls, so a scroll moves
    // every bar. Resize changes where the lines wrap, and an edit changes what
    // is selected under the caret.
    node.addEventListener('scroll', paint);
    node.addEventListener('input', paint);
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null;
    observer?.observe(node);
    return () => {
      document.removeEventListener('selectionchange', paint);
      node.removeEventListener('scroll', paint);
      node.removeEventListener('input', paint);
      observer?.disconnect();
    };
  }, []);

  return (
    /*
     * The wrapper exists only so the band has a positioned box to live in that is
     * NOT the contenteditable. Everything the caller styles — the class, the
     * metrics, the placeholder — stays on the editable element, so a consumer's
     * `.sh-composer-brief` still lands where it always did.
     */
    <div className="sh-ui-prompt-host">
      <div className="sh-ui-prompt-band" ref={band} aria-hidden="true" />
      <div
      {...rest}
      ref={host}
      className={cn('sh-ui-prompt', className)}
      tabIndex={tabIndex}
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
        // Claimed: the consumer has inserted whatever it wanted in place of this
        // text, so the default insert would put the text there as well.
        if (onPasteText?.(text) === true) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        document.execCommand('insertText', false, text);
      }}
      />
    </div>
  );
});
