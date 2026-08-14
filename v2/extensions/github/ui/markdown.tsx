import type { ReactElement, ReactNode } from 'react';

/**
 * Enough markdown to read a pull request body, and no more.
 *
 * The panel used to split on blank lines and emit `<p>`, with a comment arguing
 * that a renderer was not worth it "for a field most PRs use for two sentences".
 * That is true of a human's PR and false of this app's: an agent writes the body,
 * and an agent writes **headings, fenced code, and lists**. Flattened, a real one
 * renders as a single wall of prose in which the description, the reproduction
 * and the test plan are indistinguishable — which is what shipped, and what this
 * replaces.
 *
 * **It builds React elements, never HTML.** That deletes the sanitiser half of
 * the old objection outright: there is no `dangerouslySetInnerHTML` here, so a
 * body containing `<script>` is text that says `<script>`. It is also why images
 * are deliberately absent — a remote `<img>` in a pane is a network request to
 * whatever host a PR body names, which is a tracking pixel with extra steps.
 *
 * It is a BLOCK parser with a small inline pass, not CommonMark. The line it
 * draws: constructs that change what a paragraph *is* (a heading, a list, a code
 * fence) are worth parsing, because getting them wrong destroys the shape of the
 * document. Constructs that only decorate a run of text (nested emphasis,
 * reference links, tables) are not, because getting them wrong costs a bit of
 * styling. When something is not recognised it renders as its own source text,
 * which is the failure mode markdown was designed around.
 */

export type Block =
  | { readonly kind: 'code'; readonly lang: string | null; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'para'; readonly text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S+)?\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;

/**
 * The document, as blocks. Pure, and the reason the parser is a separate
 * function from the component: every case below is a shape a real PR body has,
 * and none of them needs a DOM to assert about.
 */
export function parseBlocks(source: string): readonly Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    /*
     * Fences FIRST, and everything inside one is taken verbatim.
     *
     * A code block is where markdown's own syntax stops meaning anything, so a
     * `# comment` in a shell snippet is a comment and not an H1 — which is the
     * single most visible way a naive renderer mangles a PR body that contains a
     * command line.
     */
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        // Closing fence: at least as long as the opening one, same character.
        if (next.trimStart().startsWith(marker[0] as string) && next.trim().length >= marker.length) {
          const closing = next.trim();
          if (closing.split('').every((char) => char === marker[0])) {
            index += 1;
            break;
          }
        }
        body.push(next);
        index += 1;
      }
      blocks.push({ kind: 'code', lang: fence[2] ?? null, text: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const body: string[] = [];
      while (index < lines.length) {
        const marked = QUOTE.exec(lines[index] ?? '');
        if (marked === null) break;
        body.push(marked[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = bullet === null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (match !== null) {
          items.push(match[1] ?? '');
          index += 1;
          continue;
        }
        /*
         * A continuation line — indented, not blank, not a new item — belongs to
         * the item above. Without this, a wrapped bullet becomes a paragraph of
         * its own and the list appears to end halfway down.
         */
        if (current.trim() !== '' && /^\s{2,}/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] as string} ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    /*
     * A paragraph runs until a blank line or until something else starts.
     *
     * Its newlines are KEPT rather than collapsed. CommonMark would join them,
     * but a PR body is written in a textarea by something that means its line
     * breaks — an agent listing three findings on three lines expects three
     * lines, and joining them is how this panel produced its wall of text.
     */
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '') break;
      if (FENCE.test(current) || HEADING.test(current) || QUOTE.test(current) || RULE.test(current)) break;
      if (BULLET.test(current) || ORDERED.test(current)) break;
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: 'para', text: body.join('\n') });
  }

  return blocks;
}

/** `code`, **bold**, *italic*, ~~struck~~, [text](url), and a bare URL. */
const INLINE =
  /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![*\w])\*([^*\n]+?)\*(?!\*)|~~([^~]+?)~~|\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/g;

/**
 * The inline pass.
 *
 * Code spans are matched FIRST in the alternation, so `**` inside backticks
 * stays literal — the same rule the fence follows one level up, and the reason a
 * body explaining markdown syntax does not render as its own examples.
 *
 * A link's href is checked against `http(s)` at the pattern rather than after:
 * `javascript:` in an `<a>` is the one genuinely dangerous thing a body can
 * contain, and a pattern that cannot express it needs no filter to remove it.
 */
export function inline(text: string, keyPrefix = ''): readonly ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}${match.index}`;
    const [, , code, strongStar, strongUnder, emphasis, struck, linkText, linkHref, bare] = match;

    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (strongStar !== undefined || strongUnder !== undefined)
      out.push(<strong key={key}>{strongStar ?? strongUnder}</strong>);
    else if (emphasis !== undefined) out.push(<em key={key}>{emphasis}</em>);
    else if (struck !== undefined) out.push(<s key={key}>{struck}</s>);
    else if (linkHref !== undefined)
      out.push(
        // No `href` that navigates: this is a pane, not a browser, and a click
        // that replaced the app's own document would be unrecoverable. The URL
        // is shown and selectable; `Open on GitHub` is the way out of here.
        <a key={key} className="sh-md__link" title={linkHref}>
          {linkText === '' ? linkHref : linkText}
        </a>,
      );
    else if (bare !== undefined)
      out.push(
        <a key={key} className="sh-md__link" title={bare}>
          {bare}
        </a>,
      );

    last = match.index + match[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A markdown body, as elements. */
export function Markdown({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="sh-md">
      {parseBlocks(text).map((block, index) => (
        <Block key={index} block={block} at={index} />
      ))}
    </div>
  );
}

function Block({ block, at }: { readonly block: Block; readonly at: number }): ReactElement {
  switch (block.kind) {
    case 'code':
      /*
       * Not highlighted, and that is a decision rather than a gap. `@pierre/diffs`
       * carries shiki for the Files tab, but a snippet in a PR body has no
       * declared language most of the time — and guessing one paints somebody's
       * log output as if it were source.
       */
      return (
        <pre className="sh-md__code" data-lang={block.lang ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'heading': {
      // Capped at h4: this is a card inside a pane, and the PR's own title is
      // the h2 above it, so a body's `#` must not outrank it.
      const level = Math.min(block.level + 2, 6);
      const Tag = `h${level}` as 'h3';
      return (
        <Tag className="sh-md__heading" data-level={block.level}>
          {inline(block.text, `h${at}-`)}
        </Tag>
      );
    }
    case 'list':
      return block.ordered ? (
        <ol className="sh-md__list">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item, `l${at}-${index}-`)}</li>
          ))}
        </ol>
      ) : (
        <ul className="sh-md__list">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item, `l${at}-${index}-`)}</li>
          ))}
        </ul>
      );
    case 'quote':
      return <blockquote className="sh-md__quote">{inline(block.text, `q${at}-`)}</blockquote>;
    case 'rule':
      return <hr className="sh-md__rule" />;
    case 'para':
      return <p className="sh-md__para">{inline(block.text, `p${at}-`)}</p>;
  }
}
