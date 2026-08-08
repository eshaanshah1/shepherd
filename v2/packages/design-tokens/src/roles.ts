import { palette, type ColorToken, type ThemeMode } from './palette.ts';

/**
 * Tier 2 of the token layer: **roles are the public vocabulary.**
 *
 * `palette.ts` is tier 1 and it is PRIVATE — `ink-raised` is an internal name for
 * a step on a luminance ramp, and the moment an extension writes
 * `var(--sh-ink-raised)` that internal name is a public API by accident. It
 * already was one, which is the observation the design-system spec opens with.
 * A role says what a colour is FOR; a palette token says what it IS.
 *
 * Three consequences worth knowing before adding a role here:
 *
 *   - **Two roles may resolve to the same palette token.** `canvas` and
 *     `surfaceSunken` are both `ink-deep` today. That is not a duplicate: they are
 *     different jobs, and a theme that wants a recessed field well one step off
 *     the window backdrop must be able to say so without inventing a token.
 *   - **`alias` and `wash` emit `var(--sh-…)`, not a resolved colour.** That is
 *     the whole point of scoped re-declaration (spec §2): a surface that
 *     re-declares the generic `--sh-text` on its own subtree gets a selection
 *     fill and a hover wash that track it, with zero knowledge at the call site.
 *     Baking the hex in at generation time would freeze both to the built-in
 *     palette and quietly break every contributed theme.
 *   - **Every role carries the negative half.** Orca's styleguide has a
 *     "Don't use it for" column per token (reference notes §3), and it is the
 *     thing that stopped its token set from sprawling. Flock states the positive
 *     half in prose; `notFor` is where the other half lives.
 */

export type RoleName =
  // surfaces
  | 'canvas'
  | 'surface'
  | 'surfaceRaised'
  | 'surfaceSunken'
  | 'terminal'
  // lines
  | 'line'
  // text
  | 'text'
  | 'textDim'
  | 'textFaint'
  // accents (each one has a job; rule 3 bans a saturated colour without one)
  | 'accent'
  | 'accentText'
  | 'attention'
  | 'success'
  | 'danger'
  | 'prompt'
  // states
  | 'fillHover'
  | 'fillSelected'
  | 'textSelected'
  | 'focusRing';

interface RoleShared {
  /** What the role is for. */
  readonly job: string;
  /** What it is NOT for. Orca's "Don't use it for" column. */
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
  canvas: {
    kind: 'token',
    token: 'ink-deep',
    job: 'the window backdrop — what is behind every surface.',
    notFor: 'a panel or a card. Those are `surface`; canvas is what they sit on.',
  },
  surface: {
    kind: 'token',
    token: 'ink',
    job: 'a panel: the app frame, the sidebar, the titlebar, a bar.',
    notFor: 'a hover fill. That is `fillHover`, which is a wash and tracks a theme.',
  },
  surfaceRaised: {
    kind: 'token',
    token: 'ink-raised',
    job: 'a surface one luminance step up — a modal card, a floating panel.',
    notFor:
      'elevation theater. Rule 2 has no shadows: the step IS the elevation, and there is no second one.',
  },
  surfaceSunken: {
    kind: 'token',
    token: 'ink-deep',
    job: "an instrument's recessed well — a bordered field, an input.",
    notFor:
      'a writing surface. A composer is soft (spec §3): its fields sit ON the card with no well of their own.',
  },
  terminal: {
    kind: 'token',
    token: 'ink-term',
    job: "the grid's own background, and the pane chrome painted to match it.",
    notFor:
      'app chrome away from a pane. And never read the app mode off it — pane chrome measures this colour (`paneTitleSurface`), because an extension may theme one terminal light inside a dark app.',
  },

  line: {
    kind: 'token',
    token: 'ink-line',
    job: 'every hairline. With no shadows, these carry the whole hierarchy.',
    notFor:
      'a fill. A 1px rule at this value reads as structure; a 28px block of it reads as a mistake.',
  },

  text: {
    kind: 'token',
    token: 'wool',
    job: 'primary text, and the solid block an inverse-video selection is painted with.',
    notFor: 'a border. A hairline at text weight is a box, not a seam.',
  },
  textDim: {
    kind: 'token',
    token: 'wool-dim',
    job: 'secondary text — a value beside its label, a subtitle, a resting control.',
    notFor: 'a disabled control. Disabled is 40% opacity on the live colour (spec §3), not a dimmer one.',
  },
  textFaint: {
    kind: 'token',
    token: 'wool-faint',
    job: 'tertiary text — micro-labels, placeholders, an idle state.',
    notFor: 'anything a user has to read to act. It is a step below secondary, not a quiet primary.',
  },

