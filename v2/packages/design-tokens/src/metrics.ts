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
 * The density modes, Synara's (`lib/appDensity.ts:6-71`).
 *
 * **`compact` ships.** The rail spent a while at `comfortable`, where the pitch
 * is one 34px row with no gap between rows — correct by the language and still
 * loose to read, because a rail of finished tasks is one short line per 34px
 * box. Density is the knob built for exactly that: it moves heights and spacing
 * together and leaves type alone, so the rows tighten without the labels
 * shrinking.
 *
 * The other two are kept because a scale evaluated only at the factor it ships
 * at is a scale nobody has tested — and `comfortable` is still the one the
 * design language's stated numbers (34 / 28 / 24) describe.
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
  density: densities.compact,
};

/**
 * Every ratio, in one table, with the integer each produces at the defaults.
 *
 * These are not round numbers because the *outputs* are: the mock approved 9 / 10
 * / 11 / 12 / 13 / 15 / 17 px of type and 22 / 28 / 34 px of control, and the
 * ratios are those values over 13. Read the comment column, not the decimal.
 */
export const ratios = {
  /**
   * Type. Multiplies `baseFontSize` only — density is spacing, not size.
   *
   * **These round to the nearest HALF pixel, not the nearest pixel**, because
   * Shepherd UI §2 specifies 12.5 / 11.5 / 10.5 and means them. That is not a
   * relaxation of the integer rule below it: the rule is about the 1px hairlines
   * this language builds its hierarchy from, which blur off a subpixel boundary.
   * A glyph is antialiased at every size already, so a half-pixel type step costs
   * nothing and buys the step between a control's label (12.5) and a row (13).
   */
  type: {
    nano: 0.81, //   10.5px — a path, an id (mono)
    micro: 0.85, //  11px — a measurement, tabular (mono)
    small: 0.88, //  11.5px — a section label. Sentence case, no tracking.
    medium: 0.96, // 12.5px — a control's label
    body: 1, //      13px — a row, a menu item
    card: 1.08, //   14px — a card title
    large: 1.23, //  16px — the brief
    title: 1.46, //  19px — a panel's name, once per panel
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
  row: 2.62, //      34px
  /**
   * Control heights. `lg` shares the row ratio on purpose — a control matches the
   * row height around it, and expressing that as one shared number is how the two
   * cannot drift when the base moves.
   */
  control: {
    sm: 1.85, //     24px
    md: 2.15, //     28px, = a tab
    lg: 2.62, //     34px, = row
  },
  /**
   * The chrome bands, which are fixed furniture rather than content.
   *
   * **Three of them are density-EXEMPT, and the old comment said why without
   * acting on it**: "a titlebar is 44 because the traffic lights are, and a rail
   * is 332 because that is how wide a task's title plus its metadata needs to
   * be" — an OS constant and a content measurement. Neither is a spacing
   * preference, so neither follows one. The sky strip joins them because it is a
   * DRAWING: `sky-strip.tsx` places its stars, hills and sheep at literal px in
   * a 124px box and says in as many words that "a scene that reflowed with the
   * density mode would not be the same scene" — at 0.85 the box became 105 and
   * the scene did not move with it.
   *
   * The exemption follows `radius`, which is base-scaled and not density-scaled
   * for the same shape of reason. What still scales is what is genuinely rhythm:
   * a tab, a pane head, a tab strip.
   */
  band: {
    tab: 2.15, //      28px
    paneHead: 2.92, // 38px
    tabStrip: 3.08, // 40px
    titlebar: 3.38, // 44px
    skyStrip: 9.54, // 124px — the one decorative surface in the app
    rail: 25.54, //    332px
  },
  /**
   * Padding and gap: `2 4 6 7 9 10 12 14 16 20`. Multiplies both inputs, because
   * density IS spacing.
   *
   * The five short names carry over from Flock so the stylesheets that read them
   * keep resolving while §4's primitives are rewritten one at a time; the other
   * five are the steps this language added.
   */
  space: {
    hair: 0.15, //     2px
    xs: 0.31, //       4px
    sm: 0.46, //       6px
    snug: 0.54, //     7px
    md: 0.69, //       9px
    mid: 0.77, //     10px
    lg: 0.92, //      12px
    xl: 1.08, //      14px
    xxl: 1.23, //     16px
    huge: 1.54, //    20px
  },
  /**
   * Radius: `5 6 8 10 12 14 16`, plus `50%` on the send button — the only round
   * thing in the app, and the only one not in this table.
   *
   * Base-scaled but NOT density-scaled: a corner is a property of the box's own
   * size, and a denser layout does not want rounder boxes.
   */
  radius: {
    sm: 0.38, //       5px — a chip
    md: 0.46, //       6px — a control
    row: 0.62, //      8px — a row
    card: 0.77, //    10px — a card, a pane
    window: 0.92, //  12px — the window
    well: 1.08, //    14px — a well; the palette's card
    soft: 1.23, //    16px — the composer's well, the widest radius in the app.
    //                       Kept under Flock's name because the fused-panel maths
    //                       (`calc(radius - 1px)`) reads it and has one source.
  },
} as const;

/**
 * px, integer. Every LENGTH goes through this — a height, a gap, a radius and a
 * hairline are all whole device pixels, because this language draws its entire
 * hierarchy in 1px rules and a rule on a subpixel boundary is a blurred rule.
 */
function px(base: number, ratio: number, density = 1): number {
  return Math.round(base * ratio * density);
}

/**
 * px, to the nearest HALF. Type only — see the note on `ratios.type`. A glyph is
 * antialiased at every size, so the boundary argument that governs `px` above
 * does not apply to it, and §2 asks for 12.5 / 11.5 / 10.5 by name.
 */
function pt(base: number, ratio: number): number {
  return Math.round(base * ratio * 2) / 2;
}

export interface TypeScale {
  /** 10.5 — a path, an id. Mono. */
  readonly nano: number;
  /** 11 — a measurement, tabular. Mono. */
  readonly micro: number;
  /** 11.5 — a section label. Sentence case, no tracking. */
  readonly small: number;
  /** 12.5 — a control's label. */
  readonly medium: number;
  /** 13 — a row, a menu item. */
  readonly body: number;
  /** 14 — a card title. */
  readonly card: number;
  /** 16 — the brief. */
  readonly large: number;
  /** 19 — a panel's name, once per panel. */
  readonly title: number;
}

export interface ControlScale {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
}

/** The fixed chrome furniture: `a task holds tabs; a tab holds panes`. */
export interface BandScale {
  readonly tab: number;
  readonly paneHead: number;
  readonly tabStrip: number;
  readonly titlebar: number;
  readonly skyStrip: number;
  readonly rail: number;
}

export interface SpaceScale {
  readonly hair: number;
  readonly xs: number;
  readonly sm: number;
  readonly snug: number;
  readonly md: number;
  readonly mid: number;
  readonly lg: number;
  readonly xl: number;
  readonly xxl: number;
  readonly huge: number;
}

export interface RadiusScale {
  readonly sm: number;
  readonly md: number;
  readonly row: number;
  readonly card: number;
  readonly window: number;
  readonly well: number;
  readonly soft: number;
}

export interface Metrics {
  /** The inputs, carried so a consumer can show what produced the rest. */
  readonly baseFontSize: number;
  readonly density: number;

  readonly type: TypeScale;
  readonly control: ControlScale;
  readonly band: BandScale;
  readonly space: SpaceScale;
  readonly radius: RadiusScale;

  /** `type.body`, under the name the stylesheet already uses. */
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly rowHeight: number;

  /**
   * The ONE surviving uppercase label: a ⌘K palette group heading, 10.5/600 at
   * `0.05em`. Everywhere else this language refuses uppercase micro-labels with
   * tracking outright — a section label in the rail is 11.5/600 sentence case
   * with no tracking at all. The two numbers are equal because there is now one
   * value rather than a band; they are kept as a pair so the CSS contract
   * (`--sh-micro-tracking`, `--sh-micro-tracking-wide`) does not change shape
   * while §4's primitives are rewritten one at a time.
   */
  readonly microLabel: {
    readonly fontSize: number;
    /** em. Unitless, so it does not scale. */
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
    nano: pt(base, ratios.type.nano),
    micro: pt(base, ratios.type.micro),
    small: pt(base, ratios.type.small),
    medium: pt(base, ratios.type.medium),
    body: pt(base, ratios.type.body),
    card: pt(base, ratios.type.card),
    large: pt(base, ratios.type.large),
    title: pt(base, ratios.type.title),
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
    band: {
      tab: px(base, ratios.band.tab, density),
      paneHead: px(base, ratios.band.paneHead, density),
      tabStrip: px(base, ratios.band.tabStrip, density),
      // Density-exempt — see the `band` ratios. An OS constant, a drawing, and a
      // content measurement; none of the three is a spacing preference.
      titlebar: px(base, ratios.band.titlebar),
      skyStrip: px(base, ratios.band.skyStrip),
      rail: px(base, ratios.band.rail),
    },
    space: {
      hair: px(base, ratios.space.hair, density),
      xs: px(base, ratios.space.xs, density),
      sm: px(base, ratios.space.sm, density),
      snug: px(base, ratios.space.snug, density),
      md: px(base, ratios.space.md, density),
      mid: px(base, ratios.space.mid, density),
      lg: px(base, ratios.space.lg, density),
      xl: px(base, ratios.space.xl, density),
      xxl: px(base, ratios.space.xxl, density),
      huge: px(base, ratios.space.huge, density),
    },
    radius: {
      sm: px(base, ratios.radius.sm),
      md: px(base, ratios.radius.md),
      row: px(base, ratios.radius.row),
      card: px(base, ratios.radius.card),
      window: px(base, ratios.radius.window),
      well: px(base, ratios.radius.well),
      soft: px(base, ratios.radius.soft),
    },
    fontSize: type.body,
    lineHeight: px(base, ratios.lineHeight),
    rowHeight: px(base, ratios.row, density),
    microLabel: {
      fontSize: type.nano,
      trackingMin: 0.05,
      trackingMax: 0.05,
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
  /**
   * The working meter's cycle — `steps(1, end)`, on `opacity` (1 → 0.18 → 1), on
   * the third bar only.
   *
   * `steps(1, end)` rather than a fade, so it repaints twice a second instead of
   * every frame: twelve open panes of continuously-repainting indicators peg the
   * GPU. Under `prefers-reduced-motion` the meter renders **complete and static**
   * — a frozen partial ring reads as broken, a complete one reads as an
   * intentional marker.
   */
  meterCycleMs: 1100,
  /** ScrambleText tick. */
  scrambleTickMs: 70,
  /**
   * 140ms linear, on `color`, `background` and `border-color` ONLY — never `all`.
   * Nothing translates, scales, springs or bounces: a control that moves under
   * the cursor is a control whose target moved mid-click.
   */
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
   * The CHROME's face.
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
   *
   * **The first name must be a face the app SHIPS**, and for a while this one
   * was not: the redesign settled on Geist, the renderer went on bundling v1's
   * DM Sans (which no rule and no token ever named again), and the fallback
   * chain quietly took over. On a machine with Geist installed that is
   * invisible; everywhere else the whole app was drawn in the system face, and
   * the difference reads as "the fonts are wrong" long before anyone thinks to
   * check what actually loaded. `styles.css` bundles `Geist.ttf` — everything
   * after it here is a genuine fallback again.
   */
  sans: "'Geist', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  /**
   * Retained as a token, used by nothing. Shepherd UI is two faces split by job
   * and has no third voice; this stays so a contributed view that reaches for a
   * serif gets a themed one rather than typing a family name.
   */
  serif: "'Iowan Old Style', Palatino, Georgia, serif",
} as const;
