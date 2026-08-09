/**
 * One pty has one size. No architecture changes that — mosh does not, tmux does
 * not, and neither does R0. What R0 changes is that the arbitration becomes an
 * explicit, testable decision instead of "whoever called `resize` last wins".
 *
 * v1 dodged the question by allowing a single active viewer ("last attach takes
 * over; the prior viewer drops to attached-elsewhere"). Once the phone and the
 * Mac can watch one session at the same time, that answer is not available, so:
 *
 *   - **A viewer with no opinion never influences the size.** That is v1's
 *     "viewer-not-resizer", which was already right: an extension tapping the
 *     stream, or a phone showing a pane it is not driving, must not reshape the
 *     pty under the person typing into it.
 *
 *   - **Among those with an opinion, the SMALLEST of each dimension wins.** A
 *     size larger than a viewer's window is content that viewer cannot see, and
 *     letterboxing the big screen beats clipping the small one. This is tmux's
 *     answer, and it is the correct one for the multi-viewer case.
 *
 *   - **A sole viewer is trivially the smallest**, so the local-only case
 *     behaves exactly as it did before this file existed.
 *
 * Kept as a pure function, deliberately: it is the one decision a remote client
 * can force on a local pty, so it should be assertable without a pty, a socket
 * or a window.
 */

export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

/** Undefined = nobody has an opinion; leave the pty's size alone. */
export function arbitrate(viewports: readonly (Viewport | undefined)[]): Viewport | undefined {
  let cols = Number.POSITIVE_INFINITY;
  let rows = Number.POSITIVE_INFINITY;

  for (const viewport of viewports) {
    if (viewport === undefined) continue;
    // A non-positive dimension is a view that has not been measured yet —
    // xterm's `fit()` answers null for an element with no box, and a caller
    // converting that to 0 must not be read as "make the pty zero wide". It is
    // an absence of an opinion, not an opinion.
    if (Number.isInteger(viewport.cols) && viewport.cols > 0) cols = Math.min(cols, viewport.cols);
    if (Number.isInteger(viewport.rows) && viewport.rows > 0) rows = Math.min(rows, viewport.rows);
  }

  // Both dimensions must have an opinion behind them. A viewport that supplied
  // only one leaves the other infinite, and resizing to a half-decided size
  // would reflow a running program against a number nobody chose.
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
  return { cols, rows };
}