  accent: {
    kind: 'token',
    token: 'cobalt',
    job: 'working, links, and the ONE loud action on a surface.',
    notFor:
      'more than one control in a view. Rule 3 is confident flat use: two primary buttons means neither is.',
  },
  accentText: {
    kind: 'alias',
    of: 'surface',
    job: 'the ink that reads ON a solid accent fill.',
    notFor:
      'text on a TINT. Synara records this one (index.css:442-447): on-fill contrast ink is only ever legal over a solid fill — on a tint you use the role colour and let the tint carry the signal.',
  },
  attention: {
    kind: 'token',
    token: 'hay',
    job: 'blocked — an agent is waiting on you.',
    notFor:
      'warning text on a tint (reference notes, conflict 11). It is a state, and the state is either a solid chip or coloured text on the plain surface.',
  },
  success: {
    kind: 'token',
    token: 'pasture',
    job: 'done, and a turn that finished.',
    notFor: 'a confirmation button. A button is `accent` or bordered; green means a state, not an action.',
  },
  danger: {
    kind: 'token',
    token: 'ember',
    job: 'error, urgent, and the dev build identity.',
    notFor:
      'a back-out path. Cancel/Dismiss/Close are not destructive (Orca STYLEGUIDE:294-296) — they are ghost, uncoloured.',
  },
  prompt: {
    kind: 'token',
    token: 'signal',
    job: 'a live affordance: the cursor, a hint that something is waiting for input.',
    notFor:
      'a status. It is the only accent that means "here, now" rather than "this is the case", and reusing it for a state would cost the distinction.',
  },

  fillHover: {
    kind: 'wash',
    of: 'text',
    // Superset's measured pair (globals.css:58-60, 103-104): 7% dark / 4% light,
    // and the reason light is lower is that a wash on a bright surface reads
    // heavier at the same alpha. Ours is 6/4 because Flock's `wool` is warmer and
    // therefore already more present against `ink` than a neutral foreground is.
    alpha: { dark: 0.06, light: 0.04 },
    job: 'the hover fill on a row or a ghost control.',
    notFor:
      'selection. Rule 4 keeps inverse video for that, and a wash next to a solid block is the distinction that makes both readable at a glance.',
  },
  fillSelected: {
    kind: 'alias',
    of: 'text',
    // NOT a wash, deliberately — and this is where the design-system spec's §2
    // parenthetical ("roles that are washes: fillHover = text at 6%,
    // fillSelected") disagrees with the design language it is implementing.
    // Flock rule 4 is inverse video: a selected row is a SOLID block of `text`
    // with `textSelected` on it, and the reference study reached the same
    // conclusion explicitly (takeaway 2: "Flock's rule 4 uses inverse video for
    // selection, which is stronger and should stay — but hover still needs an
    // answer"). Shipped `.sh-row.is-sel` is already the solid form. An alias
    // rather than a token so a re-declared `--sh-text` carries the block with it.
    job: 'the selected fill — a solid block, inverse video (rule 4).',
    notFor:
      'a hover state, and not a tint. If it ever becomes a wash, hover and selection stop being one glance apart.',
  },
  textSelected: {
    kind: 'alias',
    of: 'surface',
    job: 'the ink on a `fillSelected` block.',
    notFor: 'anything not sitting on that block. Off it, this is the surface colour and invisible.',
  },
  focusRing: {
    kind: 'alias',
    of: 'accent',
    job: 'the keyboard focus indicator.',
    notFor:
      'a hover or an active state. Focus is a keyboard fact; painting it on hover makes the one thing a keyboard user needs illegible.',
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
 * correct hover fill for free. An `rgb(233 226 210 / 6%)` baked at generation
 * time is the built-in palette, forever, on every surface. Electron's Chromium
 * has had `color-mix` since well before 43, so there is no support argument on
 * the other side.
 *
 * `srgb` and not `oklab` (which Superset uses): every value in this palette is an
 * sRGB hex and the second colour is `transparent`, so the interpolation space
 * only changes how the *alpha* ramp is computed — and sRGB is what the rest of
 * this file's contrast maths (`relativeLuminance`) is defined in. One space.
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
 * Nothing generates CSS from this — it exists so a test (and later the inspector,
 * spec §4) can answer "which colour is actually behind this name" without
 * re-implementing the walk. Throws on a cycle rather than recursing forever: two
 * roles aliasing each other is a mistake that must fail loudly at build time, not
 * hang a stylesheet generator.
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
