// The normative **Shepherd UI** palette — §2 of the `shepherd-ui` skill, drawn in
// full in `Shepherd Redesign.dc.html` (dark, canonical) and
// `Shepherd Redesign Light.dc.html`.
//
// Supersedes **Flock**, whose warm ink, five saturated accents and thirteen
// tokens this replaces outright rather than sitting beside. What Flock got right
// and this keeps: tokens are the API, themes are a contribution, hairlines carry
// hierarchy, no elevation theater.
//
// Rule 10 is unchanged and is the reason this file exists: **this is the ONLY
// place a hex literal belongs.** Chrome CSS, the xterm theme and extension views
// are all generated from it, and a hex outside this package is a defect.
//
// Three things to know before adding a value here:
//
//   - **Light is derived, not re-decided.** Same structure, same marks, same
//     geometry, same five jobs. Two things change beyond inverting the ramp:
//     `wool` becomes ink (`#141414` — on paper the loudest thing available is
//     black), and the sky strip is at noon.
//   - **Light does not preserve the dark ramp's ordering.** A dark hover fill is
//     one step BRIGHTER than its canvas; a light one is one step DARKER. That is
//     why these are named for the surface they are, not `ramp-0…n` — an index
//     would assert an order that only one mode has.
//   - **Every hue has one job** (§2), and adding one is not a decision this file
//     gets to make alone. When you are tempted to, you are usually missing a
//     luminance step — and the steps below are the ones the screens actually use,
//     read off the prototypes rather than invented.
//
//     §2's five became seven exactly once, and the bar it had to clear is the bar
//     the next one has to clear: a surface stopped being able to say what it knew.
//     The PR fact went from hover-revealed to drawn at rest, and five states that
//     the tooltip used to separate had to separate by sight — with `running`
//     borrowing `sky` from `open` and `merged` sitting in grey ink beside work
//     that had not started. `honey` and `plum` are those two, and their `notFor`
//     clauses in `roles.ts` are the fence: honey is in-flight and not a warning,
//     plum is terminal and not a second way of saying quiet.

export type ThemeMode = 'dark' | 'light';

export type ColorToken =
  // The neutral ramp — true neutral, no cast.
  | 'sunken'
  | 'canvas'
  | 'pane'
  | 'surface'
  | 'well'
  | 'wash'
  | 'raised'
  | 'active'
  | 'fill'
  | 'line'
  | 'lineStrong'
  | 'lineActive'
  | 'edgeSelected'
  | 'edgeRing'
  // Ink.
  | 'ink'
  | 'inkQuiet'
  | 'inkDim'
  | 'inkFaint'
  | 'inkMute'
  | 'inkGhost'
  // The hues that carry a job. (`wool` is `ink`; see the type below.)
  //
  // `honey` and `plum` arrived with the always-drawn PR fact: five states that
  // have to separate at rest need five hues, and before them `running` borrowed
  // `sky` while `merged` was left as grey ink. Their `notFor` clauses in
  // `roles.ts` are what keep them from becoming a warning colour and a second
  // way of saying quiet.
  | 'sky'
  | 'skyDim'
  | 'grass'
  | 'clay'
  | 'red'
  | 'honey'
  | 'plum'
  | 'git'
  // Repo identity — a sixth axis with its own fixed marks.
  | 'repoSky'
  | 'repoStone'
  | 'repoTaupe'
  | 'repoSlate'
  // What an overlay dims the app with.
  | 'scrimBase'
  // The lit top edge of the one solid fill.
  | 'glint'
  // The sky strip: the one decorative surface in the app.
  | 'scnSkyHigh'
  | 'scnSkyLow'
  | 'scnGlow'
  | 'scnHill'
  | 'scnFlock'
  | 'scnFlockShade'
  | 'scnFlockRest'
  // Code syntax: the one place a hue is allowed to mean nothing.
  | 'codeKeyword'
  | 'codeString'
  | 'codeComment'
  | 'codeConstant'
  | 'codeFunction'
  | 'codeParameter'
  | 'codePunctuation';

export interface TokenSpec {
  readonly dark: string;
  readonly light: string;
  /** What the colour is *for*. A saturated value without a job is banned. */
  readonly job: string;
}

