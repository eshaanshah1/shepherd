import { useEffect, useRef, useState, type ReactElement } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { SCRATCH_COMMANDS } from '../src/manifest.ts';
import { scratchExtensions } from './editor.ts';

/** The layout store's number, so the app has one save cadence rather than two. */
export const SAVE_DEBOUNCE_MS = 400;

/**
 * `layout.rename`, named here rather than imported: values do not cross between
 * packages (`boundaries.js`), so a command id is re-stated and only types
 * travel. The same convention the service half follows for `layout.newTab`.
 */
const LAYOUT_RENAME = 'layout.rename';

export function readScratchId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const id = (state as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Roughly, and roughly is right — it goes in a sentence, not a status bar. */
export function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words === null ? 0 : words.length;
}

/** What the tab strip calls a pane with nothing to name it. */
export const FALLBACK_TITLE = 'scratch';

/** Long enough to be a name, short enough that a tab stays a tab. */
const TITLE_MAX = 40;

/**
 * The tab's name, taken from a leading heading.
 *
 * The FIRST non-empty line, and only if it is an ATX heading. Not the first line
 * of prose: a paragraph's opening words are a sentence fragment, and a strip of
 * those reads worse than a strip of `scratch` because each one looks like it
 * might be a name. A heading is the one thing in the document the writer
 * deliberately made a label.
 *
 * Leading blank lines are skipped because people leave them, and a document that
 * opens with a blank line has still been given a heading.
 *
 * `undefined` means "nothing here is a name" — the caller falls back rather than
 * this function inventing one, so there is one place the fallback is decided.
 */
export function headingTitle(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    // 1 to 6 hashes, then whitespace, then something. `#foo` is not a heading in
    // CommonMark and must not become one here.
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading === null) return undefined;
    // A closed ATX heading ends in its own hashes: `# Title #`. They are syntax.
    const inner = (heading[2] ?? '').replace(/\s+#+\s*$/, '').trim();
    if (inner === '') return undefined;
    return inner.length > TITLE_MAX ? `${inner.slice(0, TITLE_MAX - 1).trimEnd()}…` : inner;
  }
  return undefined;
}

export function ScratchPane({ state, paneId, invoke }: ExtensionPaneProps): ReactElement {
  const id = readScratchId(state);
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * `invoke` through a ref, and the editor mounted ONCE per buffer id.
   *
   * `ExtensionPane` memoizes a pane's props on `view.state` among other things,
   * and `view.state` is rebuilt from the layout snapshot on every push — so its
   * identity changes constantly even though `{ id }` never does. With `invoke`
   * in the dependency array the effect re-ran on each push, destroying the
   * EditorView and building a new one from the last SAVED text. Measured at
   * launch: four mounts before anybody had typed a character, and mid-typing it
   * would have discarded everything inside the save debounce.
   *
   * The id is the only thing this effect actually depends on. Everything else
   * it needs is read at call time.
   */
  const latestInvoke = useRef(invoke);
  latestInvoke.current = invoke;

  useEffect(() => {
    const element = host.current;
    if (id === undefined || element === null) return;

    /** The text not yet written, and the timer that will write it. */
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;

    /*
     * The name the tab is currently wearing, so a rename only goes out when the
     * heading actually CHANGES. Without this every save would rename the pane,
     * and a rename writes the layout — which is the debounced whole-tree
     * re-encode this component already goes out of its way not to trigger per
     * keystroke.
     */
    let titled: string | null = null;

    const retitle = (text: string): void => {
      const next = headingTitle(text) ?? FALLBACK_TITLE;
      if (next === titled) return;
      titled = next;
      void latestInvoke.current(LAYOUT_RENAME, { pane: paneId, title: next });
    };

    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending === null) return;
      const text = pending;
      pending = null;
      void latestInvoke.current(SCRATCH_COMMANDS.write, { id, text });
      retitle(text);
    };

    const schedule = (next: string): void => {
      pending = next;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    };

    void (async () => {
      const read = await latestInvoke.current(SCRATCH_COMMANDS.read, { id });
      if (!live) return;
      if (!read.ok) setProblem('could not read this scratch');
      const doc = read.ok ? ((read.value as { text?: string }).text ?? '') : '';
      /*
       * On mount too, not only on edit: a pane restored from a layout carries
       * whatever name it was last given, so a buffer whose heading changed
       * elsewhere — or whose heading this build learned to read — would keep a
       * stale name until the next keystroke.
       */
      retitle(doc);

      view.current = new EditorView({
        state: EditorState.create({
          doc,
          extensions: scratchExtensions({
            onChange: schedule,
            onLinkClick: (url) => void latestInvoke.current(SCRATCH_COMMANDS.open, { url }),
          }),
        }),
        parent: element,
      });
    })();

    /*
     * Flushed on the way out of the WINDOW too. A quit is not an unmount, and
     * `beforeunload` is the only thing that fires for one.
     */
    window.addEventListener('beforeunload', flush);
    window.addEventListener('blur', flush);

    return () => {
      live = false;
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('blur', flush);
      flush();
      view.current?.destroy();
      view.current = null;
    };
  }, [id, paneId]);



  if (id === undefined) {
    /*
     * A pane is a PLACE the user navigated to, so an empty rectangle where a
     * document should be says nothing about why. This is the same reasoning
     * `ExtensionPane` gives for its own two notices.
     */
    return (
      <div className="sh-scratch sh-scratch--empty">
        <p>This scratch pane has no buffer. It was restored from a layout that did not record one.</p>
      </div>
    );
  }

  return (
    <div className="sh-scratch">
      {problem === null ? null : <p className="sh-scratch-problem">{problem}</p>}
      <div className="sh-scratch-host" ref={host} />
    </div>
  );
}
