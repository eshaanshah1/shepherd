import { registerCustomCSSVariableTheme } from '@pierre/diffs';

/*
 * A COPY of `extensions/github/ui/diff-theme.ts`, deliberately.
 *
 * The boundary lint forbids one extension importing another's `ui/`
 * (`extensions/README.md`), and two consumers is not yet a package. **A THIRD
 * consumer promotes this** into a shared home, with both copies deleted — if
 * you are the third, do that instead of copying it a second time.
 *
 * The copy is what makes a file and its diff the same surface here: the editor
 * (`<File edit>`) and the changes view are both `@pierre/diffs`, so one
 * registered theme paints both.
 *
 * Registering the same NAME twice — once from here and once from `github` — is
 * safe rather than a collision: `registerCustomCSSVariableTheme` ends in a
 * `registerCustomTheme(name, loader)` map set, and both copies write identical
 * values. Which is also why the duplication is cheap enough to accept.
 */

/**
 * The diff's colours, as Shepherd's.
 *
 * `@pierre/diffs` takes a theme by NAME rather than as an object — its own
 * themes are `pierre-dark` and `pierre-light`, and this pane used to name
 * `github-dark-default`, whose background is `#0d1117`. That is GitHub's navy,
 * and against a pane of true neutrals it reads as a blue panel. Pierre's own
 * dark background is `#0a0a0a`, which is `--sh-canvas` exactly; the app was
 * opted out of a theme that already matched it.
 *
 * Naming `pierre-dark` would have been the whole fix. This goes one step
 * further for the reason the near-miss makes obvious: a match by coincidence is
 * not a match. `pierre-light` is `#ffffff` where this app's light canvas is
 * `#EFEFEF`, and its additions and deletions are its own greens and reds rather
 * than `grass` and `red`. So the theme is registered from OUR tokens.
 *
 * **One theme, not two.** A CSS-variables theme resolves every colour through a
 * custom property at paint time, and `--sh-*` already answers differently per
 * mode — so there is nothing left for a second theme to say. That is also what
 * makes this correct on a live theme switch: nothing re-tokenises, the
 * variables simply resolve to other values.
 *
 * Registration is global to the module and idempotent, so it runs at import
 * rather than per render.
 */
export const SHEPHERD_DIFF_THEME = 'shepherd';

/**
 * Shiki's fourteen slots, of which we set eleven.
 *
 * The values are `var(--sh-…)` rather than hexes, which is the whole mechanism:
 * they are emitted into the theme as the FALLBACK of `var(--diffs-token-…, …)`,
 * so a surface that wants to move one still can, and everything else resolves
 * from the palette. The three ansi-only slots are left alone — nothing in a
 * diff renders terminal colours.
 */
registerCustomCSSVariableTheme(SHEPHERD_DIFF_THEME, {
  foreground: 'var(--sh-text-dim)',
  background: 'var(--sh-surface)',

  'token-keyword': 'var(--sh-code-keyword)',
  'token-string': 'var(--sh-code-string)',
  // A template's interpolated half. Shiki separates it so the `${}` can read as
  // code inside a string; ours is the parameter ink for exactly that reason.
  'token-string-expression': 'var(--sh-code-parameter)',
  'token-comment': 'var(--sh-code-comment)',
  'token-constant': 'var(--sh-code-constant)',
  'token-function': 'var(--sh-code-function)',
  'token-parameter': 'var(--sh-code-parameter)',
  'token-punctuation': 'var(--sh-code-punctuation)',
  // A link inside code is still a constant — `sky` is spoken for, and a
  // clickable-looking blue in a diff nobody can click is a lie.
  'token-link': 'var(--sh-code-constant)',

  /*
   * These three are the WORD-LEVEL marks inside a changed line, not the row
   * tints — those are `--diffs-bg-*` and live in the stylesheet. They are the
   * app's own grass and red so an intra-line change agrees with the row it sits
   * in, rather than being a fourth green.
   */
  'token-inserted': 'var(--sh-grass)',
  'token-deleted': 'var(--sh-red)',
  'token-changed': 'var(--sh-sky)',
});

