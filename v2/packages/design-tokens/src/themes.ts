/**
 * A **skin**: a pair of token tables and a set of faces, under a name.
 *
 * `palette.ts` is one ramp and `roles.ts` is one vocabulary over it, and for
 * three milestones that was the whole story — a "theme" meant `dark` or `light`,
 * which is a MODE rather than a skin. The takeover needed a second answer to a
 * different question ("what does this app look like"), and there were exactly
 * two ways to give it: edit the ramp in place, or make the ramp a value.
 *
 * Editing in place was refused for the reason rule 10 exists at all. The dark
 * ramp is a true neutral read off the redesign prototypes; the takeover's is
 * warm-biased, read off `shepherd-takeover.html`. Overwriting the first with the
 * second would have deleted a decision rather than added one, and — because
 * light is DERIVED from dark, never re-decided — it would have quietly re-derived
 * light mode too, in a commit whose subject was about something else.
 *
 * So a theme is a value here, and the two rules that survive from `palette.ts`
 * survive intact:
 *
 *   - **This is still the only legal home for a hex literal.** Every override
 *     below is one; nothing outside this package may type one.
 *   - **Light is derived, not re-decided.** Every override states BOTH modes.
 *     The warm bias is the same bias in both — paper that is warm rather than
 *     blue-white — so the skin reads as one design in either.
 *
 * A theme may also override ROLES, and the takeover needs to: its accent is
 * `sky` where the built-in skin's "your move" is `wool`, and its working mark is
 * NEUTRAL where the built-in one is `sky`. That is not a palette edit — the two
 * skins want the same colours pointed at different jobs — which is precisely the
 * distinction tier 2 exists to express.
 */

import { palette, type ColorToken, type ThemeMode, type TokenSpec } from './palette.ts';
import { roles, type PaintSource, type RoleName, type RoleSpec } from './roles.ts';
import { fonts } from './metrics.ts';

export type ThemeName = 'shepherd' | 'quiet-craft';

/**
 * The faces a skin sets, split by JOB rather than by shape.
 *
 * `sans` and `mono` keep the jobs `metrics.ts` gives them. `data` is the third,
 * and it is not a third voice so much as a narrowing of the second: what the
 * MACHINE reported and you read as a value — an elapsed count, a diff number, a
 * branch, a key hint. The grid keeps `mono`, which has to stay a Nerd Font patch
 * whatever the skin says, because a codepoint with no glyph is a tofu box and no
 * fallback on macOS rescues the Private Use Area (see `fonts.mono`).
 *
 * In the built-in skin `data` IS `mono`, so nothing changes for a surface that
 * has not opted into the distinction.
 */
export interface FontStacks {
  readonly sans: string;
  readonly mono: string;
  readonly data: string;
  readonly serif: string;
}

export interface Theme extends PaintSource {
  readonly name: ThemeName;
  /** Shown wherever a skin is chosen. */
  readonly label: string;
  readonly fonts: FontStacks;
}

type PaletteOverrides = Partial<Record<ColorToken, TokenSpec>>;
type RoleOverrides = Partial<Record<RoleName, RoleSpec>>;

/**
 * The warm-biased neutral ladder, and the ink ramp over it.
 *
 * Read off `shepherd-takeover.html` (`--g0…--g4`, `--t100…--t30`), which is the
 * normative prototype for this skin. The dark values ARE that file's; the light
 * ones are the same ladder inverted with the same bias, so the two hairline
 * steps stay one step apart and the five ink steps keep their order.
 *
 * Two of the prototype's values are alphas — `rgba(255,255,255,.07)` and `.13`
 * for the hairlines — and they land here as the solid colours they resolve to
 * over the surfaces they are drawn on, which is what the built-in ramp does with
 * `line` and `lineStrong` too. A token's value has to be readable by
 * `relativeLuminance`, and a colour that only exists once composited is not.
 */
