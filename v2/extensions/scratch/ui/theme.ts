import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * A scratch pane is a DOCUMENT, so it is typeset like one: a comfortable
 * measure rather than the full pane width, generous line height, and the UI
 * text face for prose with monospace kept for code. A pane that filled 2000px
 * with one line of prose would be a terminal wearing a hat.
 *
 * Every colour is a token, so light mode (ADR 0040) needs no second theme here
 * and a palette change reaches this file for free. `theme.test.ts` fails on a
 * literal hex, and on a `var()` naming a token the design system does not
 * publish — that one fails silently at runtime, which is why it is asserted
 * rather than reviewed.
 */
export const scratchTheme: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--sh-surface)',
    color: 'var(--sh-text)',
    height: '100%',
  },
  '&.cm-focused': {
    // The editor fills the pane, and the pane already says which one is focused.
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--sh-font-sans)',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': {
    fontFamily: 'var(--sh-font-sans)',
    /*
     * A step up from `--sh-font-size-body`, which is 13px and is sized for
     * ROWS — a sidebar entry, a tab, a status line. This is prose somebody
     * writes paragraphs in, and 13px prose in a full-width pane reads as a log.
     */
    fontSize: 'var(--sh-font-size-card)',
    /*
     * The pane's width, not a column inside it.
     *
     * This was `68ch` centred, which at 13px is about 470px inside a 1000px
     * pane: two enormous dead margins around a narrow strip, which is what a
     * measure buys you in a book and not what it buys you here. A scratch pane
     * is a place to dump text, so it uses the space it has. The cap is high
     * enough that only a genuinely wide window ever meets it, and exists so a
     * 3000px monitor does not produce lines nobody can track back from.
     */
    maxWidth: '120ch',
    padding: 'var(--sh-space-lg) var(--sh-space-lg) 40vh',
    caretColor: 'var(--sh-text)',
  },
  // 40vh of floor, deliberately: the line you are typing on should be able to
  // reach the middle of the pane rather than sticking to the bottom, which is
  // the one thing every writing app gets right.
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sh-text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--sh-fill-selection)',
  },

  '.sh-scratch-h1': { fontSize: '1.7em', fontWeight: '700', lineHeight: '1.25' },
  '.sh-scratch-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.3' },
  '.sh-scratch-h3': { fontSize: '1.18em', fontWeight: '650' },
  '.sh-scratch-h4': { fontSize: '1.05em', fontWeight: '650' },
  '.sh-scratch-h5': { fontWeight: '650' },
  '.sh-scratch-h6': { fontWeight: '650', color: 'var(--sh-text-dim)' },

  '.sh-scratch-strong': { fontWeight: '700' },
  '.sh-scratch-em': { fontStyle: 'italic' },
  '.sh-scratch-strike': { textDecoration: 'line-through', color: 'var(--sh-text-dim)' },
  '.sh-scratch-code': {
    fontFamily: 'var(--sh-font-mono)',
    fontSize: '0.9em',
    backgroundColor: 'var(--sh-well)',
    borderRadius: 'var(--sh-radius-sm)',
    padding: '0.1em 0.32em',
  },
  '.sh-scratch-link': {
    color: 'var(--sh-sky)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },

  '.sh-scratch-quote': {
    borderLeft: '2px solid var(--sh-line-strong)',
    paddingLeft: 'var(--sh-space-md)',
    color: 'var(--sh-text-dim)',
  },
  '.sh-scratch-fence': {
    fontFamily: 'var(--sh-font-mono)',
    fontSize: '0.9em',
    backgroundColor: 'var(--sh-well)',
  },
  '.sh-scratch-bullet': {
    color: 'var(--sh-text-mute)',
    // The glyph replaces `-`, one character wide, so the text after it does not
    // shift when the line goes raw and back.
    display: 'inline-block',
    width: '1ch',
  },
  '.sh-scratch-rule': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
    borderTop: '1px solid var(--sh-line)',
  },
  '.sh-scratch-check': {
    marginRight: 'var(--sh-space-xs)',
    verticalAlign: 'baseline',
    accentColor: 'var(--sh-sky)',
    cursor: 'pointer',
  },
});
