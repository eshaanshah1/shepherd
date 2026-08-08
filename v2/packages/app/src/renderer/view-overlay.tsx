import { useEffect, useState } from 'react';
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
 * The shell owns the *layer*, never the contents: it draws a scrim, a card and
 * a heading, binds the accelerator the contribution declared, and closes on Esc,
 * on a click outside, or when the component says `done()`. Which fields the
 * card has is the extension's business, and this file cannot name one.
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

  const raisable = views.filter((view) => view.kind === 'component' && view.surface === 'overlay');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(null);
        return;
      }
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
    <div
      className="sh-scrim"
      data-testid="view-overlay"
      onMouseDown={(event) => {
        // Only a click on the scrim itself — a mousedown that started inside the
        // card and ended outside it (a text drag) must not dismiss the form.
        if (event.target === event.currentTarget) setOpen(null);
      }}
    >
      <div className="sh-modal" data-view-type={view.type}>
        <ComponentView view={view} bridge={bridge} onDone={() => setOpen(null)} />
      </div>
    </div>
  );
}