/**
 * The chrome around the code, which a theme cannot reach.
 *
 * A shiki theme colours TOKENS. Everything else the viewer draws — the file
 * header, the gutter, the row tints under an added or removed line, the hover
 * — is the package's own stylesheet, and it derives those from its `--diffs-*`
 * properties. Most of them inherit through the shadow boundary and are set in
 * `review-pane.css` beside the metrics; the ones here cannot be, because the
 * package assigns them ITSELF on the elements below, and an inherited value
 * loses to a declaration on the element.
 *
 * `unsafeCSS` is the package's supported way in: a stylesheet injected inside
 * the shadow root, where a descendant selector reaches. It is the answer to the
 * note in `review-pane.css` that says our sheet cannot get in — true from
 * outside, and this is the door.
 *
 * The tints are mixed FROM the surface rather than stated, so one palette
 * change moves all of them and they stay correct in both modes. Percentages are
 * low on purpose: a diff row's colour has to be legible under code without
 * competing with it.
 */
export const SHEPHERD_DIFF_CSS = `
/*
 * :host, and that is the load-bearing part.
 *
 * The package DERIVES its painted values on the host: --diffs-addition-base is
 * var(--diffs-addition-color-override, ...) declared there, and everything
 * downstream reads the result. A custom property set on a descendant does not
 * reach back up, so overriding it on [data-diff] sets a variable nothing
 * recomputes from. Measured, that left the header's +120 and its change icon
 * at rgba(0, 0, 0, 0.067) — present, laid out, and invisible.
 */
:host {
  --diffs-bg: var(--sh-surface);
  --diffs-light-bg: var(--sh-surface);
  --diffs-dark-bg: var(--sh-surface);
  --diffs-fg: var(--sh-text-dim);

  /* The three inks a change is drawn in — the header counts, the gutter
     numbers and the word-level marks all derive from these. */
  --diffs-addition-color-override: var(--sh-grass);
  --diffs-deletion-color-override: var(--sh-red);
  --diffs-modified-color-override: var(--sh-sky);

  /* A token paints its own ink and never a block behind it; the row tint is
     what says added or removed, and two backgrounds would fight. */
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Context, hover and the seams between hunks — one step off the surface
     rather than absolute greys, so they hold in light mode too. */
  --diffs-bg-context-override: var(--sh-surface);
  --diffs-bg-context-gutter-override: var(--sh-surface);
  --diffs-bg-hover-override: var(--sh-fill-hover);
  --diffs-bg-separator-override: var(--sh-well);
  --diffs-bg-buffer-override: var(--sh-surface);

  /* Mixed FROM the surface rather than stated, so one palette change moves all
     of them and both modes stay correct. Low on purpose: a row's tint has to
     be legible under code without competing with it. */
  --diffs-bg-addition-override: color-mix(in srgb, var(--sh-grass) 12%, var(--sh-surface));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--sh-grass) 20%, var(--sh-surface));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--sh-grass) 26%, var(--sh-surface));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--sh-red) 12%, var(--sh-surface));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--sh-red) 20%, var(--sh-surface));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--sh-red) 26%, var(--sh-surface));

  --diffs-fg-number-override: var(--sh-text-ghost);
}

/* The surfaces themselves. These are declarations rather than variables, so
   they belong on the elements that carry them. */
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  background-color: var(--sh-surface) !important;
  color: var(--sh-text-dim) !important;
}

/* The header is chrome: the app's sans, the app's ink, and a seam under it. */
[data-diffs-header] {
  border-block-color: var(--sh-line) !important;
  color: var(--sh-text) !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
}

/* Counts are a measurement, so they are mono and tabular — the same rule the
   rest of this pane follows for anything you compare by eye. */
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--sh-font-mono) !important;
  font-size: var(--sh-font-size-micro) !important;
  font-variant-numeric: tabular-nums;
}

/* The hunk separator, which says how many lines were skipped. */
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  font-family: var(--sh-font-sans) !important;
  font-size: var(--sh-font-size-micro) !important;
  color: var(--sh-text-ghost) !important;
  text-decoration: none !important;
}
`;
