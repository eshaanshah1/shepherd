import { useEffect, useRef, useState, type ReactElement } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { SCRATCH_COMMANDS } from '../src/manifest.ts';
import { scratchExtensions } from './editor.ts';

/** The layout store's number, so the app has one save cadence rather than two. */
export const SAVE_DEBOUNCE_MS = 400;


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

export function ScratchPane({ state, invoke }: ExtensionPaneProps): ReactElement {
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

    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending === null) return;
      const text = pending;
      pending = null;
      void latestInvoke.current(SCRATCH_COMMANDS.write, { id, text });
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
  }, [id]);



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
