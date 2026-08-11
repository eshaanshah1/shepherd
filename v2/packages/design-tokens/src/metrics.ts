// The chrome scale, DERIVED — two inputs, everything else a documented ratio.
//
// Rule 1 as amended 2026-08-07 (see the design-language spec) froze these as
// integer px: cell-*harmonious*, not cell-*coupled*. Frozen was right and it is
// not what "typed as literals" means — a literal cannot say WHY 28 is 28, so the
// numbers drifted from their reasons (the shipped comment claimed `rowHeight`
// was "exactly 2 cells" while reading 28, which is 1.4 cells). Every number below
// is now `round(base * ratio * density)`, and the ratios are chosen so that at
// the approved defaults every one of them lands on the mock's own integer.
//
// Three consequences worth knowing before changing anything here:
//
//   - **THE TERMINAL'S FONT SIZE IS NOT IN THIS FILE.** It is the user's
//     `~/.config/shepherd` setting and it scales the grid alone. `baseFontSize`
//     below is the CHROME's scale; a sidebar that got 40% wider because somebody
//     likes 16pt code is exactly what the rule-1 amendment exists to prevent.
//     They happen to be 13 at the defaults, and they are not the same number.
//   - **Never `ch` in CSS.** It is the advance width of "0" in the *live* font,
//     so it is (a) a width unit that says nothing about row height and (b)
//     fractional — 8.4px puts every hairline on a subpixel boundary and the 1px
//     rules this language is built from go blurry.
//   - **Live cell metrics belong only at the seam** — chrome that visually abuts
//     the grid — and the terminal *publishes* its measured cell rather than each
//     component measuring xterm for itself. One opinion about where a row sits;
//     v1 paid for the alternative in a gutter that drifted against its text.
//
// Nothing exposes the two inputs to the user yet; there is no settings surface to
// put them in. The plumbing is here now because it costs nothing while the
// primitives are being written and costs a rewrite of every one of them after
// (design-system spec §7, answer 1).

/**
 * The density modes, Synara's (`lib/appDensity.ts:6-71`). Only `comfortable`
 * ships; the other two exist so the derivation is exercised at a factor that is
 * not 1 — a scale that has only ever been evaluated at its identity is a scale
 * nobody has tested.
 */
export const densities = {
  compact: 0.85,
  comfortable: 1,
  spacious: 1.15,
} as const;

export type Density = keyof typeof densities;

/** The two numbers the whole chrome scale is a function of. */
export interface ScaleInputs {
  /** The chrome's base type size, px. NOT the terminal's. */
  readonly baseFontSize: number;
  /** Height and spacing multiplier; `densities.comfortable` (1) is the default. */
  readonly density: number;
}

export const defaultScaleInputs: ScaleInputs = {
  baseFontSize: 13,
  density: densities.comfortable,
};

/**
 * Every ratio, in one table, with the integer each produces at the defaults.
 *
 * These are not round numbers because the *outputs* are: the mock approved 9 / 10
 * / 11 / 12 / 13 / 15 / 17 px of type and 22 / 28 / 34 px of control, and the
 * ratios are those values over 13. Read the comment column, not the decimal.
 */
export const ratios = {
  /** Type. Multiplies `baseFontSize` only — density is spacing, not size. */
  type: {
    nano: 0.69, //   9px — the agent chip's uppercase micro-label
    micro: 0.77, //  10px — section labels, plate cells (rule 5's instrument voice)
    small: 0.85, //  11px — a path, a pane head, a secondary cell
    medium: 0.92, // 12px — a control's label
    body: 1, //      13px — a row, a field, prose
    large: 1.15, //  15px — a composer's brief
    title: 1.31, //  17px — a composer's title, the one type step in the app
  },
  /**
   * The chrome's line box. 20px at the defaults, which is also the default
   * terminal row — because both derive from 13, not because one reads the other.
   * The moment the user moves either, they part company, and that is correct.
   */
  lineHeight: 1.54,
  /**
   * A sidebar/list row. Deliberately NOT a cell multiple (that would be 40, an
   * enormous list row): chrome away from the grid has its own scale. Rows that
   * must line up with terminal rows use the published cell height instead.
   */
  row: 2.15, //      28px
  /**
   * Control heights. `md` shares the row ratio on purpose — Orca's rule is that a
   * control matches the row height around it, and expressing that as one shared
   * number is how the two cannot drift when the base moves.
   */
  control: {
    sm: 1.69, //     22px
    md: 2.15, //     28px, = row
    lg: 2.62, //     34px
  },
  /** Padding and gap. Multiplies both inputs: density IS spacing. */
  space: {
    xs: 0.31, //      4px
    sm: 0.46, //      6px
    md: 0.62, //      8px
    lg: 0.92, //     12px
    xl: 1.08, //     14px
  },
  /**
   * Radius. Two, per the spec's "terminal brutalism" — plus the one soft value.
   * Base-scaled but NOT density-scaled: a corner is a property of the box's own
   * size, and a denser layout does not want rounder boxes.
   */
  radius: {
    sm: 0.31, //      4px — a keycap, a chip: machined, not rounded
    md: 0.46, //      6px — a button, an icon button
    soft: 1.23, //   16px — writing surfaces ONLY (the composer, the palette).
    //                      Reference notes conflict 1: Flock's 16 stays, but it
    //                      is a token here rather than a literal in the composer,
    //                      so the fused-panel maths (`calc(radius - 1px)`) has
    //                      one source.
  },
} as const;

