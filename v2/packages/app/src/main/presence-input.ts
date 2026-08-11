import type { Presence } from '@shepherd/core';
import type { RootID } from '@shepherd/sdk';

/**
 * What the window tells `ViewingResolver` about itself — the three inputs, in one
 * pure function.
 *
 * It exists because the third input used to be the literal `false`. `Presence`
 * has always carried `overlay` ("a full-takeover overlay hides the terminal") and
 * `api-layout.ts` has promised the clause since M1 — nothing set it, because
 * nothing in the app took over the window until the settings screen did.
 *
 * Pure and separate so the composition is assertable without Electron: ADR 0020
 * allows exactly ONE writer of "is the user looking at this", and the cost of that
 * rule is that the one writer must be provably right. What it decides:
 *
 *   - **Not frontmost app → no focused root.** A switch driven from the CLI while
 *     Shepherd is in the background must not resurrect one, or attention clears on
 *     panes nobody has seen.
 *   - **Settings open → overlay.** An agent that blocks while the user is reading
 *     settings must still notify, and reading settings must not mark a pane seen.
 */
export function presenceFor(input: {
  readonly appActive: boolean;
  readonly activeRoot: RootID;
  readonly settingsOpen: boolean;
}): Presence {
  return {
    appActive: input.appActive,
    focusedRoot: input.appActive ? input.activeRoot : null,
    overlay: input.settingsOpen,
  };
}
