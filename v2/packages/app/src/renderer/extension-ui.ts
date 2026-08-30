import type { ComponentType } from 'react';
import type { ExtensionFaceProps, ExtensionPaneProps, ExtensionRowProps, ExtensionViewProps } from '@shepherd/sdk';
import { SessionSearchView, TaskCard, TaskComposer, TaskIntentFace, TranscriptCountRow } from '@shepherd/ext-tasks/ui';
import { DiagnosticsCard } from '@shepherd/ext-diagnostics/ui';
import { WorktreeHookEditor } from '@shepherd/ext-worktree-hook/ui';
import { EditorPane, TaskFilesFace } from '@shepherd/ext-editor/ui';
import { ReviewPane, TaskDiffFace } from '@shepherd/ext-github/ui';
import { ScratchPane } from '@shepherd/ext-scratch/ui';

/**
 * The in-proc React seam (§7b, ADR 0033): the one place a contributed view's
 * NAME becomes a component.
 *
 * An extension declares `{ kind: 'component', component: 'tasks.composer' }`
 * from its service half, in a utility process with no DOM. What crosses the
 * port is that string. This table is where it lands — and it is a **static**
 * table on purpose:
 *
 *   - The renderer bundle is built ahead of time, so a built-in's UI is code
 *     the build can see. A third-party extension's UI needs a loader (fetching
 *     a module at runtime, per-extension), which is a real piece of work and is
 *     not implied by this one. §7's graduation rule wants built-ins to be the
 *     proving ground first, and this is what that looks like.
 *   - A name that is not in here draws nothing. That is the correct failure: an
 *     extension can ask for a module, it cannot supply one, so it cannot reach
 *     the page with code the build never saw.
 *
 * Each import is a `/ui` subpath, never an extension's root — `boundaries.js`
 * enforces it. The root is the service half, and importing it here would run
 * `activate`'s imports inside the renderer, which is the process separation
 * §7b bought undone in one line.
 */
export const EXTENSION_UI: Readonly<Record<string, ComponentType<ExtensionViewProps>>> = {
  'tasks.composer': TaskComposer,
  'tasks.sessionSearch': SessionSearchView,
  'diagnostics.card': DiagnosticsCard,
  'worktree-hook.editor': WorktreeHookEditor,
};

export function resolveExtensionUi(component: string | undefined): ComponentType<ExtensionViewProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_UI[component];
}

/**
 * The same seam, one level down: a contributed ROW's name → its component.
 *
 * A separate table from `EXTENSION_UI` because the two have different props and
 * different lifetimes. A view owns a panel and reports when it is finished; a
 * row owns one entry in the shell's own list and never is. One table typed as
 * their union would make every consumer narrow before it could render.
 *
 * The failure mode is deliberately gentler than a view's. An unknown view name
 * draws a "this build has no UI for that" notice, because a docked panel that
 * silently vanished would look like a broken feature. An unknown ROW name draws
 * the ORDINARY row — it still says what it stands for, it is still clickable,
 * and it is missing only its richer form. A rail that dropped rows on a version
 * skew would lose the list the app exists to show.
 */
export const EXTENSION_ROW_UI: Readonly<Record<string, ComponentType<ExtensionRowProps>>> = {
  'tasks.card': TaskCard,
  'tasks.transcriptCount': TranscriptCountRow,
};

export function resolveExtensionRowUi(
  component: string | undefined,
): ComponentType<ExtensionRowProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_ROW_UI[component];
}

/**
 * The same seam again, for a component that is a PANE (ADR 0044).
 *
 * A third table for the reason there is a second: different props. A pane view
 * is handed the subject it was opened for and whether the user is on it, and
 * neither means anything to a dock section — so `EXTENSION_UI` cannot hold it
 * without every docked component being typed for fields it will never receive.
 *
 * Its failure mode sits between the other two, because a pane is a place the
 * user navigated to. An unknown name here draws a notice inside the pane (like a
 * view, not like a row): the pane exists, it is focusable, closable and in the
 * tab strip, so something has to be in it — and an empty rectangle where a PR
 * list should be says nothing about why.
 */
export const EXTENSION_PANE_UI: Readonly<Record<string, ComponentType<ExtensionPaneProps>>> = {
  'editor.workspace': EditorPane,
  'github.review': ReviewPane,
  'scratch.pad': ScratchPane,
};

export function resolveExtensionPaneUi(
  component: string | undefined,
): ComponentType<ExtensionPaneProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_PANE_UI[component];
}

/**
 * The fourth table: a component that is a FACE of a task (ADR 0051).
 *
 * A fourth for the reason there is a third — different props, and the
 * differences are the design rather than an inconvenience. A face is handed the
 * SUBJECT the window is already showing and nothing else: no `paneId`, because
 * there is no leaf; no `state`, because it did not mint a subject when it
 * opened; no `focused`, because a face is the whole body of the window and has
 * no sibling to lose a keystroke to.
 *
 * That is exactly why a face could not be squeezed into `EXTENSION_PANE_UI`: it
 * would have needed a `Pane` the layout does not have, and every verb the view
 * invoked about "its" pane would have missed a leaf that was never there.
 *
 * Its failure mode is the pane's: an unknown name draws a notice inside the
 * face, because the tab exists and something has to be under it. But the tab
 * only exists because an extension CLAIMED the slot — so the ordinary way to
 * have no Diff is to have no `github`, and then there is no tab at all.
 *
 * This is the "document-surface contribution point" ADR 0049 deferred until a
 * SECOND consumer bought it. The takeover is that consumer, and there are three
 * of them here.
 */
export const EXTENSION_FACE_UI: Readonly<Record<string, ComponentType<ExtensionFaceProps>>> = {
  'github.taskDiff': TaskDiffFace,
  'tasks.intent': TaskIntentFace,
  'editor.taskFiles': TaskFilesFace,
};

export function resolveExtensionFaceUi(
  component: string | undefined,
): ComponentType<ExtensionFaceProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_FACE_UI[component];
}
