import type { ComponentType } from 'react';
import type { ExtensionRowProps, ExtensionViewProps } from '@shepherd/sdk';
import { TaskCard, TaskComposer } from '@shepherd/ext-tasks/ui';
import { DiagnosticsCard } from '@shepherd/ext-diagnostics/ui';
import { WorktreeHookEditor } from '@shepherd/ext-worktree-hook/ui';

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
};

export function resolveExtensionRowUi(
  component: string | undefined,
): ComponentType<ExtensionRowProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_ROW_UI[component];
}
