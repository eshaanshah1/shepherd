import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@shepherd/ui';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { ComponentView } from './view-dock.tsx';

/**
 * The modal layer — a contributed component the user *raises*, rather than one
 * that lives in the sidebar (ADR 0033's `surface: 'overlay'`).
 *
 * v1's ⌘T composer is the shape this exists for: a form you open, fill in and
 * dismiss. Parked permanently in a 220px sidebar it takes a third of the list
 * forever; as an overlay it costs nothing until you ask for it.
 *
 * The shell owns the *layer*, never the contents: it raises a `Modal`, binds the
 * accelerator the contribution declared, and closes when the component says
 * `done()`. Which fields the card has is the extension's business, and this file
 * cannot name one.
 *
 * **The scrim, Esc and click-out are `Modal`'s now** — Radix's Dialog, which also
 * brings the four things a hand-rolled layer was silently missing: a focus trap,
 * focus restored to whatever raised it, `inert` on the rest of the page, and a
 * portal so the card cannot be clipped by an ancestor's `overflow: hidden`. What
 * stays here is the part that is app logic rather than modal behaviour: matching
 * an extension's accelerator against the real modifiers, and the `sh:raise-view`
 * event the sidebar button dispatches.
 *
 * **Accelerators are handled here, not in the menu.** A menu key equivalent is
 * consumed by AppKit before the page's key handler runs, so an extension's key
 * in the menu bar would be a key deleted from every terminal in the app — v1's
 * workbench-shortcut lesson, which is also why `ViewRegistry` refuses one with
 * no modifier.
 */

/** Does this keydown match an Electron-style accelerator (`CmdOrCtrl+T`)? */
export function matchesAccelerator(accelerator: string, event: KeyboardEvent): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  const key = parts[parts.length - 1];
  if (key === undefined || event.key.toLowerCase() !== key) return false;

  const wanted = new Set(parts.slice(0, -1));
  const cmdOrCtrl = wanted.has('cmdorctrl') || wanted.has('commandorcontrol');
  // `CmdOrCtrl` is satisfied by EITHER, deliberately: this is the same string
  // Electron resolves per platform, and resolving it differently here would make
  // an extension's key work in the menu and not in the page.
  if (cmdOrCtrl && !(event.metaKey || event.ctrlKey)) return false;
  if ((wanted.has('cmd') || wanted.has('command') || wanted.has('super') || wanted.has('meta')) && !event.metaKey) {
    return false;
  }
  if ((wanted.has('ctrl') || wanted.has('control')) && !event.ctrlKey) return false;
  if ((wanted.has('alt') || wanted.has('option')) && !event.altKey) return false;
  if (wanted.has('shift') !== event.shiftKey) return false;
  return true;
}

export function ViewOverlay({
  views,
  bridge,
}: {
  views: readonly ViewContributionDTO[];
  bridge: ViewsApi | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);

  /**
   * Stable, because `ComponentView` memoizes a contributed component's props on
   * this identity — an inline arrow re-creates its `invoke` on every root render
   * and cancels the asks a card makes on mount.
   */
  const close = useCallback(() => setOpen(null), []);

  const raisable = views.filter((view) => view.kind === 'component' && view.surface === 'overlay');

  useEffect(() => {
    // Esc is deliberately NOT handled here any more. Radix's Dialog closes on it
    // and restores focus on the way out; a second listener would close the same
    // dialog twice and, worse, would keep firing after the modal is gone — which
    // is a global Esc handler the terminal never asked for.
    const onKey = (event: KeyboardEvent): void => {
      for (const view of raisable) {
        if (view.key !== undefined && matchesAccelerator(view.key, event)) {
          // Swallowed, or the keystroke reaches the focused terminal as well and
          // the agent in it receives a stray ⌘T.
          event.preventDefault();
          setOpen((current) => (current === view.type ? null : view.type));
          return;
        }
      }
    };
    /**
     * The same overlay, raised by a click instead of a key.
     *
     * An event rather than a prop drilled down through the sidebar: the button
     * lives in the dock's header and the overlay is a sibling three levels up,
     * and the alternative is threading a setter through two components that
     * have no other reason to know overlays exist.
     */
    const onRaise = (event: Event): void => {
      const type = (event as CustomEvent<string>).detail;
      if (raisable.some((view) => view.type === type)) setOpen(type);
    };
    // Capture: a terminal has focus almost always, and xterm handles keydown on
    // the way down. Without this the accelerator reaches the pty first.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('sh:raise-view', onRaise);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('sh:raise-view', onRaise);
    };
  }, [raisable]);

  const view = raisable.find((candidate) => candidate.type === open);
  if (view === undefined) return null;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      // The view's declared title IS the accessible name. `Modal` draws no
      // header — the composer proved a title bar over a form asking one question
      // is a label for nothing — so this is the only place the dialog says what
      // it is, and Radix would otherwise announce it as "dialog".
      title={view.title ?? view.type}
      // `lg`, because 460px made a brief read as a search box. Recorded in the
      // stylesheet this replaced.
      size="lg"
      data-testid="view-overlay"
      data-view-type={view.type}
    >
      <ComponentView view={view} bridge={bridge} onDone={close} />
    </Modal>
  );
}
