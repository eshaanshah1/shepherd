import { color, type ThemeMode } from './palette.ts';

/**
 * The subset of xterm.js's ITheme we set. Typed structurally so this package
 * never has to depend on @xterm/xterm — tokens are data (boundary rule).
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Rule 2 in the terminal: the grid is the same surface as the chrome, so the
 * ANSI slots are drawn from the same named accents rather than a stock scheme.
 * magenta/cyan have no Flock job (no purple, rule 2) — they borrow the nearest
 * accent rather than introducing a fourteenth colour.
 */
export function xtermTheme(mode: ThemeMode): XtermTheme {
  const c = (token: Parameters<typeof color>[0]) => color(token, mode);
  return {
    background: c('ink-term'),
    foreground: c('wool'),
    cursor: c('signal'),
    cursorAccent: c('ink-term'),
    selectionBackground: c('ink-line'),

    black: c('ink-deep'),
    red: c('ember'),
    green: c('pasture'),
    yellow: c('hay'),
    blue: c('cobalt'),
    magenta: c('signal'),
    cyan: c('cobalt'),
    white: c('wool-dim'),

    brightBlack: c('wool-faint'),
    brightRed: c('ember'),
    brightGreen: c('pasture'),
    brightYellow: c('signal'),
    brightBlue: c('cobalt'),
    brightMagenta: c('signal'),
    brightCyan: c('cobalt'),
    brightWhite: c('wool'),
  };
}
