// The normative Flock palette — the "Token values" table of
// docs/superpowers/specs/2026-08-06-ade-design-language.md, approved via the
// 2026-08-06 mock. Dark is canonical; light is the derived override.
//
// Rule 10: this file is the ONLY place a hex literal belongs. Chrome CSS, the
// xterm theme and (later) extension views are all generated from it.

export type ThemeMode = 'dark' | 'light';

export type ColorToken =
  | 'ink-deep'
  | 'ink'
  | 'ink-raised'
  | 'ink-line'
  | 'ink-term'
  | 'wool'
  | 'wool-dim'
  | 'wool-faint'
  | 'cobalt'
  | 'hay'
  | 'pasture'
  | 'ember'
  | 'signal';

export interface TokenSpec {
  readonly dark: string;
  readonly light: string;
  /** What the colour is *for*. Rule 3: saturated without a job is banned. */
  readonly job: string;
}

export const palette: Readonly<Record<ColorToken, TokenSpec>> = {
  'ink-deep': { dark: '#14120E', light: '#E6DFD0', job: 'window backdrop' },
  ink: { dark: '#1B1915', light: '#F3EEE1', job: 'surfaces' },
  'ink-raised': { dark: '#24211B', light: '#FAF6EA', job: 'hover / raised' },
  'ink-line': { dark: '#343027', light: '#D3CAB6', job: 'hairlines' },
  'ink-term': { dark: '#161410', light: '#FAF6EA', job: 'terminal background' },
  wool: { dark: '#E9E2D2', light: '#2B2620', job: 'primary text; inverse-video fill' },
  'wool-dim': { dark: '#A49B89', light: '#6E6759', job: 'secondary text' },
  'wool-faint': { dark: '#6E6759', light: '#A49B89', job: 'tertiary / idle' },
  cobalt: { dark: '#62A3FF', light: '#1F62D0', job: 'working / links / primary action' },
  hay: { dark: '#E0A33E', light: '#96690E', job: 'blocked / attention' },
  pasture: { dark: '#85BB64', light: '#47772C', job: 'done / success' },
  ember: { dark: '#E85D43', light: '#C23A22', job: 'error / urgent / dev build' },
  signal: { dark: '#F2762E', light: '#C85312', job: 'prompts / live affordances' },
};

export const colorTokens = Object.keys(palette) as ColorToken[];

export function color(token: ColorToken, mode: ThemeMode): string {
  return palette[token][mode];
}
