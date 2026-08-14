// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from './markdown.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Render a body and hand back the element it produced. */
function draw(text: string): HTMLDivElement {
  act(() => root.render(<Markdown text={text} />));
  return host;
}

/**
 * The parser, against the shapes a real PR body has — which is the reason it
 * exists at all. Every case here comes from `cli/cli#14136` or from the bodies
 * this app's own agents write.
 */

describe('parseBlocks', () => {
  it('keeps a heading a heading', () => {
    expect(parseBlocks('## Description')).toEqual([{ kind: 'heading', level: 2, text: 'Description' }]);
  });

  it('takes a fenced block VERBATIM, markdown syntax and all', () => {
    /*
     * The single most visible way a naive renderer mangles a PR body: a `#`
     * comment in a shell snippet becoming an H1, and `*` in a glob becoming
     * emphasis.
     */
    const blocks = parseBlocks('```sh\n# not a heading\nrm -rf *.tmp\n```');
    expect(blocks).toEqual([{ kind: 'code', lang: 'sh', text: '# not a heading\nrm -rf *.tmp' }]);
  });

  it('closes a fence only on a fence, so a blank line inside one is kept', () => {
    const [block] = parseBlocks('```\na\n\nb\n```');
    expect(block).toEqual({ kind: 'code', lang: null, text: 'a\n\nb' });
  });

  it('reads a fence that was never closed, rather than dropping the rest of the body', () => {
    expect(parseBlocks('```\nstill here')).toEqual([{ kind: 'code', lang: null, text: 'still here' }]);
  });

  it('reads both kinds of list', () => {
    expect(parseBlocks('- one\n- two')).toEqual([{ kind: 'list', ordered: false, items: ['one', 'two'] }]);
    expect(parseBlocks('1. one\n2. two')).toEqual([{ kind: 'list', ordered: true, items: ['one', 'two'] }]);
  });

  it('keeps a wrapped bullet on its own bullet', () => {
    // Without this the list appears to end halfway down and the rest becomes a
    // paragraph — which is exactly what a long agent-written list looks like.
    expect(parseBlocks('- a claim\n  that wrapped\n- another')).toEqual([
      { kind: 'list', ordered: false, items: ['a claim that wrapped', 'another'] },
    ]);
  });

  it('ends a paragraph when a block starts, not only at a blank line', () => {
    // Agents routinely write a heading straight after a sentence with no blank
    // line between them.
    expect(parseBlocks('a sentence\n## Then a heading').map((block) => block.kind)).toEqual(['para', 'heading']);
  });

  it('KEEPS a paragraph’s own line breaks', () => {
    /*
     * CommonMark joins them. A PR body is written by something that means its
     * line breaks — three findings on three lines are three lines — and joining
     * them is precisely how this panel produced its wall of text.
     */
    expect(parseBlocks('one\ntwo')).toEqual([{ kind: 'para', text: 'one\ntwo' }]);
  });

  it('reads a quote, a rule, and the empty body', () => {
    expect(parseBlocks('> quoted\n> more')).toEqual([{ kind: 'quote', text: 'quoted\nmore' }]);
    expect(parseBlocks('---')).toEqual([{ kind: 'rule' }]);
    expect(parseBlocks('')).toEqual([]);
  });

  it('survives CRLF, which is what a Windows author’s body arrives as', () => {
    expect(parseBlocks('# a\r\n\r\nb')).toEqual([
      { kind: 'heading', level: 1, text: 'a' },
      { kind: 'para', text: 'b' },
    ]);
  });
});

describe('Markdown', () => {
  it('renders the structure rather than one paragraph', () => {
    const out = draw('## Description\n\nIt does `a thing`.\n\n- first\n- second');
    expect(out.querySelector('h4')?.textContent).toBe('Description');
    expect(out.querySelector('p code')?.textContent).toBe('a thing');
    expect(out.querySelectorAll('li')).toHaveLength(2);
  });

  it('never lets a body become markup', () => {
    // React builds elements; nothing here is `dangerouslySetInnerHTML`. A body
    // that contains a tag is a body that SAYS a tag.
    const out = draw('<script>alert(1)</script>');
    expect(out.querySelector('script')).toBeNull();
    expect(out.textContent).toContain('<script>');
  });

  it('gives a link no href, so a click cannot navigate the app away', () => {
    // This is a pane, not a browser: replacing the app's own document would be
    // unrecoverable. `javascript:` cannot even be expressed — the pattern only
    // matches http(s).
    const out = draw('[docs](https://example.com) and [x](javascript:alert(1))');
    const link = out.querySelector('a');
    expect(link?.textContent).toBe('docs');
    expect(link?.getAttribute('href')).toBeNull();
    expect(out.textContent).toContain('javascript:alert(1)');
    expect(out.querySelectorAll('a')).toHaveLength(1);
  });

  it('leaves markup inside a code span alone', () => {
    // A body explaining markdown must not render as its own examples.
    const out = draw('use `**bold**` for bold');
    expect(out.querySelector('strong')).toBeNull();
    expect(out.querySelector('code')?.textContent).toBe('**bold**');
  });

  it('caps a heading below the PR\u2019s own title', () => {
    // The title is the h2 above this card; a body's `#` must not outrank it.
    expect(draw('# Top').querySelector('h3')?.textContent).toBe('Top');
  });

  it('draws a fenced block as one preformatted run', () => {
    const out = draw('```sh\ngh pr list --repo cli/cli\n```');
    expect(out.querySelector('pre')?.getAttribute('data-lang')).toBe('sh');
    expect(out.querySelector('pre code')?.textContent).toBe('gh pr list --repo cli/cli');
  });
});
