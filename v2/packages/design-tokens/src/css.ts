import { colorTokens, palette, type ThemeMode } from './palette.ts';
import { metrics, motion, type Metrics } from './metrics.ts';
import { roleNames, roleValue, roleVarName } from './roles.ts';
import { themes, type Theme } from './themes.ts';
import { paneTitleAlphas, paneTitleInk, withAlpha, type SurfaceKind } from './contrast.ts';

const SURFACE_KINDS: readonly SurfaceKind[] = ['dark', 'light'];

/** `--sh-<token>` — one namespace, so an extension's own CSS cannot collide. */
export const cssVarName = (token: string): string => `--sh-${token}`;

/**
 * The variable map for a mode. Consumers set these on a root element.
 *
 * It emits **the roles and nothing else** — one public vocabulary, which is what
 * §2 asks for. Flock emitted both tiers, and said why: its shell stylesheet was
 * written against the palette names, so dropping them would have broken every
 * rule at once. That reason expired with Flock. Tier 1 is now genuinely private:
 * a stylesheet cannot name a luminance step even by accident, because the
 * variable does not exist.
 *
 * `roleValue`'s alias and wash forms emit `var(--sh-…)` pointing at other ROLES,
 * so every reference they make is to a name emitted here.
 */
export function cssVariables(
  mode: ThemeMode,
  scale: Metrics = metrics,
  theme: Theme = themes.shepherd,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const role of roleNames) vars[roleVarName(role)] = roleValue(role, mode, theme);

  vars[cssVarName('font-sans')] = theme.fonts.sans;
  vars[cssVarName('font-mono')] = theme.fonts.mono;
  /*
   * The third job, and NOT a third voice — see `FontStacks`. In the built-in
   * skin it resolves to the same stack as `--sh-font-mono`, so a rule that reads
   * it is correct under either skin and gets the narrower face under the one
   * that has it.
   */
  vars[cssVarName('font-data')] = theme.fonts.data;
  vars[cssVarName('font-serif')] = theme.fonts.serif;
  vars[cssVarName('motion')] = `${motion.transitionMs}ms`;
  vars[cssVarName('motion-enter')] = `${motion.enterMs}ms`;

  /*
   * The derived scale, every member of it.
   *
   * `--sh-density` is emitted unitless and unused by any rule here on purpose: it
   * is what a later settings surface reads back to show what it produced, and it
   * is the one value in the set that a CSS rule could not recompute from the
   * others.
   */
  vars[cssVarName('base-font-size')] = `${scale.baseFontSize}px`;
  vars[cssVarName('density')] = `${scale.density}`;
  vars[cssVarName('font-size')] = `${scale.fontSize}px`;
  vars[cssVarName('line-height')] = `${scale.lineHeight}px`;
  vars[cssVarName('line-height-large')] = `${scale.lineHeightLarge}px`;
  vars[cssVarName('row-height')] = `${scale.rowHeight}px`;
  // The state mark's fixed box, emitted because a second line has to align under
  // the TITLE rather than under the mark — see `task-card.css`.
  vars[cssVarName('mark-slot')] = `${scale.markSlot}px`;
  vars[cssVarName('hairline')] = `${scale.hairline}px`;
  for (const [step, size] of Object.entries(scale.type)) {
    vars[cssVarName(`font-size-${step}`)] = `${size}px`;
  }
  for (const [step, height] of Object.entries(scale.control)) {
    vars[cssVarName(`control-${step}`)] = `${height}px`;
  }
  for (const [band, height] of Object.entries(scale.band)) {
    vars[cssVarName(`band-${band.replace(/[A-Z]/g, (u) => `-${u.toLowerCase()}`)}`)] = `${height}px`;
  }
  for (const [step, gap] of Object.entries(scale.space)) {
    vars[cssVarName(`space-${step}`)] = `${gap}px`;
  }
  for (const [step, corner] of Object.entries(scale.radius)) {
    vars[cssVarName(`radius-${step}`)] = `${corner}px`;
  }
  vars[cssVarName('micro-font-size')] = `${scale.microLabel.fontSize}px`;
  vars[cssVarName('micro-tracking')] = `${scale.microLabel.trackingMin}em`;
  vars[cssVarName('micro-tracking-wide')] = `${scale.microLabel.trackingMax}em`;

  /*
   * The pane-chrome set — BOTH kinds, in every mode, on purpose.
   *
   * These are not mode variants. A pane picks between them from the measured
   * luminance of its own terminal background (`paneTitleSurface`), published as
   * `data-pane-title-surface` on the pane element, so a light-themed pane inside
   * a dark app gets the light set and its neighbour does not. Emitting only "the
   * current mode's" values here would put the app flag back in the middle of the
   * one decision that must not read it.
   *
   * `fill` (a field's background, .04/.05) is deliberately NOT emitted: nothing in
   * the bar is a field yet. It arrives with rename-in-place (reference notes,
   * takeaway 9), and until then an unused custom property is just a value nobody
   * can see drift.
   */
  for (const kind of SURFACE_KINDS) {
    const ink = paneTitleInk(kind);
    const alphas = paneTitleAlphas[kind];
    vars[cssVarName(`pane-title-fg-on-${kind}`)] = withAlpha(ink, alphas.fg);
    vars[cssVarName(`pane-title-strong-on-${kind}`)] = withAlpha(ink, alphas.strong);
    vars[cssVarName(`pane-title-faint-on-${kind}`)] = withAlpha(ink, alphas.faint);
    vars[cssVarName(`pane-title-rule-on-${kind}`)] = withAlpha(ink, alphas.rule);
  }

  return vars;
}

/** The same map as a stylesheet, for injection into a view or webview. */
export function cssVariableBlock(
  mode: ThemeMode,
  selector = ':root',
  scale: Metrics = metrics,
  theme: Theme = themes.shepherd,
): string {
  const body = Object.entries(cssVariables(mode, scale, theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}
