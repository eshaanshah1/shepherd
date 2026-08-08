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
 * the numbers that were approved. These cases are the mock's own integers — 9 /
 * 10 / 11 / 12 / 13 / 15 / 17 of type, 22 / 28 / 34 of control, 4 / 6 / 8 / 12 /
 * 14 of space, 20 of line box, 28 of row — asserted against `round(base * ratio)`
 * rather than against a literal. Change a ratio and the named case below says
 * which value moved.
 */
describe('the derived scale at the approved defaults', () => {
  it('takes exactly two inputs', () => {
    expect(defaultScaleInputs.baseFontSize).toBe(13);
    expect(defaultScaleInputs.density).toBe(densities.comfortable);
    expect(densities.comfortable).toBe(1);
  });

  it('produces the approved type scale', () => {
    expect(metrics.type.nano).toBe(9);
    expect(metrics.type.micro).toBe(10);
    expect(metrics.type.small).toBe(11);
    expect(metrics.type.medium).toBe(12);
    expect(metrics.type.body).toBe(13);
    expect(metrics.type.large).toBe(15);
    expect(metrics.type.title).toBe(17);
  });

  it('produces the approved control heights, 22 / 28 / 34', () => {
    expect(metrics.control.sm).toBe(22);
    expect(metrics.control.md).toBe(28);
    expect(metrics.control.lg).toBe(34);
  });

  it('produces the approved space scale', () => {
    expect(metrics.space).toEqual({ xs: 4, sm: 6, md: 8, lg: 12, xl: 14 });
  });

  it('produces the two industrial radii and the one soft one', () => {
    expect(metrics.radius).toEqual({ sm: 4, md: 6, soft: 16 });
  });

  it('produces the 20px line box and the 28px row', () => {
    expect(metrics.lineHeight).toBe(20);
    expect(metrics.rowHeight).toBe(28);
  });

  it('derives the micro-label size rather than typing it twice', () => {
    expect(metrics.microLabel.fontSize).toBe(metrics.type.micro);
    expect(metrics.microLabel.trackingMin).toBe(0.1);
    expect(metrics.microLabel.trackingMax).toBe(0.16);
  });

  it('matches a medium control to the row height, by sharing the ratio', () => {
    // Orca's rule: a control matches the row height around it. Expressed as one
    // shared number so the two cannot drift when either input moves.
    expect(ratios.control.md).toBe(ratios.row);
    expect(metrics.control.md).toBe(metrics.rowHeight);
  });

  it('emits nothing fractional', () => {
    const all = [
      ...Object.values(metrics.type),
      ...Object.values(metrics.control),
      ...Object.values(metrics.space),
      ...Object.values(metrics.radius),
      metrics.lineHeight,
      metrics.rowHeight,
      metrics.hairline,
    ];
    for (const value of all) expect(Number.isInteger(value), `${value}`).toBe(true);
  });
});

describe('the derivation under other inputs', () => {
  const spacious = deriveMetrics({ baseFontSize: 13, density: densities.spacious });

  it('scales heights and spacing with density, at 1.15', () => {
    expect(spacious.rowHeight).toBe(32);
    expect(spacious.control).toEqual({ sm: 25, md: 32, lg: 39 });
    expect(spacious.space).toEqual({ xs: 5, sm: 7, md: 9, lg: 14, xl: 16 });
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
    expect(big.rowHeight).toBe(34);
    expect(big.lineHeight).toBe(25);
    expect(big.radius.soft).toBe(20);
  });

  it('stays monotonic at every density mode', () => {
    for (const density of Object.values(densities)) {
      const scale = deriveMetrics({ baseFontSize: 13, density });
      expect(scale.control.sm).toBeLessThan(scale.control.md);
      expect(scale.control.md).toBeLessThan(scale.control.lg);
      expect(scale.space.xs).toBeLessThan(scale.space.sm);
      expect(scale.space.sm).toBeLessThan(scale.space.md);
      expect(scale.space.md).toBeLessThan(scale.space.lg);
      expect(scale.space.lg).toBeLessThan(scale.space.xl);
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
    expect(vars['--sh-font-size-title']).toBe('17px');
    expect(vars['--sh-font-size-nano']).toBe('9px');
    expect(vars['--sh-control-sm']).toBe('22px');
    expect(vars['--sh-control-lg']).toBe('34px');
    expect(vars['--sh-space-md']).toBe('8px');
    expect(vars['--sh-radius-soft']).toBe('16px');
    expect(vars['--sh-micro-font-size']).toBe('10px');
    expect(vars['--sh-micro-tracking']).toBe('0.1em');
    expect(vars['--sh-micro-tracking-wide']).toBe('0.16em');
  });

  it('takes a scale, so a settings surface is one argument away', () => {
    const vars = cssVariables('dark', deriveMetrics({ baseFontSize: 13, density: densities.compact }));
    expect(vars['--sh-row-height']).toBe('24px');
    expect(vars['--sh-density']).toBe('0.85');
    // …and the colours are untouched by it.
    expect(vars['--sh-surface']).toBe(cssVariables('dark')['--sh-surface']);
  });
});
