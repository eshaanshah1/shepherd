import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { EDITOR_COMMANDS } from '../src/manifest.ts';
import type { StatusEntry } from '../src/status.ts';
import { noteIdFromPath, notePath, readNotes, type Note } from '../src/notes.ts';
import { FileEditor } from './file-editor.tsx';

/**
 * `scratch.reveal` — go to the tab holding a note, opening one if it has none.
 *
 * Another extension's command id, written out rather than imported: only TYPES
 * cross between extensions (`boundaries.js`). NOT `scratch.open`, which is the
 * ⌘-click-a-link verb and takes a URL.
 */
const SCRATCH_REVEAL = 'scratch.reveal';

/**
 * What this pane was opened to show.
 *
 * The SUBJECT, never the contents (ADR 0044): a restored editor pane re-lists
 * its tree and re-reads its file from disk. Unsaved buffers are deliberately
 * not persisted — a store of path-less edited text is a document store, and the
 * app has one of those already.
 */
export interface EditorState {
  readonly root: string;
  readonly doc: string | undefined;
}

export function readEditorState(state: unknown): EditorState | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const shape = state as { root?: unknown; doc?: unknown };
  // No root is nothing to list, and an invented one would open the tree on a
  // directory the user never named.
  if (typeof shape.root !== 'string' || shape.root === '') return undefined;
  // The doc is a convenience, not the subject: losing it is not worth losing
  // the pane.
  return { root: shape.root, doc: typeof shape.doc === 'string' ? shape.doc : undefined };
}

export interface Tree {
  readonly paths: readonly string[];
  readonly status: readonly StatusEntry[];
  readonly truncated: boolean;
  /** The scratchpad's live documents, which the `Notes` rows stand for. */
  readonly notes: readonly Note[];
}

const EMPTY_TREE: Tree = { paths: [], status: [], truncated: false, notes: [] };

/** What `editor.tree` answered, read rather than cast: it crossed a port. */
export function readTree(value: unknown): Tree {
  if (typeof value !== 'object' || value === null) return EMPTY_TREE;
  const shape = value as {
    paths?: unknown;
    status?: unknown;
    truncated?: unknown;
    notes?: unknown;
  };
  return {
    paths: Array.isArray(shape.paths)
      ? shape.paths.filter((path): path is string => typeof path === 'string')
      : [],
    status: Array.isArray(shape.status)
      ? shape.status.flatMap((entry): StatusEntry[] => {
          if (typeof entry !== 'object' || entry === null) return [];
          const row = entry as { path?: unknown; status?: unknown };
          return typeof row.path === 'string' && typeof row.status === 'string'
            ? [{ path: row.path, status: row.status as StatusEntry['status'] }]
            : [];
        })
      : [],
    truncated: shape.truncated === true,
    notes: readNotes({ docs: shape.notes }),
  };
}

export function EditorPane({ state, focused, invoke }: ExtensionPaneProps): ReactElement {
  const subject = readEditorState(state);
  const root = subject?.root;

  const [tree, setTree] = useState<Tree>(EMPTY_TREE);
  const [at, setAt] = useState<string | undefined>(subject?.doc);

  const refresh = useCallback(async () => {
    if (root === undefined) return;
    const answer = await invoke(EDITOR_COMMANDS.tree, { root });
    if (answer.ok) setTree(readTree(answer.value));
  }, [invoke, root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const paths = tree.paths;

  /*
   * Pierre's tree, not a list of buttons. `compact` is the package's own density
   * preset, and asking for it is the supported way: that value is written INLINE
   * on the host from this option, so a `--trees-item-height` in the app's
   * stylesheet is silently outranked.
   */
  const { model } = useFileTree({ paths, density: 'compact' });
  const selected = useFileTreeSelection(model);
  const search = useFileTreeSearch(model);

  /*
   * The tree is TOLD its paths; it does not watch them.
   *
   * `useFileTree` is `useState(() => new FileTree(options))` — the options are
   * read once, at construction, and never again. Every path in this pane
   * arrives from a command one tick after mount, so the model is built empty
   * and, without this, stays empty forever: `editor.tree` answered 829 paths
   * and the rail drew nothing. `resetPaths` is the package's own answer, and
   * the reason it exists.
   *
   * `github`'s Files tab gets away with the plain option because a PR's file
   * list is already on the record when that panel mounts — which is why
   * copying its call site was not enough here.
   */
  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  /*
   * The marks are the PACKAGE's own: `setGitStatus` is how a row learns it is
   * modified, and drawing ours beside it would be two vocabularies for one fact.
   */
  useEffect(() => {
    model.setGitStatus(tree.status);
  }, [model, tree.status]);

  useEffect(() => {
    const first = selected[0];
    if (first === undefined) return;
    const note = noteIdFromPath(first, tree.notes);
    if (note !== undefined) {
      /*
       * A note opens as its OWN tab, not inside this pane.
       *
       * The boundary lint forbids importing scratch's `ui/`, and the
       * restriction is the honest design: a note is its own place, not a file
       * in a repo that happens to have no path.
       */
      void invoke(SCRATCH_REVEAL, { id: note });
      return;
    }
    setAt(first);
  }, [selected, tree.notes, invoke]);

  /*
   * The search session has to be OPENED before it filters — it is a session,
   * not a value — so the field opens it on the first keystroke and closes it
   * when emptied, which is what makes an empty field mean "no filter" rather
   * than "a filter matching everything".
   */
  const field = useRef<HTMLInputElement | null>(null);
  const onQuery = useCallback(
    (value: string) => {
      if (value === '') {
        search.close();
        return;
      }
      if (!search.isOpen) search.open(value);
      else search.setValue(value);
    },
    [search],
  );

  if (subject === undefined) {
    return <div className="sh-editor sh-editor--none">This pane has no directory to open.</div>;
  }

  return (
    <div className="sh-editor">
      <div className="sh-editor__rail">
        <input
          ref={field}
          className="sh-editor__search"
          type="search"
          placeholder="Filter files"
          aria-label="Filter files"
          onChange={(event) => onQuery(event.target.value)}
        />
        <FileTree className="sh-editor__tree" model={model} />
        {tree.truncated ? (
          /*
           * A truncated listing that does not announce itself reads as a
           * complete one, and the file you wanted is absent with no explanation.
           */
          <p className="sh-editor__truncated">
            Too many files to list them all — open this pane on a smaller directory.
          </p>
        ) : null}
      </div>
      <div className="sh-editor__panel">
        {at === undefined ? (
          <p className="sh-editor__empty">Pick a file.</p>
        ) : (
          <FileEditor
            root={subject.root}
            path={at}
            focused={focused}
            invoke={invoke}
            onSaved={refresh}
          />
        )}
      </div>
    </div>
  );
}
