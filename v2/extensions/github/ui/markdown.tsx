import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A pull request body, drawn as the document it is.
 *
 * This used to be a hand-rolled block parser: nine constructs, a small inline
 * pass, and everything else rendered as its own source text. It was already the
 * second attempt — the first split on blank lines and emitted `<p>` — and it
 * was still wrong about the things an agent actually writes. A nested list
 * flattened to one level. A task list drew `[ ]` as two characters. A reference
 * link, a footnote, an autolink and an HTML entity each came out as source.
 *
 * The line the old file drew was between constructs that change what a
 * paragraph *is* and constructs that decorate a run of text. That line was
 * sound; the mistake was believing the first set was small. It is CommonMark,
 * which is a specification with a 600-case test suite, plus GFM, which is
 * another one. `remark` implements both.
 *
 * **It still builds React elements, never HTML.** That is the property the
 * whole panel rests on, and it is why `react-markdown` is here rather than
 * `marked` or `markdown-it` — both are smaller and faster and both hand back an
 * HTML string, which would mean `dangerouslySetInnerHTML` and a sanitiser to
 * make it safe again.
 *
 * Three things are ours rather than the library's, each below with its reason:
 * raw HTML is read rather than shown, links do not navigate, and images do not
 * load.
 */

/**
 * What raw HTML in a body becomes — and it is three different answers.
 *
 * This file used to have one: every `html` node was rewritten to `text`, so a
 * body that mentioned `<details>` said `<details>` and no sanitiser existed
 * anywhere. That is still the right answer for the case it was written for, a
 * human or an agent writing prose about markup. It is the wrong one for the
 * case that arrived later, which is a BOT.
 *
 * A bot's comment is mostly machine HTML. CodeRabbit's opens with two marker
 * comments, wraps its configuration in a `<details>` and closes with `<sub>`,
 * and rendered as text that is nine lines of tag soup around the two sentences
 * anybody wanted — with the `<details>` drawn EXPANDED, which is the opposite
 * of what its author asked for.
 *
 * So, in order:
 *
 *   1. **A comment is deleted.** `<!-- tips_start -->` is addressed to a
 *      machine. Nobody has ever written one meaning it to be read, which is
 *      what makes this the one tag that can be dropped without losing a
 *      sentence.
 *   2. **A tag on the short list becomes that element.** `<details>` collapses,
 *      `<sub>` is small. Reached by rewriting mdast so `remark-rehype` builds
 *      the element itself — NOT by parsing the string as markup, so there is
 *      still no `rehype-raw`, no HTML string and nothing to sanitise. The list
 *      is what bots actually emit, and it grows one line at a time.
 *   3. **Everything else is still text**, exactly as before.
 */

/** An mdast node, to the shallow extent this file needs one. */
interface Node {
  type?: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
}

const COMMENT = /<!--[\s\S]*?-->/g;

/**
 * The inline tags worth promoting — what a bot's sign-off is made of.
 *
 * Each one is a pair that WRAPS text, which is the property that matters: the
 * transform below has to find the closing half, and a tag with no closing half
 * would swallow the rest of the paragraph. `<br>` is handled separately for
 * exactly that reason.
 */
const INLINE = new Set(['sub', 'sup', 'kbd', 'small', 'ins', 'del', 'b', 'i', 'u']);

/** GitHub's alert syntax: a blockquote whose first line names its kind. */
const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*/i;

function readHtml() {
  return (tree: Node): void => walk(tree);
}

function walk(node: Node): void {
  if (node.children !== undefined) {
    node.children = fold(dropComments(node.children));
    for (const child of node.children) walk(child);
  }
  readAlert(node);
  // Whatever survived every rule above was markup this build does not know, and
  // it goes back to being what it has always been here: the text it says.
  if (node.type === 'html') node.type = 'text';
}

/**
 * Comments out, and a node that was ONLY comments out with them.
 *
 * Stripped from the value rather than matched whole, because a bot writes them
 * both ways — `<!-- tips_end -->` alone on a line, and
 * `<!-- {"checkboxId":"…"} --> 🔍 Trigger review` sharing one node with the
 * text of a task-list item.
 */
function dropComments(children: readonly Node[]): Node[] {
  return children.flatMap((child) => {
    if (child.type !== 'html') return [child];
    const left = (child.value ?? '').replace(COMMENT, '').trim();
    if (left === '') return [];
    return [{ ...child, value: left }];
  });
}

