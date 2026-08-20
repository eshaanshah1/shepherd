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
  it('shows a heading raw when the caret is on its line', () => {
    expect(decorated('# hi\n\nx', 2)).toBe(false);
  });

  it('shows the heading rendered once the caret leaves that line', () => {
    expect(decorated('# hi\n\nx', 6)).toBe(true);
  });

  it('is per LINE for a block: caret at the end of the line is still raw', () => {
    expect(decorated('# hi\n\nx', 4)).toBe(false);
  });

  it('is per LINE for a block: caret at the very start is still raw', () => {
    expect(decorated('# hi\n\nx', 0)).toBe(false);
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

  it('decorates nothing when the whole document is selected', () => {
    // atomicRanges interacts with selections, not only with the caret.
    const doc = '# hi\n\n**bold** and `code`';
    expect(decorated(doc, 0, doc.length)).toBe(false);
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
