import { colorTokens, palette, type ThemeMode } from './palette.ts';
import { fonts, metrics, motion } from './metrics.ts';
import { paneTitleAlphas, paneTitleInk, withAlpha, type SurfaceKind } from './contrast.ts';

const SURFACE_KINDS: readonly SurfaceKind[] = ['dark', 'light'];

/** `--sh-<token>` — one namespace, so an extension's own CSS cannot collide. */
export const cssVarName = (token: string): string => `--sh-${token}`;

/** The variable map for a mode. Consumers set these on a root element. */
export function cssVariables(mode: ThemeMode): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of colorTokens) vars[cssVarName(token)] = palette[token][mode];

  vars[cssVarName('font-sans')] = fonts.sans;
  vars[cssVarName('font-mono')] = fonts.mono;
  vars[cssVarName('font-serif')] = fonts.serif;
  vars[cssVarName('font-size')] = `${metrics.fontSize}px`;
  vars[cssVarName('line-height')] = `${metrics.lineHeight}px`;
  vars[cssVarName('row-height')] = `${metrics.rowHeight}px`;
  vars[cssVarName('hairline')] = `${metrics.hairline}px`;
  vars[cssVarName('motion')] = `${motion.transitionMs}ms`;

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
export function cssVariableBlock(mode: ThemeMode, selector = ':root'): string {
  const body = Object.entries(cssVariables(mode))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}
