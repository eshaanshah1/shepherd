import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { buildDecorations } from './live-preview.ts';
import { scratchMarkdown } from './markdown-parser.ts';

/**
 * What the user actually SEES, as a string.
 *
 * The decoration tests next door assert that ranges exist. This asserts what
 * those ranges add up to, which is a different question and the one a reader of
 * the pane is asking: a rule that hid a marker but left its trailing space
 * passes there and is visibly wrong here.
 *
 * Replacements are applied and widgets stand in as one glyph each. Styling
 * decorations are ignored, since they change no characters.
 */
const GLYPH: Readonly<Record<string, string>> = {
  BulletWidget: '•',
  CheckboxWidget: '☐',
  RuleWidget: '────',
};

function rendered(markup: string): string {
  // The caret parks on a trailing line, so nothing in `markup` is being edited.
  const doc = `${markup}\n\nx`;
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdown({ extensions: scratchMarkdown })],
  });

  const edits: { from: number; to: number; glyph: string }[] = [];
  buildDecorations(state).between(0, markup.length, (from, to, deco) => {
    const spec = deco.spec as { widget?: { constructor: { name: string } }; class?: string };
    // A styling decoration changes no characters.
    if (spec.class !== undefined && spec.widget === undefined) return;
    if (to <= from) return;
    edits.push({ from, to, glyph: spec.widget === undefined ? '' : (GLYPH[spec.widget.constructor.name] ?? '?') });
  });

  let out = '';
  let cursor = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    if (edit.from < cursor) continue;
    out += markup.slice(cursor, edit.from) + edit.glyph;
    cursor = edit.to;
  }
  return out + markup.slice(cursor);
}

describe('what a scratch pane draws', () => {
  it('drops a heading marker and its space', () => {
    expect(rendered('# hi')).toBe('hi');
    expect(rendered('### deeper')).toBe('deeper');
  });

  it('draws a bullet for a dash', () => {
    // The space after the marker survives: unlike a `#`, a bullet needs one.
    expect(rendered('- one')).toBe('• one');
  });

  it('keeps the digits of an ordered list', () => {
    // The number is what the user is counting with; replacing it loses it.
    expect(rendered('1. first')).toBe('1. first');
  });

  it('draws a checkbox and no bullet beside it', () => {
    expect(rendered('- [ ] task')).toBe('☐ task');
    expect(rendered('- [x] done')).toBe('☐ done');
  });

  it('drops a quote marker and its space', () => {
    expect(rendered('> quoted')).toBe('quoted');
  });

  it('drops emphasis markers but not the character after them', () => {
    expect(rendered('**bold**')).toBe('bold');
    expect(rendered('*it*')).toBe('it');
    expect(rendered('~~gone~~')).toBe('gone');
    expect(rendered('`code`')).toBe('code');
  });

  it('draws a link as its text alone', () => {
    expect(rendered('[the docs](https://x.com)')).toBe('the docs');
  });

  it('leaves a bare URL as itself', () => {
    // Autolinked, so it is styled and clickable, but there is nothing to hide.
    expect(rendered('see https://x.com')).toBe('see https://x.com');
  });

  it('draws a rule instead of dashes', () => {
    expect(rendered('---')).toBe('────');
  });

  it('leaves a table exactly as typed', () => {
    expect(rendered('| a | b |')).toBe('| a | b |');
  });

  it('leaves raw HTML exactly as typed', () => {
    expect(rendered('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('draws a bare checkbox, which markdown does not have but people type', () => {
    expect(rendered('[] ship it')).toBe('☐ ship it');
    expect(rendered('[ ] ship it')).toBe('☐ ship it');
    expect(rendered('[x] shipped')).toBe('☐ shipped');
  });

  it('does NOT draw a bare bracket pair as a link', () => {
    // `[x]` parses as a shortcut reference Link with no URL. Drawn as a link it
    // was a blue underlined `x`, which is what a dashless checkbox looked like.
    expect(rendered('see [ref] there')).toBe('see [ref] there');
  });

  it('still draws a real inline link as its text alone', () => {
    // The negative control for the rule above: a Link WITH a URL is still a link.
    expect(rendered('[the docs](https://x.com)')).toBe('the docs');
  });

  it('leaves a bracket pair that is a link label alone', () => {
    expect(rendered('[x](https://x.com)')).toBe('x');
  });

  it('leaves prose exactly as typed', () => {
    expect(rendered('nothing special here')).toBe('nothing special here');
  });
});
