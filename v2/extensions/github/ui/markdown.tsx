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
 * raw HTML renders as text, links do not navigate, and images do not load.
 */

/**
 * Raw HTML in a body renders as TEXT.
 *
 * remark parses `<script>` into an `html` node, and the only shipped way to
 * render one is `rehype-raw`, which parses it as real markup — so the library's
 * default is to drop it in silence. Neither is right here. Dropping it deletes
 * whatever sentence the tag was in, and a PR body that says "wrap it in
 * `<details>`" is a normal thing for an agent to write.
 *
 * Rewriting the node to `text` in mdast, before `remark-rehype` ever sees it,
 * gets the third answer: a body containing `<script>` is a body that SAYS
 * `<script>`, with no sanitiser anywhere, because nothing was ever markup.
 */
function htmlAsText() {
  return (tree: { children?: unknown[] }): void => {
    const walk = (node: { type?: string; value?: string; children?: unknown[] }): void => {
      if (node.type === 'html') {
        node.type = 'text';
        return;
      }
      for (const child of node.children ?? []) walk(child as { type?: string; children?: unknown[] });
    };
    walk(tree);
  };
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
      <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} components={COMPONENTS} urlTransform={onlyHttp}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
