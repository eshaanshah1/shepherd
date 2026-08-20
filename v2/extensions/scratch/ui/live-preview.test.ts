import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { buildDecorations } from './live-preview.ts';
import { scratchMarkdown } from './markdown-parser.ts';

/**
 * A state with the language in it, because `buildDecorations` reads
 * `syntaxTree` — a bare state has no parser and would answer an empty tree,
 * which would make every assertion below pass for the wrong reason.
 */
function stateOf(doc: string, caret?: number, head?: number): EditorState {
  return EditorState.create({
    doc,
    ...(caret === undefined ? {} : { selection: { anchor: caret, head: head ?? caret } }),
    extensions: [markdown({ extensions: scratchMarkdown })],
  });
}

/** The decorated ranges as `[from, to]` pairs, for readable assertions. */
function ranges(doc: string, caret?: number, head?: number): [number, number][] {
  const out: [number, number][] = [];
  buildDecorations(stateOf(doc, caret, head)).between(0, doc.length + 1, (from, to) => void out.push([from, to]));
  return out;
}

const decorated = (doc: string, caret?: number, head?: number): boolean => ranges(doc, caret, head).length > 0;

/** Is the marker at `[0, n]` replaced — i.e. gone from the screen? */
function markerHidden(doc: string, caret?: number, head?: number): boolean {
  const state = stateOf(doc, caret, head);
  let hidden = false;
  buildDecorations(state).between(0, doc.length, (from, to, deco) => {
    const spec = deco.spec as { class?: string; widget?: unknown };
    // A replacement covers characters; a line class covers none.
    if (to > from && spec.class === undefined && spec.widget === undefined) hidden = true;
  });
  return hidden;
}

/** Is the line carrying a style class, whatever the markers are doing? */
function lineStyled(doc: string, caret?: number, head?: number): boolean {
  const state = stateOf(doc, caret, head);
  let styled = false;
  buildDecorations(state).between(0, doc.length, (from, to, deco) => {
    if (from === to && (deco.spec as { class?: string }).class !== undefined) styled = true;
  });
  return styled;
}

describe('live preview, with the selection away from the construct', () => {
  it('decorates a heading', () => expect(decorated('# hi\n\nx', 6)).toBe(true));
  it('decorates bold', () => expect(decorated('**hi**\n\nx', 8)).toBe(true));
  it('decorates italic', () => expect(decorated('*hi*\n\nx', 6)).toBe(true));
  it('decorates inline code', () => expect(decorated('`hi`\n\nx', 6)).toBe(true));
  it('decorates a fence', () => expect(decorated('```\nhi\n```\n\nx', 12)).toBe(true));
  it('decorates a bullet list', () => expect(decorated('- hi\n\nx', 6)).toBe(true));
  it('decorates a blockquote', () => expect(decorated('> hi\n\nx', 6)).toBe(true));
  it('decorates a link', () => expect(decorated('[hi](https://x.com)\n\nx', 21)).toBe(true));
  it('decorates a bare URL', () => expect(decorated('see https://x.com\n\nx', 19)).toBe(true));
  it('decorates a task marker', () => expect(decorated('- [ ] hi\n\nx', 10)).toBe(true));
  it('decorates strikethrough', () => expect(decorated('~~hi~~\n\nx', 8)).toBe(true));
  it('decorates a horizontal rule', () => expect(decorated('---\n\nx', 5)).toBe(true));

  it('hides the # of a heading entirely', () => {
    // The marker is REPLACED, not merely styled: `# hi` must draw as `hi`.
    // [0, 2] rather than [0, 1]: the marker takes the space after it, or the
    // heading text is left indented by one character at h1 size.
    const found = ranges('# hi\n\nx', 6);
    expect(found).toContainEqual([0, 2]);
  });

  it('hides the ** on both sides of bold', () => {
    const found = ranges('**hi**\n\nx', 8);
    expect(found).toContainEqual([0, 2]);
    expect(found).toContainEqual([4, 6]);
  });

  it('decorates NOTHING in a table, ever', () => {
    // Not a suppression rule. The parser has no Table extension, so there is
    // nothing here to decorate. markdown-parser.test.ts is the other half.
    expect(decorated('| a | b |\n|---|---|\n| 1 | 2 |', 0)).toBe(false);
  });

  it('decorates NOTHING in raw HTML', () => {
    // A body that says `<script>` is a body that SAYS `<script>`, with no
    // sanitiser anywhere, because nothing was ever markup.
    expect(decorated('<script>alert(1)</script>\n\nx', 27)).toBe(false);
  });

  it('decorates nothing in plain prose', () => {
    expect(decorated('just a sentence with no markup in it at all', 0)).toBe(false);
  });
});

