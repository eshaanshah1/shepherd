import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { FENCE_SEARCH_LIMIT } from '../src/skill.ts';

/**
 * The YAML frontmatter, drawn as a quiet field block.
 *
 * Its own extension rather than a case in `live-preview.ts`, and the reason is
 * structural: frontmatter is not markdown. Lezer sees the opening `---` as a
 * thematic break and each `key: value` as a paragraph, so there is no node to
 * hang a decoration off — the block is found by POSITION (the first thing in the
 * document) rather than by the syntax tree, which is the one construct in this
 * editor that is true of.
 *
 * It obeys the same rule as everything else here, though, and the rule is
 * `live-preview.ts`'s: **a block construct renders raw when the selection touches
 * its line.** Per line and not per block — a caret in the description must not
 * unstyle the name three rows up.
 */

/** The fences, and the whole block, only when the document OPENS with one. */
export interface FrontmatterSpan {
  /** Document offset of the opening `---` line's start. */
  readonly open: number;
  /** Document offset of the closing `---` line's start. */
  readonly close: number;
}

/**
 * The block, if the document has one.
 *
 * Leading blank lines are skipped because people leave them, and a document that
 * opens with one has still been given frontmatter. An unterminated fence answers
 * `undefined`: that is somebody part-way through typing, and styling it would
 * make the rest of the document flicker into a field block as they went.
 */
export function frontmatterSpan(state: EditorState): FrontmatterSpan | undefined {
  const total = state.doc.lines;
  let number = 1;
  while (number <= total && state.doc.line(number).text.trim() === '') number += 1;
  if (number > total || state.doc.line(number).text.trim() !== '---') return undefined;

  const open = state.doc.line(number);
  /*
   * BOUNDED, and this is the hot one: this runs on every keystroke and every caret
   * move. A document that opens with `---` and has not closed it yet would
   * otherwise walk every line of a long scratch pad on each of them.
   */
  const limit = Math.min(total, number + FENCE_SEARCH_LIMIT);
  for (let next = number + 1; next <= limit; next += 1) {
    const line = state.doc.line(next);
    if (line.text.trim() === '---') return { open: open.from, close: line.from };
  }
  return undefined;
}

/** A top-level `key: value`, with the colon and the run of spaces after it. */
const PAIR = /^([A-Za-z0-9_.-]+)(:\s*)/;

/**
 * The one key whose value is an IDENTIFIER rather than prose.
 *
 * It becomes a directory name, so it is set in mono — the same division
 * `styles.css` makes everywhere: sans for what the app says, mono for what the
 * machine will read back.
 */
const MONO_KEYS = new Set(['name']);

/** Does any selection range touch this line? */
function touchesLine(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

export function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const span = frontmatterSpan(state);
  if (span === undefined) return Decoration.none;

  const found: Range<Decoration>[] = [];
  const openLine = state.doc.lineAt(span.open);
  const closeLine = state.doc.lineAt(span.close);

  /*
   * The fences COLLAPSE rather than being replaced.
   *
   * A `Decoration.replace` over a line's characters leaves the line itself, so
   * `---` would become a blank row and the block would gain two of them. A line
   * class the stylesheet hides removes the row, and the caret arriving on it
   * drops the class and brings it back — which is the same reveal every other
   * construct here does, just applied to the whole line.
   */
  for (const fence of [openLine, closeLine]) {
    if (touchesLine(state, fence.from, fence.to)) continue;
    found.push(Decoration.line({ class: 'sh-scratch-fm-fence' }).range(fence.from));
  }

  for (let number = openLine.number + 1; number < closeLine.number; number += 1) {
    const line = state.doc.line(number);
    const raw = touchesLine(state, line.from, line.to);

    /*
     * The ROW's class goes on whichever way, and `live-preview.ts` says why in as
     * many words: the rule exists so characters under the caret do not move, and
     * a colour is not a character. What waits for the caret to leave is the colon,
     * whose disappearance genuinely does shift the value sideways.
     */
    found.push(Decoration.line({ class: 'sh-scratch-fm-row' }).range(line.from));

    // The last row closes the block with a hairline, so the field block has an
    // edge without a box around it.
    if (number === closeLine.number - 1) {
      found.push(Decoration.line({ class: 'sh-scratch-fm-last' }).range(line.from));
    }

    const pair = PAIR.exec(line.text);
    // A continuation line of a folded block, or a `- item`. It belongs to the row
    // above and takes the block's type without a key of its own.
    if (pair === null) {
      found.push(Decoration.line({ class: 'sh-scratch-fm-cont' }).range(line.from));
      continue;
    }

    const key = pair[1] ?? '';
    const keyEnd = line.from + key.length;
    const valueStart = line.from + (pair[0]?.length ?? 0);

    found.push(Decoration.mark({ class: 'sh-scratch-fm-key' }).range(line.from, keyEnd));
    if (!raw) found.push(Decoration.replace({}).range(keyEnd, valueStart));
    if (valueStart < line.to) {
      found.push(
        Decoration.mark({
          class: MONO_KEYS.has(key) ? 'sh-scratch-fm-value sh-scratch-fm-id' : 'sh-scratch-fm-value',
        }).range(valueStart, line.to),
      );
    }
  }

  return Decoration.set(found, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildFrontmatterDecorations(view.state);
    }

    update(update: ViewUpdate): void {
      // Not `viewportChanged`: the block is always at the top of the document, so
      // there is nothing off-screen for a scroll to bring into range.
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildFrontmatterDecorations(update.state);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    /*
     * The hidden colon must be ATOMIC, or an arrow key steps into a zero-width
     * replaced range and the caret appears stuck — `live-preview.ts` hit the same
     * thing and records the same fix.
     */
    provide: (plug) => EditorView.atomicRanges.of((view) => view.plugin(plug)?.decorations ?? Decoration.none),
  },
);

export const frontmatter: Extension = [plugin];