export const palette: Readonly<Record<ColorToken, TokenSpec>> = {
  // ── the neutral ramp ────────────────────────────────────────────────────────
  sunken: { dark: '#070708', light: '#F4F4F4', job: 'behind everything; a field’s well' },
  canvas: { dark: '#0A0A0A', light: '#EFEFEF', job: 'the window, the rail, the stage' },
  pane: { dark: '#0D0D0D', light: '#FFFFFF', job: 'the grid’s own ground' },
  surface: { dark: '#0F0F0F', light: '#FAFAFA', job: 'a resting card' },
  well: { dark: '#121212', light: '#FFFFFF', job: 'the composer, a modal' },
  // Not in §2's table; read off the screens, where it is the fill a row takes on
  // hover and the ground of the titlebar's search affordance. In light it steps
  // DOWN from canvas rather than up — see the ordering note at the head.
  wash: { dark: '#141414', light: '#E6E6E6', job: 'a hover fill on a row or a ghost control' },
  raised: { dark: '#161616', light: '#FFFFFF', job: 'a selected card, a menu' },
  active: { dark: '#1A1A1A', light: '#E8E8E8', job: 'the active tab' },
  fill: { dark: '#1B1B1B', light: '#E4E4E4', job: 'an active row' },
  line: { dark: '#222222', light: '#DCDCDC', job: 'every seam' },
  lineStrong: { dark: '#272727', light: '#D2D2D2', job: 'a well’s edge, a bordered control' },
  lineActive: { dark: '#2A2A2A', light: '#C6C6C6', job: 'the focused pane’s edge; a pending suite cell' },
  edgeSelected: { dark: '#333333', light: '#B6B6B6', job: 'a selected card’s edge' },
  edgeRing: { dark: '#4A4A4A', light: '#ADADAD', job: 'the resting mark’s hollow ring' },

  // ── ink ─────────────────────────────────────────────────────────────────────
  //
  // `ink` is also `wool`, the fifth job-carrying colour: white on black, black on
  // paper. It is one token because "the loudest thing available against this
  // surface" and "primary text" are the same answer in both modes, and two names
  // for one value is how the two drift.
  ink: { dark: '#EDEDED', light: '#141414', job: 'a title, a live value; the `wool` mark and the one action' },
  inkQuiet: { dark: '#DCDCDC', light: '#2E2E2E', job: 'an identifier inside a question' },
  inkDim: { dark: '#C4C4C4', light: '#3A3A3A', job: 'the terminal grid’s text; a resting card’s title' },
  inkFaint: { dark: '#A8A8A8', light: '#565656', job: 'a control at rest' },
  inkMute: { dark: '#8C8C8C', light: '#6E6E6E', job: 'a section label, a secondary row' },
  inkGhost: { dark: '#5A5A5A', light: '#767676', job: 'a path, a timestamp' },

  // ── the hues that mean something ────────────────────────────────────────────
  sky: { dark: '#7FB6E8', light: '#2E6FB8', job: 'live · focus · send' },
  skyDim: { dark: '#4E7492', light: '#8FB4D6', job: 'a working meter’s off-beat bar' },
  grass: { dark: '#86C06A', light: '#3F7A50', job: 'passed · done · git added' },
  clay: { dark: '#C4796B', light: '#A8483A', job: 'git removed' },
  red: { dark: '#E05C4F', light: '#C4392C', job: 'a run that failed' },
  // **Not a warning.** `honey` means IN FLIGHT — a check that is running, a gate
  // that has reported it needs a click. The distinction the palette has always
  // refused is "this might be bad"; the one it now admits is "this is not
  // finished", which is a fact about time rather than a hedge about severity.
  //
  // It exists because the PR fact went from hover-revealed to always-drawn, and
  // five states scanning at rest need five hues. Before this, `running` borrowed
  // `sky` — which left "checks in flight" and "nobody has looked yet" the same
  // colour, the two states you most need to tell apart.
  honey: { dark: '#D9A441', light: '#9A6F1A', job: 'in flight · pending on you' },
  // Terminal, and the only hue that is. Merged work read `inkMute` before this,
  // which made finished and unstarted the same grey.
  plum: { dark: '#A47FD0', light: '#6B4A9E', job: 'merged · the one terminal state' },
  /*
   * **A BRAND colour, and the only one in here.** Git's own orange, on git's own
   * mark and nowhere else.
   *
   * It does not carry a state and it is not competing with the five that do —
   * which is the exemption it needs, because §2's rule is that a saturated value
   * without a job is banned and "identity" was not previously a job. It is the
   * same argument the repo-identity marks make one block down: a sixth axis,
   * sharing no meaning with the states.
   *
   * The light value is darkened from git's `#F05032`, which sits at about 3:1 on
   * paper and fails a 13px glyph.
   */
  git: { dark: '#F05032', light: '#C43B1D', job: 'git’s own mark, in git’s own colour' },

  // ── repo identity ───────────────────────────────────────────────────────────
  //
  // **Grass is deliberately not in this set**: a repo tinted green would read as
  // something that passed.
  repoSky: { dark: '#7FB6E8', light: '#2E6FB8', job: 'repo identity mark 1' },
  repoStone: { dark: '#8C9AA8', light: '#5D6B7A', job: 'repo identity mark 2' },
  repoTaupe: { dark: '#CFCBBE', light: '#8A8375', job: 'repo identity mark 3' },
  repoSlate: { dark: '#6E7B8C', light: '#46586B', job: 'repo identity mark 4' },

  // ── the scrim ───────────────────────────────────────────────────────────────
  //
  // The ink an overlay dims the app with, before its alpha. It is NOT `sunken`:
  // in light the scrim stays near-black (`#181818` at 20%) rather than going
  // pale, because a scrim's job is to take contrast OUT of what is behind it and
  // a white veil over paper removes none.
  scrimBase: { dark: '#060606', light: '#181818', job: 'the ink an overlay dims the app with' },

  /*
   * ── the glint ───────────────────────────────────────────────────────────────
   *
   * The light that falls on the top edge of a SOLID fill, before its alpha.
   *
   * §10 refuses gradients and drop shadows outright, which leaves a flat
   * language with no way at all to say "this is the one thing to press" beyond
   * the fill itself. A 1px lit edge is the whole of what is left, and it was
   * being typed as `rgba(255,255,255,.35)` in the prototype for exactly that
   * reason.
   *
   * It does NOT follow the ramp, which is why it is a token of its own rather
   * than a wash of `pane` or `ink`: on a near-white fill in dark mode the light
   * is white, and on a near-black fill on paper it is a warm grey — in both
   * cases LIGHTER than the fill under it, which no step of an inverting ladder
   * can promise.
   */
  glint: { dark: '#FFFFFF', light: '#9A968D', job: 'the light on the top edge of a solid fill' },

  // ── the sky strip ───────────────────────────────────────────────────────────
  //
  // The only illustration in the product. It is a window, not a wallpaper: an
  // earlier version spread the scene behind the whole app and was distracting.
  // The ramp is two stops and then `canvas`, so the strip ends in the colour the
  // rail already is and needs no seam to sit against it.
  scnSkyHigh: { dark: '#101C29', light: '#6BA3D6', job: 'the strip’s ramp at the top' },
  scnSkyLow: { dark: '#0D141C', light: '#9CC4E4', job: 'the strip’s ramp at the horizon' },
  scnGlow: { dark: '#7FB6E8', light: '#FFFFFF', job: 'the light behind the sheep' },
  scnHill: { dark: '#121D16', light: '#7FA95F', job: 'the meadow’s hills' },
  scnFlock: { dark: '#D8D4C8', light: '#FFFFFF', job: 'the sheep’s body and fluff' },
  scnFlockShade: { dark: '#8A8679', light: '#94907F', job: 'the sheep’s legs' },
  scnFlockRest: { dark: '#3A3A38', light: '#DFDBCE', job: 'the empty state’s sheep, at rest' },

  /*
   * ── code syntax ─────────────────────────────────────────────────────────────
   *
   * The one place in this palette where a hue does NOT carry a job, and the
   * exception is worth stating rather than smuggling. §2's rule — a saturated
   * value without a job is banned — is about CHROME: a hue there is a claim
   * about state, and a second meaning for it makes the first unreadable. Syntax
   * colour is not chrome. It is a property of the text being quoted, it never
   * appears outside a code surface, and nothing in the app reads it as a signal.
   *
   * The values are `@pierre/diffs`' own `pierre-dark` / `pierre-light`, brought
   * across unchanged. That is deliberate: the diff already rendered in exactly
   * these colours, so this move changes nothing on screen — it changes WHERE
   * they are decided. They were baked inside a vendored theme; they are now a
   * row of this table, so light mode is ours, and re-picking them later is an
   * edit here rather than a fork of somebody's theme.
   */
  codeKeyword: { dark: '#FF678D', light: '#D32A61', job: 'a keyword, an operator, a storage type' },
  codeString: { dark: '#5ECC71', light: '#199F43', job: 'a string, and a template’s literal half' },
  /*
   * The two greys are the one place these values are NOT Pierre's.
   *
   * It ships `#737373` and `#636363` in BOTH modes, and this package refuses a
   * token that does not change with the mode — a rule with a test behind it,
   * and right: the same mid-grey is a quiet comment on near-black and a
   * washed-out one on white. Nudged apart rather than redesigned, so the dark
   * mode reads as it did.
   */
  codeComment: { dark: '#7C7C7C', light: '#6E6E6E', job: 'a comment' },
  codeConstant: { dark: '#68CDF2', light: '#1CA1C7', job: 'a number, a constant, a language literal' },
  codeFunction: { dark: '#9D6AFB', light: '#693ACF', job: 'a function or method name at its use' },
  codeParameter: { dark: '#A3A3A3', light: '#636363', job: 'a parameter or a plain variable' },
  codePunctuation: { dark: '#6C6C6C', light: '#7B7B7B', job: 'brackets, commas, the syntax between' },
};

export const colorTokens = Object.keys(palette) as ColorToken[];

export function color(token: ColorToken, mode: ThemeMode): string {
  return palette[token][mode];
}
