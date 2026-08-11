import { describe, expect, it } from 'vitest';
import {
  defaultScaleInputs,
  densities,
  deriveMetrics,
  lines,
  metrics,
  ratios,
} from './metrics.ts';
import { cssVariables } from './css.ts';

/**
 * The scale is derived, and a derivation is only worth having if it reproduces
 * the numbers that were approved. These cases are Shepherd UI §2's own integers
 * — 10.5 / 11 / 11.5 / 12.5 / 13 / 14 / 16 / 19 of type, 24 / 28 / 34 of control,
 * `2 4 6 7 9 10 12 14 16 20` of space, `5 6 8 10 12 14 16` of radius, 34 of row,
 * and the fixed bands 28 / 38 / 40 / 44 / 124 / 332 — asserted against
 * `round(base * ratio)` rather than against a literal. Change a ratio and the
 * named case below says which value moved.
 */
describe('the derived scale at the approved defaults', () => {
  it('takes exactly two inputs', () => {
    expect(defaultScaleInputs.baseFontSize).toBe(13);
    expect(defaultScaleInputs.density).toBe(densities.comfortable);
    expect(densities.comfortable).toBe(1);
  });

  it('produces the approved type scale', () => {
    expect(metrics.type).toEqual({
      nano: 10.5,
      micro: 11,
      small: 11.5,
      medium: 12.5,
      body: 13,
      card: 14,
      large: 16,
      title: 19,
    });
  });

  it('produces the approved control heights, 24 / 28 / 34', () => {
    expect(metrics.control).toEqual({ sm: 24, md: 28, lg: 34 });
  });

  it('produces the approved space scale', () => {
    expect(metrics.space).toEqual({
      hair: 2,
      xs: 4,
      sm: 6,
      snug: 7,
      md: 9,
      mid: 10,
      lg: 12,
      xl: 14,
      xxl: 16,
      huge: 20,
    });
  });

  it('produces the radius set `5 6 8 10 12 14 16`', () => {
    expect(metrics.radius).toEqual({ sm: 5, md: 6, row: 8, card: 10, window: 12, well: 14, soft: 16 });
  });

  it('produces the 20px line box and the 34px row', () => {
    expect(metrics.lineHeight).toBe(20);
    expect(metrics.rowHeight).toBe(34);
  });

  it('produces the fixed chrome bands the shell is built from', () => {
    // `a task holds tabs; a tab holds panes` — §5's hierarchy, as furniture.
    expect(metrics.band).toEqual({
      tab: 28,
      paneHead: 38,
      tabStrip: 40,
      titlebar: 44,
      skyStrip: 124,
      rail: 332,
    });
  });

  it('derives the micro-label size rather than typing it twice', () => {
    // The ONE surviving uppercase label: a ⌘K palette group heading at 10.5/600,
    // `0.05em`. §6 refuses uppercase micro-labels with tracking everywhere else,
    // which is why the two tracking values are now equal rather than a band.
    expect(metrics.microLabel.fontSize).toBe(metrics.type.nano);
    expect(metrics.microLabel.trackingMin).toBe(0.05);
    expect(metrics.microLabel.trackingMax).toBe(0.05);
  });

  it('matches a LARGE control to the row height, by sharing the ratio', () => {
    // A control matches the row height around it. Expressed as one shared number
    // so the two cannot drift when either input moves. The row grew from 28 to 34
    // with this language, so the control that matches it is `lg`, not `md` — and
    // `md` is now the tab, which is the other height a control sits inside.
    expect(ratios.control.lg).toBe(ratios.row);
    expect(metrics.control.lg).toBe(metrics.rowHeight);
    expect(ratios.control.md).toBe(ratios.band.tab);
    expect(metrics.control.md).toBe(metrics.band.tab);
  });

  it('keeps every LENGTH whole, and lets only type be fractional', () => {
    // The integer rule is about the 1px hairlines this language draws its whole
    // hierarchy in: a rule off a subpixel boundary is a blurred rule. A glyph is
    // antialiased at every size, so §2 can ask for 12.5 and get it for free.
    const lengths = [
      ...Object.values(metrics.control),
      ...Object.values(metrics.band),
      ...Object.values(metrics.space),
      ...Object.values(metrics.radius),
      metrics.lineHeight,
      metrics.rowHeight,
      metrics.hairline,
    ];
    for (const value of lengths) expect(Number.isInteger(value), `${value} is a fractional length`).toBe(true);
    for (const size of Object.values(metrics.type)) {
      expect(Number.isInteger(size * 2), `${size} is finer than a half pixel`).toBe(true);
    }
  });
});

