import { cssVariables, type ThemeMode } from '@shepherd/design-tokens';

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
