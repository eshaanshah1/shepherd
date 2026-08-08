import { describe, expect, it } from 'vitest';
import {
  LIGHT_SURFACE_LUMINANCE,
  minimumContrastRatio,
  paneTitleAlphas,
  paneTitleInk,
  paneTitleSurface,
  relativeLuminance,
  withAlpha,
} from './contrast.ts';
import { palette } from './palette.ts';
import { cssVariables } from './css.ts';
import { xtermTheme } from './xterm.ts';

describe('relativeLuminance', () => {
  it('anchors at black and white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 12);
  });

  it('weights green far above blue, as the sRGB coefficients do', () => {
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 6);
  });

  it('accepts the shorthand and the case the palette does not use', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(relativeLuminance('#FFFFFF'), 12);
  });

  it('refuses anything that is not a colour, rather than reading it as black', () => {
    // A silent 0 here would classify every malformed background as "dark" — the
    // exact failure this whole file exists to make impossible.
    expect(() => relativeLuminance('rgb(0 0 0)')).toThrow(/not a #RRGGBB colour/);
    expect(() => relativeLuminance('')).toThrow();
  });
});

describe('paneTitleSurface', () => {
  /**
   * THE threshold test. If the comparison in `paneTitleSurface` is flipped, this
   * is the case that says so by name — a pale surface must not be read as dark.
   */
  it('flips exactly where black ink and white ink are equally legible', () => {
    // #757575 sits just under the crossover, #767676 just over it. One grey step.
    expect(relativeLuminance('#757575')).toBeLessThan(LIGHT_SURFACE_LUMINANCE);
    expect(relativeLuminance('#767676')).toBeGreaterThan(LIGHT_SURFACE_LUMINANCE);
    expect(paneTitleSurface('#757575')).toBe('dark');
    expect(paneTitleSurface('#767676')).toBe('light');
  });

  it('puts the crossover well below "half bright"', () => {
    // The guess this replaces is `luminance > 0.5`. Mid-grey is the case that
    // separates them, and it wants dark ink.
    expect(LIGHT_SURFACE_LUMINANCE).toBeCloseTo(0.1791, 4);
    expect(paneTitleSurface('#808080')).toBe('light');
  });

  it('reads both terminal backgrounds the palette ships', () => {
    expect(paneTitleSurface(palette['ink-term'].dark)).toBe('dark');
    expect(paneTitleSurface(palette['ink-term'].light)).toBe('light');
  });

  it('is decided by the colour, not by the app mode', () => {
    // The reason the helper takes a hex and not a `ThemeMode`: an extension may
    // ship a light terminal palette inside a dark app, and the pane chrome has to
    // follow the pane. A mode-keyed version of this cannot express the case.
    expect(paneTitleSurface(palette['ink-term'].light)).not.toBe(
      paneTitleSurface(palette['ink-term'].dark),
    );
    expect(paneTitleSurface('#FFFFFF')).toBe('light');
    expect(paneTitleSurface('#000000')).toBe('dark');
  });
});

describe('paneTitleAlphas', () => {
  it('carries the on-dark table verbatim', () => {
    expect(paneTitleAlphas.dark).toEqual({
      fg: 0.52,
      strong: 0.7,
      faint: 0.38,
      fill: 0.04,
      rule: 0.06,
    });
  });

  it('carries the on-light table verbatim', () => {
    expect(paneTitleAlphas.light).toEqual({
      fg: 0.64,
      strong: 0.82,
      faint: 0.48,
      fill: 0.05,
      rule: 0.1,
    });
  });

  it('keeps the asymmetry: dark ink on light needs more weight than the reverse', () => {
    // Not decoration — this is the finding. Mirroring one table onto the other
    // is the "simplification" that would leave a light pane's chrome washed out.
    for (const role of ['fg', 'strong', 'faint', 'fill', 'rule'] as const) {
      expect(paneTitleAlphas.light[role], role).toBeGreaterThan(paneTitleAlphas.dark[role]);
    }
  });

  it('orders the roles: the title reads strongest, the rule faintest', () => {
    for (const kind of ['dark', 'light'] as const) {
      const a = paneTitleAlphas[kind];
      expect(a.strong).toBeGreaterThan(a.fg);
      expect(a.fg).toBeGreaterThan(a.faint);
      expect(a.faint).toBeGreaterThan(a.fill);
      expect(a.rule).toBeLessThan(a.faint);
    }
  });
});

