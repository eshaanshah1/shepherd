import { palette, type ColorToken, type ThemeMode } from './palette.ts';

/**
 * Tier 2 of the token layer: **roles are the public vocabulary.**
 *
 * `palette.ts` is tier 1 and it is PRIVATE — a component asks for `surface`,
 * never for `#0F0F0F`, and never for the tier-1 step behind it either. A role
 * says what a colour is FOR; a palette token says what it IS. An extension that
 * uses roles is themed for free; a hardcoded hex is a review flag.
 *
 * Four consequences worth knowing before adding a role here:
 *
 *   - **Two roles may resolve to the same palette token.** `raised` and `well`
 *     are both `#FFFFFF` in light. That is not a duplicate: they are different
 *     jobs, and a theme that wants a modal one step off a menu must be able to
 *     say so without inventing a token.
 *   - **`alias` and `wash` emit `var(--sh-…)`, not a resolved colour.** That is
 *     the point of scoped re-declaration: a surface that re-declares the generic
 *     `--sh-text` on its own subtree gets a selection fill and a hover wash that
 *     track it, with zero knowledge at the call site. Baking the hex in at
 *     generation time would freeze both to the built-in palette and quietly
 *     break every contributed theme.
 *   - **Every role carries the negative half.** `notFor` is where §2's "not for"
 *     column lives, and it is the thing that stops a token set from sprawling.
 *   - **A contributed surface supplies a role NAME, never a colour and never a
 *     height.** A contributed view that hardcodes a colour is a visible bug the
 *     moment a user swaps themes, which is a better enforcement mechanism than a
 *     lint rule.
 */

export type RoleName =
  // surfaces
  | 'sunken'
  | 'canvas'
  | 'pane'
  | 'surface'
  | 'well'
  | 'raised'
  // lines
  | 'line'
  | 'lineStrong'
  | 'lineActive'
  | 'edgeSelected'
  | 'lineAccent'
  | 'glintAccent'
  // text
  | 'text'
  | 'textQuiet'
  | 'textDim'
  | 'textFaint'
  | 'textMute'
  | 'textGhost'
  // the five that mean something (§2)
  | 'sky'
  | 'grass'
  | 'wool'
  | 'clay'
  | 'red'
  // the state mark (§3)
  | 'markWorking'
  | 'markWorkingOff'
  | 'markWaiting'
  | 'markRest'
  | 'markFailed'
  | 'meterPass'
  | 'meterPending'
  // repo identity
  | 'repo1'
  | 'repo2'
  | 'repo3'
  | 'repo4'
  // the sky strip
  | 'sceneSkyHigh'
  | 'sceneSkyLow'
  | 'sceneGlowInk'
  | 'sceneGlow'
  | 'sceneHill'
  | 'sceneFlock'
  | 'sceneFlockShade'
  | 'sceneFlockRest'
  // overlays
  | 'scrimInk'
  | 'scrim'
  // states
  | 'fillHover'
  | 'fillAccent'
  | 'fillSelection'
  | 'fillActive'
  | 'fillTab'
  | 'fillSelected'
  | 'textOnWool'
  | 'codeFill'
  | 'codeKeyword'
  | 'codeString'
  | 'codeComment'
  | 'codeConstant'
  | 'codeFunction'
  | 'codeParameter'
  | 'codePunctuation'
  | 'focusRing';

interface RoleShared {
  /** What the role is for. */
  readonly job: string;
  /** What it is NOT for. §2's "not for" column. */
  readonly notFor: string;
}

/** A role painted from the palette directly. */
export interface TokenRole extends RoleShared {
  readonly kind: 'token';
  readonly token: ColorToken;
}

/** A role that IS another role, under a second name, so an override tracks it. */
export interface AliasRole extends RoleShared {
  readonly kind: 'alias';
  readonly of: RoleName;
}

/** A low-opacity wash of another role over whatever is behind it. */
export interface WashRole extends RoleShared {
  readonly kind: 'wash';
  readonly of: RoleName;
  /** Per mode, because a light surface needs less wash for the same step. */
  readonly alpha: Readonly<Record<ThemeMode, number>>;
}

export type RoleSpec = TokenRole | AliasRole | WashRole;

