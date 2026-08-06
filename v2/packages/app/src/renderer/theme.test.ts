// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cssVariables, palette } from '@shepherd/design-tokens';
import { applyThemeVariables } from './theme.ts';

describe('applyThemeVariables', () => {
  it('puts the whole generated map on the element', () => {
    const root = document.createElement('div');
    applyThemeVariables(root, 'dark');

    for (const [name, value] of Object.entries(cssVariables('dark'))) {
      expect(root.style.getPropertyValue(name), name).toBe(value);
    }
    expect(root.dataset['theme']).toBe('dark');
  });

  it('re-applies over itself, which is what a live theme swap is', () => {
    const root = document.createElement('div');
    applyThemeVariables(root, 'dark');
    expect(root.style.getPropertyValue('--sh-ink')).toBe(palette.ink.dark);

    applyThemeVariables(root, 'light');
    expect(root.style.getPropertyValue('--sh-ink')).toBe(palette.ink.light);
    expect(root.dataset['theme']).toBe('light');
  });
});