/**
 * The paired tags, folded into the elements they describe.
 *
 * One pass over a parent's children, because that is where both halves of a
 * pair live: remark gives `<details>` and `</details>` as SIBLINGS with the
 * real markdown blocks between them, and the same for `<sub>` inside a
 * paragraph. An opening tag whose closing half never arrives is left exactly as
 * it was and falls through to text — a malformed body should lose its tag, not
 * the rest of its paragraph.
 */
function fold(children: readonly Node[]): Node[] {
  const out: Node[] = [];
  for (let at = 0; at < children.length; at += 1) {
    const child = children[at] as Node;
    const value = child.type === 'html' ? (child.value ?? '') : '';

    if (/^<br\s*\/?>$/i.test(value)) {
      out.push({ type: 'break' });
      continue;
    }

    const tag = /^<(details|sub|sup|kbd|small|ins|del|b|i|u)(\s[^>]*)?>/i.exec(value)?.[1]?.toLowerCase();
    if (tag === undefined || (tag !== 'details' && !INLINE.has(tag))) {
      out.push(child);
      continue;
    }

    const close = closes(children, at, tag);
    if (close === -1) {
      out.push(child);
      continue;
    }

    const inner = children.slice(at + 1, close) as Node[];
    out.push(tag === 'details' ? disclosure(value, inner) : wrap(tag, inner));
    at = close;
  }
  return out;
}

/**
 * Where this tag's own closing half is.
 *
 * Depth-counted rather than first-match, so a `<details>` inside a `<details>`
 * closes the inner one first — which bots do write, and which a first-match
 * search gets wrong in the direction that swallows the rest of the comment.
 */
function closes(children: readonly Node[], from: number, tag: string): number {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  const shut = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 0;
  for (let at = from; at < children.length; at += 1) {
    const child = children[at] as Node;
    if (child.type !== 'html') continue;
    const value = child.value ?? '';
    depth += (value.match(open) ?? []).length - (value.match(shut) ?? []).length;
    if (at > from && depth <= 0) return at;
  }
  return -1;
}

/**
 * `hName` rather than a node type of our own.
 *
 * `mdast-util-to-hast` drops a type it has no handler for, so a `details` node
 * invented here would delete everything inside it. Borrowing a container that
 * already passes its children through and renaming the element it builds is the
 * documented way to add one, and it keeps the whole path in mdast.
 */
function disclosure(value: string, inner: Node[]): Node {
  const summary = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i.exec(value)?.[1] ?? '';
  return {
    type: 'blockquote',
    data: {
      hName: 'details',
      // `open` is honoured because a bot that asks for one has a reason — it is
      // saying this part is the point. Absent, a disclosure is closed, which is
      // the whole reason its author reached for the tag.
      ...(/<details\s[^>]*\bopen\b/i.test(value) ? { hProperties: { open: true } } : {}),
    },
    children: [
      {
        type: 'paragraph',
        data: { hName: 'summary' },
        children: [{ type: 'text', value: summary.replace(/<[^>]*>/g, '').trim() || 'Details' }],
      },
      ...inner,
    ],
  };
}

/** The same trick for a phrasing tag, on a container that is phrasing. */
const wrap = (tag: string, inner: Node[]): Node => ({
  type: 'emphasis',
  data: { hName: tag },
  children: inner,
});

/**
 * `> [!IMPORTANT]` is a callout, not a line of text saying `[!IMPORTANT]`.
 *
 * GitHub's own extension to blockquotes, and the shape every bot reaches for
 * when it wants the first thing you read to be the point. Unhandled, the marker
 * renders as its own literal paragraph at the top of the quote — which is worse
 * than not supporting it, because it puts a token on screen that means nothing
 * to a reader.
 *
 * The kind goes on the element as data and the stylesheet decides what it looks
 * like, for the reason every other tone here does: a renderer supplies the fact
 * and never the colour.
 */
function readAlert(node: Node): void {
  if (node.type !== 'blockquote' || node.data?.['hName'] !== undefined) return;
  const first = node.children?.[0];
  if (first?.type !== 'paragraph') return;
  const lead = first.children?.[0];
  if (lead?.type !== 'text') return;
  const found = ALERT.exec(lead.value ?? '');
  if (found === null) return;

  lead.value = (lead.value ?? '').slice(found[0].length).replace(/^\n/, '');
  // The marker is usually a paragraph of its own, and an empty one left behind
  // draws as a blank line above the callout's first real sentence.
  if (lead.value === '' && first.children?.length === 1) node.children?.shift();
  node.data = { ...node.data, hProperties: { 'data-alert': (found[1] ?? '').toLowerCase() } };
}

