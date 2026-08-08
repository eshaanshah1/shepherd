import { palette } from './palette.ts';

/**
 * Chrome drawn on top of a surface whose colour somebody else controls.
 *
 * The pane title bar sits on the TERMINAL's own background, so pane and grid read
 * as one surface rather than as a strip of app chrome parked above a window into
 * another program. The moment it does that, its foreground set can no longer come
 * from the app theme: an extension may ship a light terminal palette inside a dark
 * app (rule 10 makes themes a first-class contribution), and a title bar that
 * asked the app which mode it was in would go invisible — silently, and only for
 * the users who themed anything.
 *
 * So the gate is the **measured luminance of the background actually painted**,
 * never a mode flag. Source: the Orca reading in
 * docs/superpowers/specs/2026-08-08-ui-reference-notes.md §3 "Pane chrome"
 * (`assets/terminal.css:241-260`, `lib/terminal-contrast-correction.ts:11-23`),
 * and takeaway 8.
 */

/** What kind of surface a colour IS — measured, never declared. */
export type SurfaceKind = 'light' | 'dark';

/**
 * The luminance at which black ink and white ink are exactly as legible.
 *
 * WCAG contrast is `(L1 + .05) / (L2 + .05)`, so against white it is
 * `1.05 / (L + .05)` and against black it is `(L + .05) / .05`. They are equal at
 * `L = sqrt(1.05 * .05) - .05 ≈ 0.1791` — which is well below the 0.5 a "is it
 * more than half bright" guess would use, and that gap is the whole point: a
 * mid-grey #808080 wants dark ink, not light.
 *
 * Derived rather than typed so the number cannot drift from its reason.
 */
export const LIGHT_SURFACE_LUMINANCE = Math.sqrt(1.05 * 0.05) - 0.05;

/** `#RRGGBB` (or `#RGB`) as 0–255 channels. Throws rather than guessing. */
function channels(hex: string): readonly [number, number, number] {
  const body = hex.trim().replace(/^#/, '');
  const full =
    body.length === 3
      ? [...body].map((digit) => `${digit}${digit}`).join('')
      : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`contrast: "${hex}" is not a #RRGGBB colour`);
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The reading the whole pane chrome hangs off: is the bar being painted on a
 * light surface or a dark one?
 *
 * ONE function, called by the CSS variable set AND by xterm's own
 * `minimumContrastRatio` (see `minimumContrastRatio` below), so the chrome and
 * the grid cannot disagree about what they are sitting on.
 */
export function paneTitleSurface(background: string): SurfaceKind {
  return relativeLuminance(background) > LIGHT_SURFACE_LUMINANCE ? 'light' : 'dark';
}

/** The five alphas Orca's pane title bar flips between. */
export interface PaneTitleAlphas {
  /** The bar's own text. */
  readonly fg: number;
  /** The title itself — the one thing in the bar that is the pane's identity. */
  readonly strong: number;
  /** The dim tail (path, placeholder). */
  readonly faint: number;
  /** A field's fill. Reserved for rename-in-place; see the note in `css.ts`. */
  readonly fill: number;
  /** The hairline under the bar. */
  readonly rule: number;
}

/**
 * The alphas, verbatim from the reference notes (§3 "Pane chrome"):
 *
 *   on-dark  fg .52  input fg .70  placeholder .38  input bg .04  separator .06
 *   on-light fg .64  input fg .82  placeholder .48  input bg .05  separator .10
 *
 * **The asymmetry is the finding.** Dark ink on a light surface needs MORE weight
 * than light ink on a dark one — the eye's response to a dark mark on bright
 * ground is not the mirror of the reverse, so one table used for both would leave
 * a light-themed pane's chrome looking washed out at exactly the alphas that read
 * correctly in the dark. Do not "simplify" these to one set.
 */
export const paneTitleAlphas: Readonly<Record<SurfaceKind, PaneTitleAlphas>> = {
  dark: { fg: 0.52, strong: 0.7, faint: 0.38, fill: 0.04, rule: 0.06 },
  light: { fg: 0.64, strong: 0.82, faint: 0.48, fill: 0.05, rule: 0.1 },
};

/**
 * The ink those alphas are applied to.
 *
 * Orca uses literal white / zinc-950; Flock has those two already, named, in the
 * palette — `wool` is "primary text", and its two mode values ARE "the ink that
 * reads on a dark surface" and "the ink that reads on a light one". A surface
 * kind and a theme mode are different questions with the same two answers, which
 * is why this indexes `palette.wool` directly instead of introducing a
 * fourteenth colour.
 */
export function paneTitleInk(kind: SurfaceKind): string {
  return palette.wool[kind];
}

/**
 * `#RRGGBB` + alpha as a CSS colour. The `rgb(r g b / n%)` form rather than
 * `color-mix(…, transparent)` because it composites against whatever is behind
 * it — which here is a terminal background we deliberately do not know.
 */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  // `alpha * 100` is 52.00000000000001 for .52 in binary floating point, and a
  // stylesheet full of those is a diff nobody can read.
  const percent = Math.round(alpha * 10000) / 100;
  return `rgb(${r} ${g} ${b} / ${percent}%)`;
}

/**
 * xterm's own contrast floor, gated by the same reading.
 *
 * 4.5 on a light background, 3 on a dark one — Orca's
 * `lib/terminal-contrast-correction.ts:11-23`, with its measured reason: the 4.5
 * floor "badly over-brightened vibrant colors" on dark themes, because raising a
 * saturated ANSI colour to 4.5:1 against near-black desaturates it toward white
 * and the palette stops meaning anything.
 */
export function minimumContrastRatio(kind: SurfaceKind): number {
  return kind === 'light' ? 4.5 : 3;
}
