import { Autolink, Strikethrough, TaskList, parser as baseParser, type MarkdownExtension } from '@lezer/markdown';
import type { Tree } from '@lezer/common';

/**
 * The construct set, expressed as an import list.
 *
 * `@lezer/markdown` ships GFM as separately importable extensions, so "simple
 * markdown, no tables" is not a filter that runs at render time — `Table` is
 * simply absent, and a table is therefore a paragraph. That is the honest
 * behaviour for a pane whose job is partly holding pasted text: a construct we
 * do not render should look like the characters that were typed, not like
 * something that was recognised and then suppressed.
 *
 * `Autolink` is here because a pasted URL is the single most likely thing to
 * land in a scratch pane, and typing `[](…)` around one is exactly the ceremony
 * this pane exists to avoid.
 *
 * **DO NOT ADD `Table`**, and do not reach for the `GFM` bundle, which is all
 * six of them at once — `Table`, `Emoji`, `Subscript` and `Superscript`
 * included. `markdown-parser.test.ts` asserts every one of those absences.
 */
export const scratchMarkdown: MarkdownExtension[] = [Strikethrough, TaskList, Autolink];

/** The configured parser, for CodeMirror's markdown language to be built on. */
export const scratchMarkdownParser = baseParser.configure(scratchMarkdown);

/** Parse outside a CodeMirror instance — tests, and nothing else so far. */
export function parse(text: string): Tree {
  return scratchMarkdownParser.parse(text);
}