describe('the derivation under other inputs', () => {
  const spacious = deriveMetrics({ baseFontSize: 13, density: densities.spacious });

  it('scales heights and spacing with density, at 1.15', () => {
    expect(spacious.rowHeight).toBe(39);
    expect(spacious.control).toEqual({ sm: 28, md: 32, lg: 39 });
    expect(spacious.space).toEqual({
      hair: 2,
      xs: 5,
      sm: 7,
      snug: 8,
      md: 10,
      mid: 12,
      lg: 14,
      xl: 16,
      xxl: 18,
      huge: 23,
    });
  });

  it('scales the chrome bands too — a compact user gets a compact frame', () => {
    expect(spacious.band.titlebar).toBe(51);
    expect(spacious.band.rail).toBe(382);
  });

  it('leaves TYPE alone when only density moves', () => {
    // Density is spacing. Type is the other input. A density mode that also
    // changed the type size would be one setting doing two jobs, and the user
    // asking for a roomier list would get bigger text they did not ask for.
    expect(spacious.type).toEqual(metrics.type);
    expect(spacious.lineHeight).toBe(metrics.lineHeight);
  });

  it('keeps the hairline at one device pixel at every density', () => {
    // A "scaled" 1.15px rule lands on a subpixel boundary and blurs, and with no
    // shadows the hairlines carry the whole hierarchy.
    for (const density of Object.values(densities)) {
      expect(deriveMetrics({ baseFontSize: 13, density }).hairline).toBe(1);
    }
  });

  it('keeps a corner off the density axis', () => {
    // A denser layout does not want rounder boxes; radius follows the base only.
    expect(spacious.radius).toEqual(metrics.radius);
  });

  it('moves the whole scale when the base moves', () => {
    const big = deriveMetrics({ baseFontSize: 16, density: 1 });
    expect(big.type.body).toBe(16);
    expect(big.rowHeight).toBe(42);
    expect(big.lineHeight).toBe(25);
    expect(big.radius.soft).toBe(20);
  });

  it('stays monotonic at every density mode', () => {
    const ORDER = ['hair', 'xs', 'sm', 'snug', 'md', 'mid', 'lg', 'xl', 'xxl', 'huge'] as const;
    for (const density of Object.values(densities)) {
      const scale = deriveMetrics({ baseFontSize: 13, density });
      expect(scale.control.sm).toBeLessThan(scale.control.md);
      expect(scale.control.md).toBeLessThan(scale.control.lg);
      // A scale that stops ascending is a step that has collided with its
      // neighbour, and at that point one of the two is doing nothing.
      for (let i = 1; i < ORDER.length; i += 1) {
        const [prev, step] = [ORDER[i - 1] as never, ORDER[i] as never];
        expect(scale.space[prev], `${prev} → ${step} at ${density}`).toBeLessThanOrEqual(scale.space[step]);
      }
    }
  });
});

describe('lines()', () => {
  it('expresses a height as N of the chrome line box, not a px guess', () => {
    expect(lines(2)).toBe('calc(2 * var(--sh-line-height))');
  });
});

describe('the scale in the emitted variable set', () => {
  it('emits every derived member', () => {
    const vars = cssVariables('dark');
    expect(vars['--sh-base-font-size']).toBe('13px');
    expect(vars['--sh-density']).toBe('1');
    expect(vars['--sh-font-size']).toBe('13px');
    expect(vars['--sh-font-size-title']).toBe('19px');
    expect(vars['--sh-font-size-nano']).toBe('10.5px');
    expect(vars['--sh-control-sm']).toBe('24px');
    expect(vars['--sh-control-lg']).toBe('34px');
    expect(vars['--sh-space-md']).toBe('9px');
    expect(vars['--sh-radius-soft']).toBe('16px');
    expect(vars['--sh-radius-card']).toBe('10px');
    expect(vars['--sh-band-titlebar']).toBe('44px');
    expect(vars['--sh-band-pane-head']).toBe('38px');
    expect(vars['--sh-micro-font-size']).toBe('10.5px');
    expect(vars['--sh-micro-tracking']).toBe('0.05em');
    expect(vars['--sh-micro-tracking-wide']).toBe('0.05em');
  });

  it('takes a scale, so a settings surface is one argument away', () => {
    const vars = cssVariables('dark', deriveMetrics({ baseFontSize: 13, density: densities.compact }));
    expect(vars['--sh-row-height']).toBe('29px');
    expect(vars['--sh-density']).toBe('0.85');
    // …and the colours are untouched by it.
    expect(vars['--sh-surface']).toBe(cssVariables('dark')['--sh-surface']);
  });
});
