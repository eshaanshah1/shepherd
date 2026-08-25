import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import { Editor } from '@pierre/diffs/edit';
import type { FileContents } from '@pierre/diffs';
import { EDITOR_COMMANDS } from '../src/manifest.ts';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_THEME } from './diff-theme.ts';

/** The stamp `editor.read` handed out, and `editor.write` checks against. */
export interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * What a save answered.
 *
 * Its own pure function because it is the one branch worth asserting without a
 * DOM. `stale` is not an error the user caused, and reporting it as one
 * ("could not save") loses the only useful part — that somebody else's version
 * is on disk and can be reloaded.
 */
export function saveOutcome(answer: unknown): 'saved' | 'stale' | string {
  if (typeof answer !== 'object' || answer === null) return 'could not save';
  const shape = answer as { stamp?: unknown; reason?: unknown };
  if (typeof shape.stamp === 'object' && shape.stamp !== null) return 'saved';
  if (typeof shape.reason === 'string') return shape.reason === 'stale' ? 'stale' : shape.reason;
  return 'could not save';
}

/** What `editor.read` answered, read rather than cast: it crossed a port. */
export function readDoc(value: unknown): { text: string; stamp: Stamp } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const shape = value as { text?: unknown; stamp?: unknown };
  if (typeof shape.text !== 'string') return undefined;
  const stamp = shape.stamp as { mtimeMs?: unknown; size?: unknown } | undefined;
  if (typeof stamp?.mtimeMs !== 'number' || typeof stamp.size !== 'number') return undefined;
  return { text: shape.text, stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size } };
}

/** The prose a refusal becomes. Separated so a test can read it. */
export function saveNote(outcome: 'saved' | 'stale' | string): string | undefined {
  if (outcome === 'saved') return undefined;
  return outcome === 'stale'
    ? 'This file changed on disk. Your edits are still here — reload to see the other version.'
    : outcome;
}

type Invoke = (
  command: string,
  args?: unknown,
) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }>;

export interface FileEditorProps {
  readonly root: string;
  readonly path: string;
  readonly focused: boolean;
  readonly invoke: Invoke;
  onSaved(): void;
}

export function FileEditor({
  root,
  path,
  focused,
  invoke,
  onSaved,
}: FileEditorProps): ReactElement {
  const [doc, setDoc] = useState<{ text: string; stamp: Stamp } | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  /* The live buffer, in a ref: it changes on every keystroke and nothing renders from it. */
  const buffer = useRef('');
  const stamp = useRef<Stamp>({ mtimeMs: 0, size: 0 });

  const load = useCallback(async () => {
    const answer = await invoke(EDITOR_COMMANDS.read, { root, path });
    const read = answer.ok ? readDoc(answer.value) : undefined;
    if (read === undefined) {
      setDoc(undefined);
      setNote('Could not read this file.');
      return;
    }
    buffer.current = read.text;
    stamp.current = read.stamp;
    setDoc(read);
    setDirty(false);
    setNote(undefined);
  }, [invoke, root, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const answer = await invoke(EDITOR_COMMANDS.write, {
      root,
      path,
      text: buffer.current,
      stamp: stamp.current,
    });
    const value = answer.ok ? answer.value : undefined;
    const outcome = saveOutcome(value);
    if (outcome === 'saved') {
      const fresh = (value as { stamp: Stamp }).stamp;
      stamp.current = fresh;
      setDirty(false);
      setNote(undefined);
      onSaved();
      return;
    }
    setNote(saveNote(outcome));
  }, [invoke, root, path, onSaved]);

  /*
   * ⌘S, and only while this pane is FOCUSED (ADR 0044): a background pane that
   * still answered the key would fight the one you are looking at.
   *
   * **Not autosave.** `scratch` debounces at 400ms and t3code's
   * `fileSaveCoordinator` does the same, and both are right for what they hold —
   * but an AGENT is editing these files while you are, and a debounced write
   * would overwrite its work without either of you seeing it happen. The
   * stale-stamp refusal is the other half of that decision.
   */
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, save]);

  /*
   * The editor factory the nearest provider hands to `<File edit>`.
   *
   * `EditProvider` takes a FACTORY rather than an instance — the component owns
   * the lifecycle and calls this with the `editorOptions` below merged in. It
   * is memoised because a new function per render is a new provider value, and
   * this is the same class of mistake the workbench recorded in v1: an
   * identity-compared collaborator rebuilt in `body` re-runs setup on every
   * scroll tick.
   */
  const createEditor = useMemo(
    () =>
      (options: ConstructorParameters<typeof Editor<undefined>>[0]): Editor<undefined> =>
        new Editor<undefined>(options),
    [],
  );

  const file = useMemo<FileContents | undefined>(
    () =>
      doc === undefined
        ? undefined
        : {
            name: path,
            contents: doc.text,
            /*
             * Unique and stable per file, which `persistState` REQUIRES. The
             * stamp is in it so a reload after an outside edit is a different
             * document rather than the same one with new bytes.
             */
            cacheKey: `${root}:${path}:${doc.stamp.mtimeMs}:${doc.stamp.size}`,
          },
    [doc, root, path],
  );

  if (file === undefined) {
    return <p className="sh-editor__empty">{note ?? 'Loading…'}</p>;
  }

  return (
    <div className="sh-editor__file">
      <header className="sh-editor__file-head">
        <span className="sh-editor__file-path">{path}</span>
        {dirty ? (
          <span className="sh-editor__dirty" title="unsaved" aria-label="unsaved">
            ●
          </span>
        ) : null}
      </header>
      {note === undefined ? null : (
        <p className="sh-editor__note" role="status">
          {note}{' '}
          <button type="button" onClick={() => void load()}>
            Reload
          </button>
        </p>
      )}
      <EditProvider<undefined> createEditor={createEditor}>
        <Virtualizer className="sh-editor__scroll">
          <File<undefined>
            file={file}
            /*
             * `edit`, not `contentEditable`: renamed in @pierre/diffs 1.3.5,
             * with creation-time configuration moved to `editorOptions`.
             * t3code pins 1.3.0-beta.10 and still uses the old name.
             */
            edit
            editorOptions={{
              persistState: true,
              onChange: (changed) => {
                buffer.current = changed.contents;
                setDirty(true);
              },
            }}
            options={{
              // The pane's own header already names the file.
              disableFileHeader: true,
              theme: SHEPHERD_DIFF_THEME,
              unsafeCSS: SHEPHERD_DIFF_CSS,
              overflow: 'scroll',
            }}
          />
        </Virtualizer>
      </EditProvider>
    </div>
  );
}
