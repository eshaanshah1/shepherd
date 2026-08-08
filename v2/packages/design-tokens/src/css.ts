import { colorTokens, palette, type ThemeMode } from './palette.ts';
import { fonts, metrics, motion, type Metrics } from './metrics.ts';
import { roleNames, roleValue, roleVarName } from './roles.ts';
import { paneTitleAlphas, paneTitleInk, withAlpha, type SurfaceKind } from './contrast.ts';

const SURFACE_KINDS: readonly SurfaceKind[] = ['dark', 'light'];

/** `--sh-<token>` — one namespace, so an extension's own CSS cannot collide. */
export const cssVarName = (token: string): string => `--sh-${token}`;

/**
 * The variable map for a mode. Consumers set these on a root element.
 *
 * It emits **both tiers**: the roles (`--sh-surface`, tier 2, public) and the
 * palette tokens they resolve from (`--sh-ink`, tier 1, private). That is
 * deliberate and temporary in spirit but permanent in mechanism: the shell's
 * stylesheet is written against the palette names today, so dropping them would
 * break every rule in it at once, and a migration that has to land in one commit
 * is a migration nobody can review. Call sites move to roles one at a time; the
 * private names stay emitted because `roleValue` needs `--sh-text` to exist for
 * its own `var()` references anyway.
 */
export function cssVariables(mode: ThemeMode, scale: Metrics = metrics): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of colorTokens) vars[cssVarName(token)] = palette[token][mode];
  for (const role of roleNames) vars[roleVarName(role)] = roleValue(role, mode);

  vars[cssVarName('font-sans')] = fonts.sans;
  vars[cssVarName('font-mono')] = fonts.mono;
  vars[cssVarName('font-serif')] = fonts.serif;
  vars[cssVarName('motion')] = `${motion.transitionMs}ms`;

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
  vars[cssVarName('row-height')] = `${scale.rowHeight}px`;
  vars[cssVarName('hairline')] = `${scale.hairline}px`;
  for (const [step, size] of Object.entries(scale.type)) {
    vars[cssVarName(`font-size-${step}`)] = `${size}px`;
  }
  for (const [step, height] of Object.entries(scale.control)) {
    vars[cssVarName(`control-${step}`)] = `${height}px`;
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
export function cssVariableBlock(mode: ThemeMode, selector = ':root', scale: Metrics = metrics): string {
  const body = Object.entries(cssVariables(mode, scale))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}
