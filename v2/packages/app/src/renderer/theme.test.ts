// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cssVariables } from '@shepherd/design-tokens';
import { APP_THEME, applyThemeVariables, resolveThemeMode } from './theme.ts';

describe('applyThemeVariables', () => {
  it('puts the whole generated map on the element', () => {
    const root = document.createElement('div');
    applyThemeVariables(root, 'dark');

    /*
     * The map of the SKIN the app is painted in, not of the built-in one — the
     * two axes are independent, and reading `cssVariables('dark')` here would
     * have asserted the built-in ramp against a window wearing another.
     */
    for (const [name, value] of Object.entries(cssVariables('dark', undefined, APP_THEME))) {
      expect(root.style.getPropertyValue(name), name).toBe(value);
    }
    expect(root.dataset['theme']).toBe('dark');
    // The skin travels beside the mode: two rules in the app hang off it — the
    // refusal of the looping meter, and nothing that is a colour.
    expect(root.dataset['skin']).toBe(APP_THEME.name);
  });

  it('re-applies over itself, which is what a live theme swap is', () => {
    const root = document.createElement('div');
    applyThemeVariables(root, 'dark');
    expect(root.style.getPropertyValue('--sh-text')).toBe(APP_THEME.palette.ink.dark);

    applyThemeVariables(root, 'light');
    expect(root.style.getPropertyValue('--sh-text')).toBe(APP_THEME.palette.ink.light);
    expect(root.dataset['theme']).toBe('light');
  });
});

describe('resolveThemeMode', () => {
  it('pins to what was chosen, whatever the OS says', () => {
    expect(resolveThemeMode('dark', true)).toBe('dark');
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('light', false)).toBe('light');
  });

  it('follows the OS for `system`', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
  });

  it('follows the OS for a value it cannot read, rather than picking for the user', () => {
    // Reachable from a store written by a newer build. Ignoring the OS-level
    // choice because our own value is unreadable would be the wrong recovery.
    expect(resolveThemeMode('sepia', false)).toBe('light');
    expect(resolveThemeMode('', true)).toBe('dark');
  });
});
