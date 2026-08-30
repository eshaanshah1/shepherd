import {
  DEFAULT_THEME,
  cssVariables,
  themes,
  xtermTheme,
  type Theme,
  type ThemeMode,
} from '@shepherd/design-tokens';

/**
 * The SKIN the app paints in, in ONE place — the same argument
 * `DEFAULT_THEME_MODE` makes one line down, for the other axis.
 *
 * A mode is light or dark; a skin is which ramp, which faces and which job each
 * hue carries (`@shepherd/design-tokens/themes.ts`). They are independent, and
 * the app currently has one skin and two modes — so this is a constant with one
 * name rather than a setting, and everything that has to agree about the app's
 * appearance reads it: the chrome's variables, the grid's ANSI table, the
 * pane-chrome background the foreground is measured from.
 *
 * When a skin becomes a setting it replaces this the way `shepherd.theme`
 * replaced the mode constant: one value arriving one push after mount, with this
 * as what is on screen until it does.
 */
export const APP_THEME: Theme = themes[DEFAULT_THEME];

/**
 * The mode the first paint uses, in ONE place.
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
 *
 * It stopped being the ANSWER when `shepherd.theme` landed: the setting is main's
 * and arrives one push after mount, so this is the value on screen until it does.
 * Left dark deliberately — a flash of light on a dark setup is the worse of the
 * two, and the push is milliseconds away.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * Watch the OS's own light/dark preference.
 *
 * A seam rather than a `window.matchMedia` call at the call site, because the API
 * may be ABSENT: jsdom has none, and a page that threw on mount there would take
 * every renderer test with it — which is exactly what happened when this was
 * inlined. Absent resolves to DARK, matching `DEFAULT_THEME_MODE`, so an
 * environment that cannot answer keeps the app looking the way it already did.
 */
export function watchPrefersDark(onChange: () => void): { prefersDark(): boolean; dispose(): void } {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  query?.addEventListener('change', onChange);
  return {
    prefersDark: () => query?.matches ?? true,
    dispose: () => query?.removeEventListener('change', onChange),
  };
}

/**
 * `shepherd.theme` → the mode to paint.
 *
 * `system` is resolved in the RENDERER against `matchMedia`, in one place, and it
 * re-resolves on its own when the OS flips. An Electron `nativeTheme` mirror in
 * main would be a second copy of an answer the page can already see, and the two
 * would disagree during a theme change — which is exactly the class of bug the
 * one-token-map rule exists to prevent.
 */
export function resolveThemeMode(setting: string, prefersDark: boolean): ThemeMode {
  if (setting === 'dark' || setting === 'light') return setting;
  // Anything else — `system`, or a value written by a build that knows a mode this
  // one does not — follows the OS. A stored value we cannot read is not a reason
  // to ignore the user's own OS-level choice.
  return prefersDark ? 'dark' : 'light';
}

/**
 * The colour the grid is actually painted with — the input the pane chrome
 * measures. A pane will eventually carry its own (an extension may theme one
 * terminal and not its neighbour), and when it does this is the fallback, not
 * the answer.
 */
export function terminalBackground(mode: ThemeMode = DEFAULT_THEME_MODE): string {
  return xtermTheme(mode, APP_THEME).background;
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
  for (const [name, value] of Object.entries(cssVariables(mode, undefined, APP_THEME))) {
    root.style.setProperty(name, value);
  }
  root.dataset['theme'] = mode;
  /*
   * The skin's NAME on the root, beside the mode.
   *
   * Almost everything a skin changes is a variable and needs no selector. Two
   * things are not values at all — a refusal (this skin runs no looping
   * animation, so the working meter is a static silhouette) and a shape — and a
   * rule cannot be written against a colour. The attribute is what those rules
   * hang off, and it is set here so there is exactly one statement of which skin
   * is on screen.
   */
  root.dataset['skin'] = APP_THEME.name;
}