/**
 * The heading a body's `#` is allowed to be.
 *
 * The PR's own title is the `h2` above this card, so a body that opens with a
 * single `#` must not outrank it. Shifted by two and capped at `h6`, which is
 * the same rule the previous renderer had — a document's structure is relative,
 * and the card is two levels down whatever the author thought.
 */
const HEADINGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const;

function heading(level: number) {
  return function Heading({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'h1'> & { node?: unknown }): ReactElement {
    const Tag = HEADINGS[level - 1] ?? 'h6';
    return (
      <Tag {...rest} className="sh-md__heading" data-level={level}>
        {children}
      </Tag>
    );
  };
}

/*
 * `{...rest}` goes FIRST in every component below, and that ordering is load
 * bearing rather than style. remark puts classes and ids of its own on the
 * nodes it builds — `sr-only` on the footnotes label, `task-list-item` on a
 * checkbox's `li` — and spreading them after `className` silently replaces
 * ours, so the element loses every rule this pane wrote for it. It is invisible
 * in a diff and obvious on screen, which is the wrong way round.
 */
const COMPONENTS: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),

  /*
   * A link that reads as a link and does not navigate.
   *
   * This is a pane, not a browser: a click that replaced the app's own document
   * would be unrecoverable, and there is no back. The URL is shown on hover and
   * `Open on GitHub` is the way out of here. `urlTransform` below has already
   * refused anything that is not http(s), so this is the second of two gates
   * rather than the only one.
   */
  a({ children, href, node: _node, ...rest }) {
    return (
      <a {...rest} className="sh-md__link" title={href}>
        {children}
      </a>
    );
  },

  /*
   * An image is its alt text, and never a request.
   *
   * A remote `<img>` in a pane is a GET to whatever host a PR body names, which
   * is a tracking pixel with extra steps — and a body is written by anyone who
   * can open a pull request. The alt text is kept because it is the only part
   * of an image that was ever readable here.
   */
  img({ alt, src }) {
    return (
      <span className="sh-md__image" title={typeof src === 'string' ? src : undefined}>
        {alt === undefined || alt === '' ? 'image' : alt}
      </span>
    );
  },

  /*
   * A table scrolls itself rather than widening the card.
   *
   * Same rule as a code block: a measurements table with a long first column
   * must not push the conversation column sideways, because the column is
   * shared with every review comment under it.
   */
  table({ children, node: _node, ...rest }) {
    return (
      <div className="sh-md__table-scroll">
        <table {...rest} className="sh-md__table">
          {children}
        </table>
      </div>
    );
  },

  /*
   * `data-lang` carries the fence's declared language to the stylesheet.
   *
   * Not highlighted, and that is a decision rather than a gap. A snippet in a
   * PR body has no declared language most of the time, and guessing one paints
   * somebody's log output as if it were source.
   */
  pre({ children, node: _node, ...rest }) {
    return (
      <pre {...rest} className="sh-md__code" data-lang={fenceLanguage(children)}>
        {children}
      </pre>
    );
  },

  /*
   * A task list is a checkbox, drawn and never operable.
   *
   * `disabled` is not styling: this is a rendering of a document on GitHub, and
   * a checkbox that took a click would be a control that changed nothing while
   * looking like it had.
   */
  input({ checked, type, node: _node }) {
    if (type !== 'checkbox') return null;
    return <input className="sh-md__check" type="checkbox" checked={checked === true} disabled readOnly />;
  },
};

/** The `language-ts` class `remark` puts on a fenced block's `<code>`. */
function fenceLanguage(children: ReactNode): string | undefined {
  const only = Array.isArray(children) ? children[0] : children;
  const className = (only as { props?: { className?: unknown } } | null)?.props?.className;
  if (typeof className !== 'string') return undefined;
  const found = /language-(\S+)/.exec(className);
  return found?.[1];
}

/**
 * The only URLs that survive.
 *
 * `javascript:` in an `href` is the one genuinely dangerous thing a body can
 * carry, and a scheme test that names what is ALLOWED cannot be walked around
 * by a scheme nobody thought of. The library's own transform is stricter than
 * it looks but permits relative URLs, which mean nothing in a pane with no
 * document to be relative to.
 */
function onlyHttp(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '';
}

/** A markdown body, as elements. */
export function Markdown({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="sh-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, readHtml]} components={COMPONENTS} urlTransform={onlyHttp}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
