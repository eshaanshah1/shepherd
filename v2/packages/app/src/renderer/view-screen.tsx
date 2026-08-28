import { useCallback, useEffect, useState } from 'react';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { ComponentView } from './view-dock.tsx';
import { matchesAccelerator } from './view-overlay.tsx';

/**
 * The takeover layer — a contributed component that covers the STAGE.
 *
 * The fourth surface, after the dock section, the overlay and the pane, and the
 * one that exists because a card is a claim about size. `surface: 'overlay'`
 * says "this is small enough to float over your work"; the composer stopped
 * being that the moment it had to carry a model, a repo scope, a placement and a
 * profile, and a modal grown to fill the window is a window with a border drawn
 * round the middle of it.
 *
 * Settings is the shape this generalizes. It took the window over from inside
 * the shell (ADR 0040) because there was nowhere to declare a takeover; this is
 * that clause landing, and the composer is the second consumer a new
 * contribution point has to have before it is worth existing (ADR 0049).
 *
 * Three things it does NOT do, and each is the interesting half:
 *
 *   - **It does not cover the rail.** `SettingsScreen` does, because settings
 *     are a departure from the work. Composing is the start of it, and what is
 *     already running is the context you compose against — the flock is how you
 *     notice the task you are about to write is the one running in tab two.
 *   - **It does not unmount the roots.** It is painted over `.sh-stage`, which
 *     keeps every pane in the tree mounted and every pty attached. A conditional
 *     mount around the stage is v1's `_ConditionalContent` lesson: a torn-down
 *     pane is a released terminal and then, on the way back, a second pty.
 *   - **It does not stack.** One `open` for the whole layer, so raising a screen
 *     closes any other. Two takeovers on one stage is a state with no way out
 *     that the user can see, and nothing about a screen suggests a depth.
 */
export function ViewScreen({
  views,
  bridge,
}: {
  views: readonly ViewContributionDTO[];
  bridge: ViewsApi | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);

  /**
   * Stable, for the reason `ViewOverlay`'s is: `ComponentView` memoizes a
   * contributed component's props on this identity, and an inline arrow
   * re-creates `invoke` on every root render — which cancels the asks the
   * component makes on mount. The composer asks for its repos and its models
   * there, so the unstable version showed an empty menu.
   */
  const close = useCallback(() => setOpen(null), []);

  const screens = views.filter((view) => view.kind === 'component' && view.surface === 'screen');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      /*
       * Esc closes, and it is OURS to handle — unlike the overlay's, which is
       * Radix's. There is no Dialog here, so nothing else is listening.
       *
       * Guarded on the layer being open rather than registered unconditionally:
       * a global Esc handler that runs while no screen is up is a key deleted
       * from every terminal in the app, which is the same lesson the
       * accelerator guard below is written from.
       */
      if (event.key === 'Escape' && open !== null) {
        event.preventDefault();
        // Stopped, or the terminal underneath also receives the Escape and the
        // agent in it takes a stray cancel for a takeover it never saw.
        event.stopPropagation();
        close();
        return;
      }
      for (const view of screens) {
        if (view.key !== undefined && matchesAccelerator(view.key, event)) {
          event.preventDefault();
          // Toggling rather than raising: the same key that opened it closes it,
          // which is the gesture every other layer in the app already has.
          setOpen((current) => (current === view.type ? null : view.type));
          return;
        }
      }
    };
    /** The same screen, raised by a click. `ViewOverlay` documents the event. */
    const onRaise = (event: Event): void => {
      const type = (event as CustomEvent<string>).detail;
      if (screens.some((view) => view.type === type)) setOpen(type);
    };
    // Capture, for the reason every accelerator in this app is: a terminal has
    // focus almost always and xterm handles keydown on the way down, so without
    // this the keystroke reaches the pty first.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('sh:raise-view', onRaise);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('sh:raise-view', onRaise);
    };
  }, [screens, open, close]);

  const view = screens.find((candidate) => candidate.type === open);
  if (view === undefined) return null;

  return (
    <div
      className="sh-screen"
      /*
       * A dialog rather than a region: it takes the stage over and the rest of
       * it is not reachable while it is up, which is the thing `role` has to
       * say for anyone who cannot see that it happened.
       */
      role="dialog"
      aria-modal="true"
      aria-label={view.title ?? view.type}
      data-testid="view-screen"
      data-view-type={view.type}
    >
      <ComponentView view={view} bridge={bridge} onDone={close} />
    </div>
  );
}
