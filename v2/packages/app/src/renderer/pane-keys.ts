import { useEffect } from 'react';
import type { ViewContributionDTO } from '../shared/index.ts';
import { matchesAccelerator } from './view-overlay.tsx';

/**
 * Accelerators for contributed PANES — the job `view-overlay.tsx` does for
 * overlays, and deliberately the same predicate, so `CmdOrCtrl` cannot resolve
 * one way for a pane and another way for a card.
 *
 * It is a separate handler rather than a branch inside that one because the two
 * do different things with a match. An overlay TOGGLES a layer this process
 * owns, which needs no verb. A pane RUNS A VERB and the extension decides what
 * appears — because opening a pane usually means minting the subject it will
 * show first, and nothing can rewrite a pane's `view.state` afterwards. One
 * handler doing both would branch on `surface` at every line.
 *
 * **None of these keys may be added to `menu-template.ts`.** AppKit resolves a
 * menu key equivalent before the page sees the keystroke, so a menu item on one
 * of these keys does not compete with it — it deletes it, silently.
 */
export function PaneKeys({
  views,
  invoke,
}: {
  readonly views: readonly ViewContributionDTO[];
  invoke(command: string, args?: unknown): void;
}): null {
  useEffect(() => {
    const bound = views.filter(
      (view) => view.surface === 'pane' && view.key !== undefined && view.command !== undefined,
    );
    if (bound.length === 0) return;

    const onKey = (event: KeyboardEvent): void => {
      for (const view of bound) {
        if (view.key === undefined || view.command === undefined) continue;
        if (!matchesAccelerator(view.key, event)) continue;
        // Swallowed, or the keystroke also reaches the focused terminal and the
        // agent in it receives a stray one.
        event.preventDefault();
        invoke(view.command);
        return;
      }
    };

    // Capture, for the reason the overlay's handler uses it: a terminal has
    // focus almost always, and xterm handles keydown on the way down.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [views, invoke]);

  return null;
}
