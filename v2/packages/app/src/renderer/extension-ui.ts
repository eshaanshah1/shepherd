import type { ComponentType } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';
import { TaskComposer } from '@shepherd/ext-tasks/ui';
import { DiagnosticsCard } from '@shepherd/ext-diagnostics/ui';

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
};

export function resolveExtensionUi(component: string | undefined): ComponentType<ExtensionViewProps> | undefined {
  if (component === undefined) return undefined;
  return EXTENSION_UI[component];
}
