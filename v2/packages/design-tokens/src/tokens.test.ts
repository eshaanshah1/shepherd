import { describe, expect, it } from 'vitest';
import { colorTokens, palette } from './palette.ts';
import { cssVarName, cssVariableBlock, cssVariables } from './css.ts';
import { xtermTheme } from './xterm.ts';
import { metrics } from './metrics.ts';

const HEX = /^#[0-9A-F]{6}$/;

describe('palette', () => {
  it('carries all 13 approved tokens', () => {
    expect(colorTokens).toHaveLength(13);
    expect(colorTokens).toContain('ink-deep');
    expect(colorTokens).toContain('signal');
  });

  it('gives every token a dark value, a light value and a job', () => {
    for (const token of colorTokens) {
      const spec = palette[token];
      expect(spec.dark, `${token}.dark`).toMatch(HEX);
      expect(spec.light, `${token}.light`).toMatch(HEX);
      expect(spec.job.length, `${token}.job`).toBeGreaterThan(0);
    }
  });

  it('pins the canonical dark values from the approved mock', () => {
    expect(palette['ink-deep'].dark).toBe('#14120E');
    expect(palette['ink-term'].dark).toBe('#161410');
    expect(palette.wool.dark).toBe('#E9E2D2');
    expect(palette.cobalt.dark).toBe('#62A3FF');
    expect(palette.hay.dark).toBe('#E0A33E');
    expect(palette.pasture.dark).toBe('#85BB64');
    expect(palette.ember.dark).toBe('#E85D43');
    expect(palette.signal.dark).toBe('#F2762E');
  });

  it('inverts wool-dim and wool-faint between modes, as the table specifies', () => {
    expect(palette['wool-dim'].light).toBe(palette['wool-faint'].dark);
    expect(palette['wool-faint'].light).toBe(palette['wool-dim'].dark);
  });

  it('has no two tokens sharing a dark value (each step is a real step)', () => {
    const inks = colorTokens.filter((t) => t.startsWith('ink')).map((t) => palette[t].dark);
    expect(new Set(inks).size).toBe(inks.length);
  });
});

describe('cssVariables', () => {
  it('namespaces every variable under --sh-', () => {
    for (const name of Object.keys(cssVariables('dark'))) {
      expect(name.startsWith('--sh-')).toBe(true);
    }
  });

  it('emits one variable per colour token plus the metric/font set', () => {
    const vars = cssVariables('dark');
    for (const token of colorTokens) {
      expect(vars[cssVarName(token)]).toBe(palette[token].dark);
    }
    expect(vars['--sh-row-height']).toBe(`${metrics.rowHeight}px`);
    expect(vars['--sh-line-height']).toBe(`${metrics.lineHeight}px`);
  });

  it('changes with the mode', () => {
    expect(cssVariables('light')['--sh-ink']).toBe(palette.ink.light);
    expect(cssVariables('dark')['--sh-ink']).toBe(palette.ink.dark);
  });

  it('renders a stylesheet block against the given selector', () => {
    const block = cssVariableBlock('dark', ':root[data-theme="dark"]');
    expect(block.startsWith(':root[data-theme="dark"] {\n')).toBe(true);
    expect(block).toContain(`  --sh-cobalt: ${palette.cobalt.dark};`);
    expect(block.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('xtermTheme', () => {
  it('paints the grid on the terminal ink, not the surface ink', () => {
    expect(xtermTheme('dark').background).toBe(palette['ink-term'].dark);
    expect(xtermTheme('dark').foreground).toBe(palette.wool.dark);
  });

  it('maps the ANSI slots onto named accents so the colour jobs survive', () => {
    const theme = xtermTheme('dark');
    expect(theme.red).toBe(palette.ember.dark);
    expect(theme.green).toBe(palette.pasture.dark);
    expect(theme.yellow).toBe(palette.hay.dark);
    expect(theme.blue).toBe(palette.cobalt.dark);
    expect(theme.cursor).toBe(palette.signal.dark);
  });

  it('uses no colour outside the palette', () => {
    const allowed = new Set(colorTokens.flatMap((t) => [palette[t].dark, palette[t].light]));
    for (const value of Object.values(xtermTheme('light'))) {
      expect(allowed.has(value), value).toBe(true);
    }
  });
});
