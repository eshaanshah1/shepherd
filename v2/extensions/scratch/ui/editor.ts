import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { scratchMarkdown } from './markdown-parser.ts';
import { livePreview } from './live-preview.ts';
import { frontmatter } from './frontmatter.ts';
import { scratchTheme } from './theme.ts';
import { toggleAt } from './checkbox-widget.ts';

/** Only these two schemes ever reach `open(1)`. The service half agrees. */
export function openable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** The URL a decorated link at `pos` points at, read from the document text. */
export function urlAt(doc: string, lineFrom: number, pos: number): string | undefined {
  const inline = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
  for (const match of doc.matchAll(inline)) {
    const from = lineFrom + (match.index ?? 0);
    if (pos >= from && pos <= from + match[0].length) return match[1];
  }
  const bare = /https?:\/\/\S+/g;
  for (const match of doc.matchAll(bare)) {
    const from = lineFrom + (match.index ?? 0);
    if (pos >= from && pos <= from + match[0].length) return match[0];
  }
  return undefined;
}

export function scratchExtensions(options: {
  onChange(text: string): void;
  onLinkClick(url: string): void;
}): Extension[] {
  return [
    markdown({ extensions: scratchMarkdown }),
    /*
     * CodeMirror's own history. Whether ⌘Z ever REACHES it is a separate
     * problem: the Edit menu's `role: 'undo'` is an AppKit key equivalent that
     * calls `webContents.undo()`, the browser's document undo, which knows
     * nothing about this. That is fixed where it lives, in the menu.
     */
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    livePreview,
    /*
     * AFTER `livePreview`, and the order is load-bearing.
     *
     * Lezer reads the opening `---` as a thematic break, so `livePreview` replaces
     * it with a drawn rule. This extension collapses the whole line instead, and a
     * later extension's decorations win — so the fence disappears rather than
     * becoming a hairline followed by two more of them.
     */
    frontmatter,
    scratchTheme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        const target = event.target as HTMLElement | null;
        if (target === null) return false;

        if (target.classList.contains('sh-scratch-check')) {
          const line = view.state.doc.lineAt(view.posAtDOM(target));
          const marker = line.text.indexOf('[');
          if (marker >= 0) toggleAt(view, line.from + marker + 1);
          return true;
        }

        /*
         * ⌘-click opens; a plain click places the caret, which reveals the raw
         * `[text](url)` and is therefore how you EDIT the link. Plain-click-to-
         * open would fight the primary meaning of clicking text in an editor,
         * and would make a link uneditable.
         */
        if (!(event.metaKey || event.ctrlKey)) return false;
        if (!target.classList.contains('sh-scratch-link')) return false;
        const pos = view.posAtDOM(target);
        const line = view.state.doc.lineAt(pos);
        const url = urlAt(line.text, line.from, pos);
        if (url === undefined || !openable(url)) return false;
        options.onLinkClick(url);
        return true;
      },
    }),
  ];
}