export const roles: Readonly<Record<RoleName, RoleSpec>> = {
  // ── surfaces ────────────────────────────────────────────────────────────────
  sunken: {
    kind: 'token',
    token: 'sunken',
    job: 'behind everything; a field’s own well.',
    notFor: 'a writing surface. A composer is a `well`, one step UP, not a recess.',
  },
  canvas: {
    kind: 'token',
    token: 'canvas',
    job: 'the window, the rail, the stage — what every surface sits on.',
    notFor: 'a card or a panel. Those are `surface`; canvas is their ground.',
  },
  pane: {
    kind: 'token',
    token: 'pane',
    job: 'the grid’s own ground, and the pane chrome painted to match it.',
    notFor:
      'app chrome away from a pane. And never read the app mode off it — pane chrome measures this colour (`paneTitleSurface`), because an extension may theme one terminal light inside a dark app.',
  },
  surface: {
    kind: 'token',
    token: 'surface',
    job: 'a resting card.',
    notFor: 'a hover fill. That is `fillHover`, which is a wash and tracks a theme.',
  },
  well: {
    kind: 'token',
    token: 'well',
    job: 'the composer, a modal — a surface you write on.',
    notFor:
      'a bordered box inside itself. Inside a well, space is the structure: a bordered box is the loudest thing on it.',
  },
  raised: {
    kind: 'token',
    token: 'raised',
    job: 'a selected card, a menu.',
    notFor:
      'elevation theater. The luminance step IS the elevation, and there is exactly one documented shadow — a menu over an already-raised surface.',
  },

  // ── lines ───────────────────────────────────────────────────────────────────
  line: {
    kind: 'token',
    token: 'line',
    job: 'every seam. With no shadows, these carry the whole hierarchy.',
    notFor: 'a fill. A 1px rule at this value reads as structure; a 28px block of it reads as a mistake.',
  },
  lineStrong: {
    kind: 'token',
    token: 'lineStrong',
    job: 'a well’s edge, a bordered control.',
    notFor: 'a seam between two bands of chrome. That is `line`, and a heavier one reads as a box.',
  },
  lineActive: {
    kind: 'token',
    token: 'lineActive',
    job: 'the focused pane’s edge — focus is ONE border step.',
    notFor:
      'dimming its neighbours. An unfocused pane is not dimmed by opacity: a dimmed pane is one whose live output you can no longer read.',
  },
  edgeSelected: {
    kind: 'token',
    token: 'edgeSelected',
    job: 'a selected card’s edge, over its `raised` fill.',
    notFor: 'inverse video. Selection is a fill plus an edge; the label stays legible.',
  },
  lineAccent: {
    kind: 'wash',
    of: 'sky',
    // Well over `fillAccent`, because an edge is one device pixel and a wash
    // that reads as a surface at 400px² is invisible at 1px. Paper again takes
    // less: `sky` is a dark blue in light mode and an edge is the loudest place
    // that shows.
    alpha: { dark: 0.5, light: 0.34 },
    job: 'the hairline around an accent-tinted box — a `Pill`.',
    notFor:
      'a seam or a control’s border. Those are `line` and `lineStrong`, which are neutral: this one is the accent, and it only ever draws around a fill of the same accent.',
  },
  glintAccent: {
    kind: 'wash',
    of: 'sky',
    // The top edge only, and brighter than the rest of the border on purpose:
    // it is the one place a flat box can say "lit from above" without a gradient
    // or a shadow, both of which §10 refuses outright.
    alpha: { dark: 0.72, light: 0.46 },
    job: 'the lit top edge of an accent-tinted box — the top BORDER’s colour.',
    notFor:
      'an inset shadow. That paints against the inner face of the border box, so the top edge lands 2px against 1px everywhere else and the extra light drags the label optically low. It is a colour, not a second edge.',
  },

  // ── text ────────────────────────────────────────────────────────────────────
  text: {
    kind: 'token',
    token: 'ink',
    job: 'a title, a live value.',
    notFor: 'a border. A hairline at text weight is a box, not a seam.',
  },
  textQuiet: {
    kind: 'token',
    token: 'inkQuiet',
    job: 'an identifier inside a sentence — the one word of a question you must actually read.',
    notFor: 'the sentence around it. That is `textDim`; this is the part being pointed at.',
  },
  textDim: {
    kind: 'token',
    token: 'inkDim',
    job: 'the terminal grid’s text, and a resting card’s title.',
    notFor: 'chrome at rest. A control at rest is `textFaint`, a step quieter.',
  },
  textFaint: {
    kind: 'token',
    token: 'inkFaint',
    job: 'a control at rest.',
    notFor: 'a disabled control. Disabled is 36% opacity on the LIVE colour, never a dimmer one.',
  },
  textMute: {
    kind: 'token',
    token: 'inkMute',
    job: 'a section label, a secondary row.',
    notFor: 'anything you must read to act.',
  },
  textGhost: {
    kind: 'token',
    token: 'inkGhost',
    job: 'a path, a timestamp, an id — what the machine produced.',
    notFor: 'prose.',
  },

  // ── the five that mean something ────────────────────────────────────────────
  sky: {
    kind: 'token',
    token: 'sky',
    job: 'live · focus · send.',
    notFor: 'a status that is not "right now".',
  },
  grass: {
    kind: 'token',
    token: 'grass',
    job: 'passed · done · git added.',
    notFor: 'a confirm button. A hue is never a button.',
  },
  wool: {
    kind: 'alias',
    of: 'text',
    job: 'waiting on you, and the ONE action on a surface — a white fill on black.',
    notFor:
      'decoration. It is also `text`, which is the point: the loudest thing available against this surface, and there is only one of it per surface.',
  },
  clay: {
    kind: 'token',
    token: 'clay',
    job: 'git removed.',
    notFor: 'failure. A run that failed is `red`, and the two must stay one glance apart.',
  },
  red: {
    kind: 'token',
    token: 'red',
    job: 'a run that failed.',
    notFor: 'a back-out path. Cancel, Dismiss, Close and Discard are ghost — they are not destructive.',
  },

  // ── the state mark (§3) ─────────────────────────────────────────────────────
  //
  // A **square** always means *your move*. A **ring** means nothing is happening.
  // A **meter** means something is. Every mark carries its word as a tooltip and
  // as its accessible name — two states will eventually share a hue, and a fact
  // encoded only in colour cannot be read out, searched or asserted on.
  markWorking: {
    kind: 'alias',
    of: 'sky',
    job: 'the working meter’s three bars.',
    notFor: 'a bar that is mid-cycle. That is `markWorkingOff`, and it is a step, not an opacity.',
  },
  markWorkingOff: {
    kind: 'token',
    token: 'skyDim',
    job: 'the working meter’s third bar on its off beat.',
    notFor:
      'a continuous fade. The cycle is `steps(1, end)` at 1.1s so it repaints twice a second rather than every frame — twelve panes of continuously repainting indicators peg the GPU.',
  },
  markWaiting: {
    kind: 'alias',
    of: 'wool',
    job: 'the solid 8×8 square that means the agent is waiting on YOU.',
    notFor: 'anything that is merely notable. This mark is the one that opens a row into a card.',
  },
  markRest: {
    kind: 'token',
    token: 'edgeRing',
    job: 'the hollow 7×7 ring — nothing is happening.',
    notFor: 'a fill. The ring is 1px and hollow; a filled circle at this value reads as a fifth state.',
  },
  markFailed: {
    kind: 'alias',
    of: 'red',
    job: 'the solid 8×8 square of a run that failed.',
    notFor: 'a warning. There is no warning state; a thing either needs you or it does not.',
  },
  meterPass: {
    kind: 'alias',
    of: 'grass',
    job: 'a suite meter’s cell, green.',
    notFor: 'a cell that has not run. That is `meterPending`, a neutral — not a dimmer green.',
  },
  meterPending: {
    kind: 'token',
    token: 'lineActive',
    job: 'a suite meter’s cell that has not run yet.',
    notFor: 'a failure. A failed suite is drawn with the failed mark, not a red cell.',
  },

  // ── repo identity ───────────────────────────────────────────────────────────
  repo1: { kind: 'token', token: 'repoSky', job: 'a repo’s identity square.', notFor: 'a state. Identity is a sixth axis and shares no meaning with the five.' },
  repo2: { kind: 'token', token: 'repoStone', job: 'a repo’s identity square.', notFor: 'a state.' },
  repo3: { kind: 'token', token: 'repoTaupe', job: 'a repo’s identity square.', notFor: 'a state.' },
  repo4: { kind: 'token', token: 'repoSlate', job: 'a repo’s identity square.', notFor: 'a state.' },

  // ── the sky strip ───────────────────────────────────────────────────────────
  sceneSkyHigh: {
    kind: 'token',
    token: 'scnSkyHigh',
    job: 'the top of the strip’s vertical ramp, behind the hills.',
    notFor: 'a surface anywhere else. The strip is a window, not a wallpaper.',
  },
  sceneSkyLow: {
    kind: 'token',
    token: 'scnSkyLow',
    job: 'the ramp at the horizon, where it hands off to `canvas`.',
    notFor:
      'a third stop in the middle. Two stops and the canvas is the whole ramp — a stop between them is a band, and a band in a gradient is a seam.',
  },
  sceneGlowInk: {
    kind: 'token',
    token: 'scnGlow',
    job: 'the ink `sceneGlow` is a wash of. Exposed so a themed subtree can move both.',
    notFor: 'painting anything directly. At full opacity this is a colour the strip never shows.',
  },
  sceneGlow: {
    kind: 'wash',
    of: 'sceneGlowInk',
    // 13% dark, 45% light, read off the shipped gradients rather than chosen. The
    // asymmetry is the scrim's finding in the other direction: the dark glow is
    // sky over near-black and 13% already reads, while the light one is white on
    // a bright sky and has almost no contrast to spend.
    alpha: { dark: 0.13, light: 0.45 },
    job: 'the radial low on the right, so the one thing worth finding is the lit thing.',
    notFor: 'a glow on anything else. There is exactly one illustration.',
  },
  sceneHill: {
    kind: 'token',
    token: 'scnHill',
    job: 'the meadow’s hills, in the 124px strip at the head of the rail.',
    notFor:
      'anywhere but the strip. It is a window, not a wallpaper — an earlier version spread the scene behind the whole app and was rejected as distracting.',
  },
  sceneFlock: { kind: 'token', token: 'scnFlock', job: 'the sheep’s body and fluff.', notFor: 'an icon. The sheep is drawn in markup as 3px pixels; there is no image asset.' },
  sceneFlockShade: { kind: 'token', token: 'scnFlockShade', job: 'the sheep’s legs.', notFor: 'a second illustration. There is exactly one.' },
  sceneFlockRest: { kind: 'token', token: 'scnFlockRest', job: 'the empty state’s sheep, at rest and unlit.', notFor: 'the rail’s sheep, which is grazing in daylight.' },

  // ── overlays ────────────────────────────────────────────────────────────────
  scrimInk: {
    kind: 'token',
    token: 'scrimBase',
    job: 'the ink `scrim` is a wash of. Exposed so a themed subtree can move both.',
    notFor: 'painting anything directly. At full opacity this is a colour nothing in the app is.',
  },
  scrim: {
    kind: 'wash',
    of: 'scrimInk',
    // 76% dark, 20% light — README §2. The asymmetry is the same finding the pane
    // chrome records one file over: 55% black over paper reads as soot, which is
    // the dead grey this language refuses. A scrim takes contrast OUT of what is
    // behind it, and paper has less to give.
    alpha: { dark: 0.76, light: 0.2 },
    job: 'what a ⌘T composer or a ⌘K palette dims the app with.',
    notFor:
      'a backdrop blur. Glass is refused outright — the scrim is flat, and what is behind it stays readable as itself.',
  },

  /**
   * The fill behind a run of code set into prose.
   *
   * A WASH rather than a surface token, and that is the whole point. `well` and
   * `raised` are absolute luminances chosen against a card, and in light mode
   * both of them are `#FFFFFF` — so a chip painted with either vanishes the
   * moment the prose under it is not sitting on a card. A wash of `text` is
   * derived from the ink instead, so it lightens on black and darkens on paper
   * and reads against whatever ground it lands on.
   *
   * The alphas are per mode for the reason every wash here is: paper has less
   * contrast to spend, so the same step needs less of it.
   */
  codeFill: {
    kind: 'wash',
    of: 'text',
    alpha: { dark: 0.09, light: 0.07 },
    job: 'the chip behind an inline code span, and the fill of a fenced block.',
    notFor:
      'a state. `fill-hover` and `fill-active` are the same order of step and would make a span of code read as though the pointer were on it.',
  },

  /*
   * ── code syntax ─────────────────────────────────────────────────────────────
   *
   * Seven roles for the inside of a code surface, and the only hues in this file
   * that do not name a state. See `palette.ts` for why that exception exists and
   * why these particular values.
   *
   * They are roles rather than raw tokens because the consumer is a THIRD PARTY:
   * `@pierre/diffs` reads them as CSS variables through a registered theme, and
   * a vendor reading tier-1 token names would be the one thing §2 keeps private.
   */
  codeKeyword: {
    kind: 'token',
    token: 'codeKeyword',
    job: 'a keyword inside a code surface.',
    notFor: 'anything outside one. A hue in the chrome is a claim about state.',
  },
  codeString: {
    kind: 'token',
    token: 'codeString',
    job: 'a string literal inside a code surface.',
    notFor: 'a success. That is `grass`, and it means a check passed.',
  },
  codeComment: {
    kind: 'token',
    token: 'codeComment',
    job: 'a comment inside a code surface.',
    notFor: 'quiet chrome text. That ramp is `textMute` and `textGhost`.',
  },
  codeConstant: {
    kind: 'token',
    token: 'codeConstant',
    job: 'a number, constant or language literal inside a code surface.',
    notFor: 'a link or a focus ring. That blue is `sky`, and it means live · focus · send.',
  },
  codeFunction: {
    kind: 'token',
    token: 'codeFunction',
    job: 'a function name inside a code surface.',
    notFor: 'anything in the chrome — the palette has no violet, and this is why.',
  },
  codeParameter: {
    kind: 'token',
    token: 'codeParameter',
    job: 'a parameter or plain variable inside a code surface.',
    notFor: 'body text. Prose ink is `text` and its ramp.',
  },
  codePunctuation: {
    kind: 'token',
    token: 'codePunctuation',
    job: 'brackets and separators inside a code surface.',
    notFor: 'a border. A seam is `line`.',
  },

  // ── states ──────────────────────────────────────────────────────────────────
  fillHover: {
    kind: 'token',
    token: 'wash',
    job: 'the hover fill on a row or a ghost control.',
    notFor:
      'a row that GROWS to reveal its actions. Hover actions share one grid cell with the metadata, so the track is already as wide as the wider of them.',
  },
  fillAccent: {
    kind: 'wash',
    of: 'sky',
    // Read against `canvas` at a glance, not on inspection. The first pass at
    // this was 0.16/0.11 and it was a smudge — a wash this small has to clear
    // the surface behind it by a whole ramp step or it reads as nothing.
    // Paper still takes less: `sky` is a DARK blue in light mode, so the same
    // alpha over white lands a step louder than over near-black.
    alpha: { dark: 0.24, light: 0.15 },
    job: 'the tint behind a token the app is holding inside a sentence — a `Pill`.',
    notFor:
      'a status. It is a wash of `sky`, so it moves with the accent rather than naming a sixth colour, and the ink on it stays the sentence’s.',
  },
  /*
   * The selection band.
   *
   * A WASH, and it is worth knowing that this was opaque for a while and why it
   * could go back. A translucent band painted over itself lands a step brighter,
   * and a browser paints adjacent LINES of one selection with a fraction of a
   * pixel of overlap — measured on a four-line selection with no tokens in it:
   * `rgb(79,110,139)` against a band of `rgb(54,73,90)`, a bright hairline at
   * every line boundary. `Pill` painting the same token over the band was a
   * second way to double it.
   *
   * Neither survives. `PromptField` draws the composer's selection itself now,
   * one bar per line at the TEXT's height, so the bars are separated by the
   * leading and cannot touch; and a pill draws no band at all. The one place the
   * old hazard remains is `::selection` on ordinary app text, where the browser
   * still decides the geometry — at this alpha the doubled pixel is faint, and
   * the surfaces that hold real multi-line prose all go through the field.
   */
  fillSelection: {
    kind: 'wash',
    of: 'sky',
    /*
     * The two alphas move in OPPOSITE directions, and that is what "darker"
     * means on each surface rather than an inconsistency.
     *
     * A wash mixes toward whatever is behind it, so on near-black LESS of the
     * blue is darker and on paper MORE of it is — `sky` is a light blue in dark
     * mode and a dark one in light mode. Reading the pair as "0.14 is the faint
     * one" gets it backwards: both of these are a step down in brightness from
     * where they were, on their own ground.
     *
     * Low enough on both to read THROUGH, which is the point of a wash here:
     * selected text and a selected token keep their own colour and are lit
     * rather than covered.
     */
    alpha: { dark: 0.14, light: 0.22 },
    job: 'the background of selected text, everywhere in the app.',
    notFor:
      'a selected ROW or card. That is `fillSelected` plus `edgeSelected` — this one is the text-level selection a drag makes.',
  },
  fillActive: {
    kind: 'token',
    token: 'fill',
    job: 'an active row — the one the keyboard is on, in a menu or a palette.',
    notFor: 'selection in the rail. A selected task is a card, and it is `raised` plus `edgeSelected`.',
  },
  fillTab: {
    kind: 'token',
    token: 'active',
    job: 'the tab you are on — one luminance step, and the only mark it needs.',
    notFor:
      'a `sky` underline, which is what this replaced. That colour has one job — "live · focus · send" — and a tab that merely happens to be the one you are on is none of them. It also collided with the mark a tab carries for the agent inside it.',
  },
  fillSelected: {
    kind: 'alias',
    of: 'raised',
    job: 'a selected card’s fill, under `edgeSelected`.',
    notFor:
      'inverse video. Flock painted a solid block of `text` here; this language refuses it — a fill plus a 2px edge, and the label stays legible.',
  },
  textOnWool: {
    kind: 'alias',
    of: 'canvas',
    job: 'the ink that reads ON a solid `wool` fill — the one primary button.',
    notFor:
      'text on a tint. On-fill contrast ink is only ever legal over a solid fill; on a tint you use the role colour and let the tint carry the signal.',
  },
  focusRing: {
    kind: 'alias',
    of: 'sky',
    job: 'the keyboard focus indicator — 2px at 2px offset, drawn as `outline`.',
    notFor:
      'a hover or an active state. Focus is a keyboard fact, and it is an outline rather than a border so a focused control is the same SIZE as an unfocused one.',
  },
};

