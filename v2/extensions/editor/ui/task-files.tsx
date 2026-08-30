import { useEffect, useState, type ReactElement } from 'react';
import type { ExtensionFaceProps } from '@shepherd/sdk';
import { EditorPane } from './editor-pane.tsx';

/**
 * `tasks.list`, as a literal.
 *
 * The id cannot be imported: `boundaries.js` allows an extension only a
 * TYPE-only import of another extension, because a value import would evaluate
 * that extension's module here. So the string is written out, and the
 * DEPENDENCY that makes the invoke resolve is declared where it belongs — in
 * this extension's manifest (`dependencies: [TASKS_ID, …]`), which §7c says is
 * how reaching another extension is declared rather than discovered.
 */
const TASKS_LIST = 'tasks.list';

/**
 * The **Files** face of a task (ADR 0051): its tree and its editor, over the
 * task's own directory.
 *
 * A wrapper over `EditorPane` rather than a second editor, for the reason ADR
 * 0048 gives for there being one: a file and its diff are one surface under one
 * theme, and a second engine is a second set of keybindings, a second save path
 * and a second answer to "did this file move on disk".
 *
 * The only thing the face adds is resolving the SUBJECT. A pane is opened with
 * its directory already in hand (`view.state`); a face is handed a task, so it
 * asks which directory that task is. `tasks.list` already answers it — `root` on
 * a listed task is the DIRECTORY, and the task root holds every repo's worktree
 * under it, so one editor covers a multi-repo task without the face knowing how
 * many repos there are.
 *
 * Reaching `tasks` is declared, not discovered (§7c): `TASKS_ID` is in this
 * extension's `dependencies`, which is what makes the cross-extension invoke
 * resolve at all.
 */
export function TaskFilesFace({ task, invoke }: ExtensionFaceProps): ReactElement {
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    void invoke(TASKS_LIST, {}).then((answer) => {
      if (!live) return;
      if (!answer.ok || !Array.isArray(answer.value)) {
        setMissing(true);
        return;
      }
      /*
       * Read defensively: this crossed a port and came back as `unknown`, and a
       * cast is not a check. A record with no `root` is a task whose worktrees
       * are on the shelf (ADR 0042) — real, and not an error.
       */
      const found = answer.value.find(
        (each) => typeof each === 'object' && each !== null && (each as { id?: unknown }).id === task.id,
      ) as { root?: unknown } | undefined;
      const root = typeof found?.root === 'string' ? found.root : undefined;
      setDir(root);
      setMissing(root === undefined);
    });
    return () => {
      live = false;
    };
  }, [invoke, task.id]);

  if (dir === undefined) {
    return (
      <div className="sh-face-note">
        {missing ? 'This task has no worktrees on disk — restore it to read its files.' : 'Reading the tree…'}
      </div>
    );
  }

  /*
   * `focused` is TRUE, and it is not a lie by omission: a face is the whole body
   * of the window while it is up, so there is no sibling for a keystroke to
   * belong to instead. `ExtensionFaceProps` deliberately does not carry the flag
   * for that reason, and this is the one place the constant is written down.
   *
   * Nothing else is passed, and nothing else is needed: `EditorSurfaceProps` is
   * the three props this component actually reads, so a face does not have to
   * invent a `paneId` for a leaf that does not exist.
   */
  return <EditorPane state={{ root: dir }} focused invoke={invoke} />;
}
