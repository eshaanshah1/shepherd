import { colorTokens, palette, type ThemeMode } from './palette.ts';
import { fonts, metrics, motion } from './metrics.ts';

/** `--sh-<token>` — one namespace, so an extension's own CSS cannot collide. */
export const cssVarName = (token: string): string => `--sh-${token}`;

/** The variable map for a mode. Consumers set these on a root element. */
export function cssVariables(mode: ThemeMode): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of colorTokens) vars[cssVarName(token)] = palette[token][mode];

  vars[cssVarName('font-mono')] = fonts.mono;
  vars[cssVarName('font-serif')] = fonts.serif;
  vars[cssVarName('font-size')] = `${metrics.fontSize}px`;
  vars[cssVarName('line-height')] = `${metrics.lineHeight}px`;
  vars[cssVarName('row-height')] = `${metrics.rowHeight}px`;
  vars[cssVarName('hairline')] = `${metrics.hairline}px`;
  vars[cssVarName('motion')] = `${motion.transitionMs}ms`;
  return vars;
}

/** The same map as a stylesheet, for injection into a view or webview. */
export function cssVariableBlock(mode: ThemeMode, selector = ':root'): string {
  const body = Object.entries(cssVariables(mode))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}
