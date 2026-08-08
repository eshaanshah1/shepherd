// Cell metrics and motion, mock-approved.
//
// Rule 1 as amended 2026-08-07 (see the design-language spec): these are
// **integer px, derived once from the default cell and frozen** — cell-
// *harmonious*, not cell-*coupled*. Three consequences worth knowing before you
// change a number here:
//
//   - **Never `ch` in CSS.** It is the advance width of "0" in the *live* font,
//     so it is (a) a width unit that says nothing about row height and (b)
//     fractional — 8.4px puts every hairline on a subpixel boundary and the 1px
//     rules this language is built from go blurry.
//   - **A terminal font-size change rescales the terminal, not the chrome.** The
//     font size is a user preference; a sidebar that got 40% wider because
//     somebody likes 16pt text is not a feature.
//   - **Live cell metrics belong only at the seam** — chrome that visually abuts
//     the grid — and the terminal *publishes* its measured cell rather than each
//     component measuring xterm for itself. One opinion about where a row sits;
//     v1 paid for the alternative in a gutter that drifted against its text.

export const metrics = {
  /** Terminal + chrome mono size, px. */
  fontSize: 13,
  /** One terminal row, px. The grid's own rhythm — heights, never widths. */
  lineHeight: 20,
  /**
   * A sidebar/list row. Deliberately NOT a cell multiple (that would be 40, which
   * is a huge list row): chrome away from the grid has its own scale, and this
   * comment used to claim "exactly 2 cells" while reading 28 — the drift the
   * amended rule exists to stop. Rows that must line up with terminal rows use
   * the published cell height instead.
   */
  rowHeight: 28,
  microLabel: {
    fontSize: 10,
    /** em; the "WORKING · 3" instrument voice. */
    trackingMin: 0.1,
    trackingMax: 0.16,
  },
  hairline: 1,
} as const;

export const motion = {
  /** Sheep activity cycle. */
  flockCycleMs: 500,
  /** Block cursor, steps() not ease. */
  cursorBlinkMs: 1100,
  /** ScrambleText tick. */
  scrambleTickMs: 70,
  /** Rule 7: 120–180ms, near-linear, and nothing bounces. */
  transitionMs: 140,
} as const;

/**
 * The bundled face. **JetBrains Mono is the choice, not a placeholder** (decided
 * 2026-08-07): it is OFL, so it redistributes in an app bundle with no licence
 * tier to reason about, and it has the character rule 6 asks for. Carried over
 * from v1's resources.
 *
 * Swapping it later is one edit here plus regenerating the metrics above — the
 * frozen-token mechanism is precisely what keeps a font change from becoming a
 * hand-retune of the whole chrome.
 */
export const fonts = {
  /**
   * The CHROME's face — v1's, ported.
   *
   * v1 bundled two faces and split them by job (`Theme.swift`: DM Sans for the
   * sidebar and every label, JetBrains Mono for the grid and for code), and v2
   * shipped one token used for everything. The result was prose set in
   * monospace: a composer that reads as terminal output rather than as a form,
   * which is the first thing anyone said about the UI.
   *
   * A face is a JOB here, not a preference: if it is something the app SAYS,
   * it is sans; if it is something the machine produced — a path, an id, a
   * command, the grid — it is mono.
   */
  sans: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  /** Rule 6: serif only where the app speaks in sentences. */
  serif: "'Iowan Old Style', Palatino, Georgia, serif",
} as const;
