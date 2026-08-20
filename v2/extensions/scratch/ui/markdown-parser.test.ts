import { describe, expect, it } from 'vitest';
import { parse } from './markdown-parser.ts';

/** Every node type the tree contains, as a set, for readable assertions. */
function nodeTypes(text: string): Set<string> {
  const found = new Set<string>();
  parse(text).iterate({ enter: (node) => void found.add(node.name) });
  return found;
}

describe('the scratch markdown parser knows', () => {
  it('headings', () => expect(nodeTypes('# hi')).toContain('ATXHeading1'));
  it('bold', () => expect(nodeTypes('**hi**')).toContain('StrongEmphasis'));
  it('italic', () => expect(nodeTypes('*hi*')).toContain('Emphasis'));
  it('inline code', () => expect(nodeTypes('`hi`')).toContain('InlineCode'));
  it('fenced code', () => expect(nodeTypes('```\nhi\n```')).toContain('FencedCode'));
  it('bullet lists', () => expect(nodeTypes('- hi')).toContain('BulletList'));
  it('ordered lists', () => expect(nodeTypes('1. hi')).toContain('OrderedList'));
  it('blockquotes', () => expect(nodeTypes('> hi')).toContain('Blockquote'));
  it('links', () => expect(nodeTypes('[hi](https://x.com)')).toContain('Link'));
  it('horizontal rules', () => expect(nodeTypes('---')).toContain('HorizontalRule'));
  it('strikethrough', () => expect(nodeTypes('~~hi~~')).toContain('Strikethrough'));
  it('task markers', () => expect(nodeTypes('- [ ] hi')).toContain('TaskMarker'));
  it('bare URLs', () => expect(nodeTypes('see https://x.com now')).toContain('URL'));
});

describe('the scratch markdown parser does NOT know', () => {
  /*
   * The negative assertions, which are the point of this file.
   *
   * "No tables" is not a rule anything enforces at render time — `Table` is
   * simply an extension we do not import, so a table is a paragraph. If someone
   * adds it to the extension list to fix an unrelated parse bug, this fails.
   */
  it('tables — a table is a paragraph', () => {
    const types = nodeTypes('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(types).not.toContain('Table');
    expect(types).not.toContain('TableRow');
    expect(types).not.toContain('TableCell');
    expect(types).toContain('Paragraph');
  });

  it('footnotes', () => {
    expect(nodeTypes('a[^1]\n\n[^1]: note')).not.toContain('Footnote');
  });

  it('emoji shortcodes', () => {
    expect(nodeTypes(':tada: shipped')).not.toContain('Emoji');
  });

  it('subscript or superscript', () => {
    const types = nodeTypes('H~2~O and x^2^');
    expect(types).not.toContain('Subscript');
    expect(types).not.toContain('Superscript');
  });

  it('raw HTML as anything but an undecorated block', () => {
    // A body that says `<script>` is a body that SAYS `<script>`. It parses to
    // an HTMLBlock, which nothing in live-preview.ts decorates — so it renders
    // as the characters that were typed, with no sanitiser anywhere, because
    // nothing was ever markup.
    expect(nodeTypes('<script>alert(1)</script>')).toContain('HTMLBlock');
  });
});