describe('the caret rule', () => {
  it('styles a heading while the caret is still on it, and keeps the # visible', () => {
    // Styling is immediate so a heading looks like one from the first character
    // typed; hiding the `#` waits, because removing it under the caret shifts
    // the text being typed sideways mid-word.
    expect(lineStyled('# hi\n\nx', 2)).toBe(true);
    expect(markerHidden('# hi\n\nx', 2)).toBe(false);
  });

  it('hides the # once the caret leaves the line', () => {
    expect(markerHidden('# hi\n\nx', 6)).toBe(true);
  });

  it('shows the heading rendered once the caret leaves that line', () => {
    expect(decorated('# hi\n\nx', 6)).toBe(true);
  });

  it('is per LINE for a block: the marker stays at the end of the line', () => {
    expect(markerHidden('# hi\n\nx', 4)).toBe(false);
  });

  it('is per LINE for a block: the marker stays at the very start', () => {
    expect(markerHidden('# hi\n\nx', 0)).toBe(false);
  });

  it('keeps a bullet marker visible while the caret is on its line', () => {
    // The same split, for the construct where it matters most: a `-` replaced by
    // a bullet under the caret moves every character after it.
    expect(markerHidden('- one\n\nx', 3)).toBe(false);
  });

  it('is per NODE for an inline: other bold on the same line stays rendered', () => {
    // Caret inside the first bold. Nothing before offset 8 may be decorated,
    // and the second bold must still be.
    const found = ranges('**one** and **two**', 3);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(([from]) => from >= 8)).toBe(true);
  });

  it('shows a construct raw when a SELECTION covers it, not only a caret', () => {
    expect(decorated('**hi**\n\nx', 0, 6)).toBe(false);
  });

  it('hides no marker anywhere when the whole document is selected', () => {
    // atomicRanges interacts with selections, not only with the caret — nothing
    // inside a selection may vanish, or select-all-then-type loses characters.
    const doc = '# hi\n\n**bold** and `code`';
    expect(markerHidden(doc, 0, doc.length)).toBe(false);
  });
});

describe('live preview survives', () => {
  it('an empty document', () => expect(() => ranges('')).not.toThrow());
  it('a lone hash', () => expect(() => ranges('#', 1)).not.toThrow());
  it('a lone bullet', () => expect(() => ranges('- ', 2)).not.toThrow());
  it('a lone pair of stars', () => expect(() => ranges('**', 2)).not.toThrow());
  it('an empty list item', () => expect(() => ranges('- \n- x', 2)).not.toThrow());
  it('an unclosed fence', () => expect(() => ranges('```\nunclosed', 12)).not.toThrow());
  it('a caret just past a closing **', () => expect(() => ranges('**hi**', 6)).not.toThrow());
  it('a caret on a fence opening line', () => expect(() => ranges('```js\nx\n```', 3)).not.toThrow());
  it('nested lists', () => expect(() => ranges('- a\n  - b\n    - c', 16)).not.toThrow());
  it('a document of only newlines', () => expect(() => ranges('\n\n\n\n', 2)).not.toThrow());
});

describe('a checkbox with no list marker', () => {
  it('is decorated at the head of a line', () => {
    expect(decorated('[] ship it\n\nx', 12)).toBe(true);
  });

  it('is left raw while the selection touches it', () => {
    expect(markerHidden('[] ship it', 1)).toBe(false);
  });

  it('is NOT decorated mid-line, where it is just brackets', () => {
    expect(decorated('see [] there\n\nx', 14)).toBe(false);
  });

  it('is NOT decorated when it is a link label', () => {
    // `[x](url)` is a real link whose text is `x`; the lookahead protects it.
    const found = ranges('[x](https://x.com)\n\ny', 20);
    const widgets: string[] = [];
    buildDecorations(stateOf('[x](https://x.com)\n\ny', 20)).between(0, 18, (f, t, d) => {
      const w = (d.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w) widgets.push(w.constructor.name);
    });
    expect(found.length).toBeGreaterThan(0);
    expect(widgets).not.toContain('CheckboxWidget');
  });

  it('does not double up on a real task line', () => {
    // `- [ ] x` is handled by TaskMarker; the bare scan must not fire too.
    const widgets: string[] = [];
    buildDecorations(stateOf('- [ ] x\n\ny', 9)).between(0, 7, (f, t, d) => {
      const w = (d.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w) widgets.push(w.constructor.name);
    });
    expect(widgets.filter((n) => n === 'CheckboxWidget')).toHaveLength(1);
  });
});