/** px, integer. Every metric goes through this — nothing here is fractional. */
function px(base: number, ratio: number, density = 1): number {
  return Math.round(base * ratio * density);
}

export interface TypeScale {
  readonly nano: number;
  readonly micro: number;
  readonly small: number;
  readonly medium: number;
  readonly body: number;
  readonly large: number;
  readonly title: number;
}

export interface ControlScale {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
}

export interface SpaceScale {
  readonly xs: number;
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
  readonly xl: number;
}

export interface RadiusScale {
  readonly sm: number;
  readonly md: number;
  readonly soft: number;
}

export interface Metrics {
  /** The inputs, carried so a consumer can show what produced the rest. */
  readonly baseFontSize: number;
  readonly density: number;

  readonly type: TypeScale;
  readonly control: ControlScale;
  readonly space: SpaceScale;
  readonly radius: RadiusScale;

  /** `type.body`, under the name the stylesheet already uses. */
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly rowHeight: number;

  readonly microLabel: {
    readonly fontSize: number;
    /** em; the "WORKING · 3" instrument voice. Unitless, so it does not scale. */
    readonly trackingMin: number;
    readonly trackingMax: number;
  };

  /**
   * One device pixel, and it does NOT scale.
   *
   * A hairline is a hairline: at density 1.15 a "scaled" 1.15px rule lands on a
   * subpixel boundary and blurs, and in a language with no shadows the hairlines
   * carry the entire hierarchy. This is the one member of the scale that is a
   * constant, and it is a constant for a measured reason.
   */
  readonly hairline: number;
}

export function deriveMetrics(inputs: ScaleInputs = defaultScaleInputs): Metrics {
  const { baseFontSize: base, density } = inputs;
  const type: TypeScale = {
    nano: px(base, ratios.type.nano),
    micro: px(base, ratios.type.micro),
    small: px(base, ratios.type.small),
    medium: px(base, ratios.type.medium),
    body: px(base, ratios.type.body),
    large: px(base, ratios.type.large),
    title: px(base, ratios.type.title),
  };
  return {
    baseFontSize: base,
    density,
    type,
    control: {
      sm: px(base, ratios.control.sm, density),
      md: px(base, ratios.control.md, density),
      lg: px(base, ratios.control.lg, density),
    },
    space: {
      xs: px(base, ratios.space.xs, density),
      sm: px(base, ratios.space.sm, density),
      md: px(base, ratios.space.md, density),
      lg: px(base, ratios.space.lg, density),
      xl: px(base, ratios.space.xl, density),
    },
    radius: {
      sm: px(base, ratios.radius.sm),
      md: px(base, ratios.radius.md),
      soft: px(base, ratios.radius.soft),
    },
    fontSize: type.body,
    lineHeight: px(base, ratios.lineHeight),
    rowHeight: px(base, ratios.row, density),
    microLabel: {
      fontSize: type.micro,
      trackingMin: 0.1,
      trackingMax: 0.16,
    },
    hairline: 1,
  };
}

/** The shipping scale: `deriveMetrics` at the approved defaults. */
export const metrics: Metrics = deriveMetrics();

/**
 * A height that means "N lines", as a CSS length.
 *
 * Synara's trick (`lib/appDensity.ts`, composer min-height `calc(2lh * scale)`):
 * a composer's minimum height is *two lines*, and `72px` is a guess that is wrong
 * the moment the base size moves. Only the composer needs it today; it is
 * documented and exported now because the alternative is a px literal typed into
 * the first primitive that needs one, and a px literal never becomes a ratio
 * later.
 *
 * We spell it `calc(N * var(--sh-line-height))` rather than CSS's own `Nlh`
 * unit, which Electron's Chromium does support. `lh` resolves against the
 * ELEMENT's computed `line-height`, so a textarea that sets its own line-height
 * for reading comfort (the composer's brief does exactly that) would silently
 * get a different "two lines" than the chrome around it. The variable is the one
 * opinion about how tall a line is, which is the same argument the gutter lost in
 * v1 by computing its own row geometry.
 */
export function lines(count: number): string {
  return `calc(${count} * var(--sh-line-height))`;
}

export const motion = {
  /** Sheep activity cycle. */
  flockCycleMs: 500,
  /** Block cursor, steps() not ease. */
  cursorBlinkMs: 1100,
  /** ScrambleText tick. */
  scrambleTickMs: 70,
  /** Rule 7: 120–180ms, near-linear, and nothing bounces. */
  transitionMs: 140,
  /**
   * A row ARRIVING in a list. Longer than a state transition, and still short.
   *
   * A state change (hover, selection) is feedback for something the reader just
   * did, so it must not lag them — 140ms. An entrance is the list telling them
   * something happened elsewhere, and at 140ms it is over before the eye lands on
   * it, which is indistinguishable from the wholesale swap it replaces. 180ms is
   * the top of rule 7's band and that is deliberately where this sits.
   *
   * Read by CSS as `--sh-motion-enter` and by the renderer as `rowEnterMs`, from
   * this one number: two constants that must agree are one that will not.
   */
  enterMs: 180,
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
