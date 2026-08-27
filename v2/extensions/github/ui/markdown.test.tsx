// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from './markdown.tsx';

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
 * What this panel promises about a body, asserted through the DOM.
 *
 * CommonMark and GFM have their own test suites and `remark` passes them, so
 * nothing here re-tests the parser. Every case below is either a rule this file
 * adds on top of it — raw HTML as text, a link that cannot navigate, an image
 * that cannot load, a heading that cannot outrank the title — or a shape a real
 * agent-written body has that the hand-rolled parser it replaces got wrong.
 */

describe('Markdown', () => {
  it('renders the structure rather than one paragraph', () => {
    const out = draw('## Description\n\nIt does `a thing`.\n\n- first\n- second');
    expect(out.querySelector('h4')?.textContent).toBe('Description');
    expect(out.querySelector('p code')?.textContent).toBe('a thing');
    expect(out.querySelectorAll('li')).toHaveLength(2);
  });

  it('caps a heading below the PR’s own title', () => {
    // The title is the h2 above this card; a body's `#` must not outrank it.
    expect(draw('# Top').querySelector('h3')?.textContent).toBe('Top');
    expect(draw('###### Deep').querySelector('h6')?.textContent).toBe('Deep');
  });

  it('says a tag rather than becoming one', () => {
    /*
     * The library's default is to DROP a raw HTML node, which would delete the
     * sentence it sits in; the only shipped alternative parses it as markup.
     * `htmlAsText` takes neither.
     */
    const out = draw('<script>alert(1)</script>');
    expect(out.querySelector('script')).toBeNull();
    expect(out.textContent).toContain('<script>');
  });

  it('keeps the prose around an inline tag', () => {
    const out = draw('wrap it in <details> when the log is long');
    expect(out.textContent).toContain('wrap it in <details> when the log is long');
  });

  it('deletes an HTML comment, which is addressed to a machine', () => {
    /*
     * A bot's comment is bracketed by them — CodeRabbit's opens with two and
     * closes with two more — and rendered as text they were four lines of
     * `<!-- tips_start -->` above the sentence anybody wanted. Nobody has ever
     * written one meaning it to be read, which is what makes this the one tag
     * that can be dropped without losing something.
     */
    const out = draw('<!-- audit-stack-pr-gate -->\nThis PR needs a stack audit.');
    expect(out.textContent).not.toContain('audit-stack-pr-gate');
    expect(out.textContent).toContain('This PR needs a stack audit.');
  });

  it('strips a comment that shares a line with real text', () => {
    // The shape a task-list item takes: one node carrying the marker AND the
    // words. Dropping the node whole would take the words with it.
    const out = draw('- [ ] <!-- {"checkboxId":"e9bb"} --> Trigger review');
    expect(out.textContent).toContain('Trigger review');
    expect(out.textContent).not.toContain('checkboxId');
  });

  it('collapses a <details>, which is what its author asked for', () => {
    const out = draw(
      ['<details>', '<summary>Run configuration</summary>', '', '**Plan**: Enterprise', '', '</details>'].join('\n'),
    );
    const details = out.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('Run configuration');
    // Closed, because a disclosure drawn open is the opposite of the tag.
    expect(details?.hasAttribute('open')).toBe(false);
    // And the markdown inside it is still markdown.
    expect(details?.querySelector('strong')?.textContent).toBe('Plan');
    expect(out.textContent).not.toContain('<summary>');
  });

  it('honours an open <details>, because a bot that asks has a reason', () => {
    const out = draw(['<details open>', '<summary>Findings</summary>', '', 'two', '', '</details>'].join('\n'));
    expect(out.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('makes an inline tag the element it names', () => {
    const out = draw('<sub>Comment @coderabbitai help for the commands.</sub>');
    expect(out.querySelector('sub')?.textContent).toContain('Comment');
    expect(out.textContent).not.toContain('</sub>');
  });

  it('leaves an unclosed tag as the text it was', () => {
    // A malformed body should lose its tag, never the rest of its paragraph —
    // so an opening half with no closing half falls back to the old answer.
    const out = draw('wrap it in <details> when the log is long');
    expect(out.querySelector('details')).toBeNull();
    expect(out.textContent).toContain('wrap it in <details> when the log is long');
  });

  it('reads GitHub\u2019s alert syntax as a callout, not as a line saying [!IMPORTANT]', () => {
    const out = draw('> [!IMPORTANT]\n> Review skipped.');
    const quote = out.querySelector('blockquote');
    expect(quote?.getAttribute('data-alert')).toBe('important');
    // The marker is a token that means nothing to a reader, so it goes.
    expect(out.textContent).not.toContain('[!IMPORTANT]');
    expect(out.textContent).toContain('Review skipped.');
  });

  it('gives a link no href, so a click cannot navigate the app away', () => {
    // This is a pane, not a browser: replacing the app's own document would be
    // unrecoverable, and there is no back.
    const out = draw('[docs](https://example.com)');
    const link = out.querySelector('a');
    expect(link?.textContent).toBe('docs');
    expect(link?.getAttribute('href')).toBeNull();
    expect(link?.getAttribute('title')).toBe('https://example.com');
  });

  it('refuses a scheme that is not http(s), including in a reference link', () => {
    const out = draw('[x](javascript:alert(1))\n\n[y][ref]\n\n[ref]: javascript:alert(2)');
    expect(out.querySelector('a')?.getAttribute('title')).toBeFalsy();
    expect(out.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('draws an image as its alt text and never as a request', () => {
    // A remote `<img>` is a GET to whatever host a PR body names.
    const out = draw('![a chart](https://example.com/pixel.png)');
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).toContain('a chart');
  });

  it('draws a fenced block as one preformatted run, tagged with its language', () => {
    const out = draw('```sh\ngh pr list --repo cli/cli\n```');
    expect(out.querySelector('pre')?.getAttribute('data-lang')).toBe('sh');
    expect(out.querySelector('pre code')?.textContent?.trim()).toBe('gh pr list --repo cli/cli');
  });

  it('leaves markup inside a code span alone', () => {
    // A body explaining markdown must not render as its own examples.
    const out = draw('use `**bold**` for bold');
    expect(out.querySelector('strong')).toBeNull();
    expect(out.querySelector('code')?.textContent).toBe('**bold**');
  });

  it('takes a fence VERBATIM, markdown syntax and all', () => {
    // The most visible way a naive renderer mangles a body: a `#` comment in a
    // shell snippet becoming a heading.
    const out = draw('```sh\n# not a heading\nrm -rf *.tmp\n```');
    expect(out.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(out.querySelector('pre code')?.textContent).toContain('# not a heading');
  });

  // ---------------------------------------------------------------- GFM

  it('draws a table, which the parser this replaces could not', () => {
    const out = draw('| what | how long |\n|---|---|\n| cold walk | **2.6 s** |');
    expect([...out.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['what', 'how long']);
    expect([...out.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['cold walk', '2.6 s']);
    expect(out.querySelector('td strong')?.textContent).toBe('2.6 s');
  });

  it('needs a divider, so a sentence with a pipe in it stays a sentence', () => {
    const out = draw('run `ls | wc -l` first');
    expect(out.querySelector('table')).toBeNull();
  });

  it('draws a task list as checkboxes nobody can toggle', () => {
    const out = draw('- [x] shipped\n- [ ] not yet');
    const boxes = [...out.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('keeps a nested list nested', () => {
    // The hand-rolled parser flattened this to four siblings, which is how a
    // plan with sub-steps lost its shape.
    const out = draw('- one\n  - under one\n- two');
    expect(out.querySelectorAll('ul')).toHaveLength(2);
    expect(out.querySelector('li ul li')?.textContent).toBe('under one');
  });

  it('reads strikethrough, an autolink and a footnote', () => {
    const out = draw('~~gone~~ https://example.com and a note[^1]\n\n[^1]: the note');
    expect(out.querySelector('del')?.textContent).toBe('gone');
    expect(out.textContent).toContain('https://example.com');
    expect(out.textContent).toContain('the note');
  });

  it('joins a soft-wrapped paragraph, the way GitHub does', () => {
    /*
     * The parser this replaces KEPT every newline, on the argument that an
     * agent means its line breaks. Measured against real bodies that was wrong
     * more often than right: a body wrapped at 80 columns rendered as a ragged
     * column, and GitHub — which is where these bodies are written and
     * previewed — joins them.
     */
    const out = draw('one line\nand its continuation');
    expect(out.querySelectorAll('p')).toHaveLength(1);
    expect(out.querySelector('br')).toBeNull();
  });

  it('keeps a HARD break, which is how an agent means one', () => {
    const out = draw('first  \nsecond');
    expect(out.querySelector('br')).not.toBeNull();
  });

  it('renders the empty body as nothing', () => {
    expect(draw('').textContent).toBe('');
  });

  it('survives CRLF, which is what a Windows author’s body arrives as', () => {
    const out = draw('# a\r\n\r\nb');
    expect(out.querySelector('h3')?.textContent).toBe('a');
    expect(out.querySelector('p')?.textContent).toBe('b');
  });
});