export const roleNames = Object.keys(roles) as RoleName[];

/**
 * `fillHover` → `--sh-fill-hover`. camelCase in TypeScript, kebab in CSS, one
 * conversion so a role cannot be spelled two ways.
 */
export function roleVarName(role: RoleName): string {
  return `--sh-${role.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`;
}

/**
 * The CSS value a role emits.
 *
 * `color-mix` rather than an rgba assembled from the palette hex, and the choice
 * is the same one that made `--fill-hover` worth copying at all: `color-mix(in
 * srgb, var(--sh-text) 6%, transparent)` re-resolves wherever `--sh-text` is
 * re-declared, so a contributed theme (or a `[data-surface]` subtree) gets a
 * correct hover fill for free. An `rgb(237 237 237 / 6%)` baked at generation
 * time is the built-in palette, forever, on every surface. Electron's Chromium
 * has had `color-mix` since well before 43, so there is no support argument on
 * the other side.
 *
 * `srgb` and not `oklab`: every value in this palette is an sRGB hex and the
 * second colour is `transparent`, so the interpolation space only changes how the
 * *alpha* ramp is computed — and sRGB is what this package's contrast maths
 * (`relativeLuminance`) is defined in. One space.
 */
export function roleValue(role: RoleName, mode: ThemeMode): string {
  const spec = roles[role];
  switch (spec.kind) {
    case 'token':
      return palette[spec.token][mode];
    case 'alias':
      return `var(${roleVarName(spec.of)})`;
    case 'wash': {
      const percent = Math.round(spec.alpha[mode] * 1000) / 10;
      return `color-mix(in srgb, var(${roleVarName(spec.of)}) ${percent}%, transparent)`;
    }
  }
}

/**
 * The palette token a role ultimately paints from, following aliases and washes.
 *
 * Nothing generates CSS from this — it exists so a test (and the inspector) can
 * answer "which colour is actually behind this name" without re-implementing the
 * walk. Throws on a cycle rather than recursing forever: two roles aliasing each
 * other is a mistake that must fail loudly at build time, not hang a stylesheet
 * generator.
 */
export function roleToken(role: RoleName): ColorToken {
  const seen = new Set<RoleName>();
  let current = role;
  for (;;) {
    if (seen.has(current)) {
      throw new Error(`roles: "${role}" resolves through a cycle at "${current}"`);
    }
    seen.add(current);
    const spec = roles[current];
    if (spec.kind === 'token') return spec.token;
    current = spec.of;
  }
}