const quietCraftPalette: PaletteOverrides = {
  // ── the ladder ──────────────────────────────────────────────────────────────
  sunken: { dark: '#0D0C0B', light: '#F7F5F1', job: 'behind everything; a field’s well' },
  canvas: { dark: '#121110', light: '#F2F0EB', job: 'the window, and the takeover’s whole ground' },
  pane: { dark: '#171614', light: '#FFFFFF', job: 'the grid’s own ground' },
  surface: { dark: '#171614', light: '#FBFAF7', job: 'a resting card, a needs-you card' },
  well: { dark: '#1C1B18', light: '#FFFFFF', job: 'the composer, the switcher, a modal' },
  wash: { dark: '#171614', light: '#EAE7E0', job: 'a row’s hover fill, one step off the canvas' },
  raised: { dark: '#232120', light: '#FFFFFF', job: 'a toast, a selected row in an overlay' },
  active: { dark: '#232120', light: '#EBE8E1', job: 'the selected face tab' },
  fill: { dark: '#2A2825', light: '#E4E1D9', job: 'an active row' },
  // The prototype's two hairlines, composited. `.07` and `.13` white over the
  // ladder they are drawn on; on paper the same two steps, downward.
  line: { dark: '#262421', light: '#DDD9D1', job: 'every seam — the hairline under a group heading' },
  lineStrong: { dark: '#353330', light: '#CFCAC0', job: 'the horizon under a header, a bordered control' },
  lineActive: { dark: '#3B3835', light: '#C2BDB1', job: 'the focused pane’s edge' },
  edgeSelected: { dark: '#454239', light: '#B2ACA0', job: 'a selected card’s edge' },
  edgeRing: { dark: '#807E77', light: '#8E8A81', job: 'the resting mark’s hollow ring' },

  // ── ink ─────────────────────────────────────────────────────────────────────
  ink: { dark: '#ECEBE8', light: '#1A1815', job: 'a title, a live value; the one primary action’s fill' },
  inkQuiet: { dark: '#DCDAD6', light: '#302E29', job: 'an identifier inside a question' },
  // The prototype's terminal ink — one step under the title, which is what keeps
  // a wall of agent output from competing with the row above it.
  inkDim: { dark: '#C8C6C0', light: '#3D3B35', job: 'the terminal grid’s text; a resting card’s title' },
  inkFaint: { dark: '#A9A7A1', light: '#5B584F', job: 'a control at rest, a card’s question text' },
  inkMute: { dark: '#807E77', light: '#74716A', job: 'a group label, a secondary row, the working mark' },
  inkGhost: { dark: '#575550', light: '#86837B', job: 'a path, a timestamp, a key hint' },

  // ── the hues that stay ──────────────────────────────────────────────────────
  //
  // `sky` is deliberately ABSENT: the takeover's accent is the sky this package
  // already ships, unchanged. The prototype's own accent was amber, and it is
  // the one thing in that file this skin does not take — an accent has to be the
  // app's accent, and the app has one.
  grass: { dark: '#7FB069', light: '#4C7A3C', job: 'passed · git added' },
  clay: { dark: '#C77E6A', light: '#A85742', job: 'git removed' },
  red: { dark: '#E0584B', light: '#C4392C', job: 'a run that failed' },
  scrimBase: { dark: '#0A0908', light: '#181614', job: 'the ink an overlay dims the app with' },
  scnFlockRest: { dark: '#3A3A38', light: '#DFDBCE', job: 'the empty state’s sheep, at rest' },
};

/**
 * Where this skin points the same colours at different jobs.
 *
 * The whole of it is one sentence: **hue only ever means off-nominal.** Work in
 * progress is the normal case, so its mark is neutral; a thing that wants you is
 * the accent; a thing that failed is red. The built-in skin makes the opposite
 * call — `sky` for live work, `wool` for a question — and that is a real
 * disagreement about what a glance should find first, not a palette detail.
 */
const quietCraftRoles: RoleOverrides = {
  markWorking: {
    kind: 'alias',
    of: 'textMute',
    job: 'the working meter’s three bars — NEUTRAL, because working is the normal case.',
    notFor: 'an accent. In this skin a hue on a mark means the row is off-nominal, and work in flight is not.',
  },
  markWorkingOff: {
    kind: 'alias',
    of: 'textGhost',
    job: 'the working meter’s off-beat bar.',
    notFor: 'a fade. It is a step on the same neutral ramp, one below the lit bar.',
  },
  markWaiting: {
    kind: 'alias',
    of: 'sky',
    job: 'the solid square that means the agent is waiting on YOU.',
    notFor: 'anything merely notable. This mark is the one that opens a row into a card.',
  },
  markReady: {
    kind: 'alias',
    of: 'sky',
    job: 'the solid square of a turn that finished, or work that is ready to ship.',
    notFor:
      'a second accent. A finished turn and a question are both your move, and this skin says your move in exactly one colour — the group heading above the row says which kind.',
  },
};

const withOverrides = (over: PaletteOverrides): Readonly<Record<ColorToken, TokenSpec>> => ({ ...palette, ...over });
const withRoleOverrides = (over: RoleOverrides): Readonly<Record<RoleName, RoleSpec>> => ({ ...roles, ...over });

/**
 * The faces the takeover sets, and the one it deliberately leaves alone.
 *
 * Instrument Sans for what the app SAYS and Fragment Mono for what the machine
 * REPORTED — the prototype's pairing, and the reason the `data` job exists.
 * `mono` is untouched: it is the grid's, and the grid needs the Nerd Font
 * coverage `fonts.mono` documents.
 */
const quietCraftFonts: FontStacks = {
  sans: "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  mono: fonts.mono,
  data: "'Fragment Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  serif: fonts.serif,
};

export const themes: Readonly<Record<ThemeName, Theme>> = {
  shepherd: {
    name: 'shepherd',
    label: 'Shepherd',
    palette,
    roles,
    // `data` is `mono` here: the built-in skin has two faces and one of them is
    // already "what the machine produced". A surface that asks for `data` gets
    // the same answer it would have got before this token existed.
    fonts: { sans: fonts.sans, mono: fonts.mono, data: fonts.mono, serif: fonts.serif },
  },
  'quiet-craft': {
    name: 'quiet-craft',
    label: 'Quiet craft',
    palette: withOverrides(quietCraftPalette),
    roles: withRoleOverrides(quietCraftRoles),
    fonts: quietCraftFonts,
  },
};

export const themeNames = Object.keys(themes) as ThemeName[];

/** The skin the app paints in until something says otherwise. */
export const DEFAULT_THEME: ThemeName = 'quiet-craft';

/**
 * A stored name → a theme, never `undefined`.
 *
 * A value written by a build that knows a skin this one does not is not a reason
 * to paint nothing; it falls back to the default, which is the same call
 * `resolveThemeMode` makes for a mode it cannot read.
 */
export function resolveTheme(name: string | undefined): Theme {
  return themes[name as ThemeName] ?? themes[DEFAULT_THEME];
}

/** Every mode a colour token has, for a theme — what the mode-parity test walks. */
export function themeSwatch(theme: Theme, token: ColorToken, mode: ThemeMode): string {
  return theme.palette[token][mode];
}