describe('paneTitleInk', () => {
  it('takes the ink from the palette, one mode value per surface kind', () => {
    expect(paneTitleInk('dark')).toBe(palette.wool.dark);
    expect(paneTitleInk('light')).toBe(palette.wool.light);
  });

  it('always picks the ink that actually contrasts with the surface', () => {
    // The property behind the mapping: whatever the surface, the ink is on the
    // other side of the crossover from it.
    expect(paneTitleSurface(paneTitleInk('dark'))).toBe('light');
    expect(paneTitleSurface(paneTitleInk('light'))).toBe('dark');
  });
});

describe('withAlpha', () => {
  it('emits the space-separated rgb form with a clean percentage', () => {
    expect(withAlpha('#E9E2D2', 0.52)).toBe('rgb(233 226 210 / 52%)');
    expect(withAlpha('#2B2620', 0.1)).toBe('rgb(43 38 32 / 10%)');
    expect(withAlpha('#000000', 0.04)).toBe('rgb(0 0 0 / 4%)');
  });

  it('does not leak binary floating point into the stylesheet', () => {
    for (const alphas of Object.values(paneTitleAlphas)) {
      for (const alpha of Object.values(alphas)) {
        expect(withAlpha('#FFFFFF', alpha)).not.toMatch(/\d{4,}%/);
      }
    }
  });
});

describe('minimumContrastRatio', () => {
  it('is 4.5 on light and 3 on dark', () => {
    // The lower dark floor is measured, not a rounding: forcing a saturated ANSI
    // colour to 4.5:1 against near-black washes it out toward white.
    expect(minimumContrastRatio('light')).toBe(4.5);
    expect(minimumContrastRatio('dark')).toBe(3);
  });

  it('reaches xterm through the same reading the chrome uses', () => {
    // One source for "is this a light surface": the background the grid is
    // actually painted with.
    expect(minimumContrastRatio(paneTitleSurface(xtermTheme('dark').background))).toBe(3);
    expect(minimumContrastRatio(paneTitleSurface(xtermTheme('light').background))).toBe(4.5);
  });
});

describe('the pane-chrome variables', () => {
  it('emits both surface sets in both modes, because a pane picks, not the app', () => {
    for (const mode of ['dark', 'light'] as const) {
      const vars = cssVariables(mode);
      for (const kind of ['dark', 'light'] as const) {
        expect(vars[`--sh-pane-title-fg-on-${kind}`]).toBe(
          withAlpha(paneTitleInk(kind), paneTitleAlphas[kind].fg),
        );
        expect(vars[`--sh-pane-title-strong-on-${kind}`]).toBe(
          withAlpha(paneTitleInk(kind), paneTitleAlphas[kind].strong),
        );
        expect(vars[`--sh-pane-title-faint-on-${kind}`]).toBe(
          withAlpha(paneTitleInk(kind), paneTitleAlphas[kind].faint),
        );
        expect(vars[`--sh-pane-title-rule-on-${kind}`]).toBe(
          withAlpha(paneTitleInk(kind), paneTitleAlphas[kind].rule),
        );
      }
    }
  });

  it('does not vary the pane-chrome set with the app mode', () => {
    const dark = cssVariables('dark');
    const light = cssVariables('light');
    for (const name of Object.keys(dark)) {
      if (!name.startsWith('--sh-pane-title-')) continue;
      expect(light[name], name).toBe(dark[name]);
    }
  });
});
