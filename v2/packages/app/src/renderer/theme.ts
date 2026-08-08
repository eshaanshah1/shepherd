import { cssVariables, xtermTheme, type ThemeMode } from '@shepherd/design-tokens';

/**
 * The mode this build starts in, in ONE place.
 *
 * It was typed three times ('dark' at the theme push, at the terminal factory,
 * and implicitly wherever chrome guessed what the grid looked like), and three
 * copies of a default is how a theme swap ships half-applied. M1's
 * `contributes.themes` replaces this with a value; until then it is a constant
 * with one name.
 *
 * Note what it is NOT used for: nothing decides a *foreground* from it. That
 * decision is `paneTitleSurface`'s, off the measured background — see
 * `terminalBackground` below and the pane chrome in `terminal-pane.tsx`.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * The colour the grid is actually painted with — the input the pane chrome
 * measures. A pane will eventually carry its own (an extension may theme one
 * terminal and not its neighbour), and when it does this is the fallback, not
 * the answer.
 */
export function terminalBackground(mode: ThemeMode = DEFAULT_THEME_MODE): string {
  return xtermTheme(mode).background;
}

/**
 * Push the generated token map onto an element as CSS custom properties.
 *
 * Nothing in the renderer's stylesheet may contain a colour: every rule reads a
 * `--sh-*` variable set here. That is what makes a theme swap (M1's
 * `contributes.themes`) a matter of calling this again with a different map,
 * and what keeps the chrome and the terminal grid on one palette — see the
 * "one token map" cases in @shepherd/design-tokens.
 */
export function applyThemeVariables(root: HTMLElement, mode: ThemeMode): void {
  for (const [name, value] of Object.entries(cssVariables(mode))) {
    root.style.setProperty(name, value);
  }
  root.dataset['theme'] = mode;
}
