import { describe, expect, it } from 'vitest';
import { colorTokens, palette } from './palette.ts';
import { roleNames, roleToken, roleValue } from './roles.ts';
import { cssVariables } from './css.ts';
import { metrics } from './metrics.ts';
import { relativeLuminance } from './contrast.ts';
import { DEFAULT_THEME, resolveTheme, themeNames, themes } from './themes.ts';

const HEX = /^#[0-9A-F]{6}$/;
const modes = ['dark', 'light'] as const;

/**
 * The prototype's accent, which this skin does NOT take.
 *
 * Written out here rather than described, because "amber must not appear" is the
 * one instruction in the takeover brief that a reviewer cannot check by reading
 * a role name — a hex smuggled into any table is invisible to every other test
 * in this package.
 */
const PROTOTYPE_AMBER = '#E5A63F';

describe('every theme', () => {
  it.each(themeNames)('%s gives every token a dark value, a light value and a job', (name) => {
    const theme = themes[name];
    for (const token of colorTokens) {
      const spec = theme.palette[token];
      expect(spec.dark, `${token}.dark`).toMatch(HEX);
      expect(spec.light, `${token}.light`).toMatch(HEX);
      expect(spec.job.length, `${token}.job`).toBeGreaterThan(0);
    }
  });

  it.each(themeNames)('%s changes every token with the mode', (name) => {
    // The package's standing rule: a value that is the same in both modes is a
    // value one of the two modes has not been designed for.
    const theme = themes[name];
    for (const token of colorTokens) {
      expect(theme.palette[token].dark, token).not.toBe(theme.palette[token].light);
    }
  });

  it.each(themeNames)('%s carries a role for every role name', (name) => {
    const theme = themes[name];
    for (const role of roleNames) expect(theme.roles[role], role).toBeDefined();
  });

  it.each(themeNames)('%s emits exactly the variables the built-in skin does', (name) => {
    /*
     * A skin re-points names; it may not invent or drop one. If it could, a
     * stylesheet would be correct under one skin and paint nothing under
     * another — with no error anywhere, which is the failure `token-refs`
     * exists to prevent and would not catch across a theme swap.
     */
    const mine = Object.keys(cssVariables('dark', metrics, themes[name])).sort();
    const base = Object.keys(cssVariables('dark', metrics, themes.shepherd)).sort();
    expect(mine).toEqual(base);
  });
});

describe('the quiet-craft skin', () => {
  const theme = themes['quiet-craft'];

  it('spends no amber anywhere — the accent is the app’s own sky', () => {
    for (const token of colorTokens) {
      for (const mode of modes) {
        expect(theme.palette[token][mode].toUpperCase(), token).not.toBe(PROTOTYPE_AMBER);
      }
    }
  });

  it('reuses the shipped sky rather than inventing a second one', () => {
    // The prototype's accent was amber and this skin's is not; the instruction
    // that replaced it said to REUSE the existing value, so an override here —
    // even a flattering one — would be the drift rule 10 is about.
    expect(theme.palette.sky).toEqual(palette.sky);
    expect(theme.palette.skyDim).toEqual(palette.skyDim);
  });

  it('says “your move” in exactly one colour, and it is sky', () => {
    expect(roleToken('markWaiting', theme)).toBe('sky');
    expect(roleToken('markReady', theme)).toBe('sky');
  });

  it('draws the working mark with no hue at all', () => {
    /*
     * The whole skin in one assertion: hue means off-nominal, and work in
     * flight is the normal case. The built-in skin disagrees — it paints the
     * working meter `sky` — so this is a real difference rather than a
     * restatement.
     */
    expect(roleToken('markWorking', theme)).toBe('inkMute');
    expect(roleToken('markWorkingOff', theme)).toBe('inkGhost');
    expect(roleToken('markWorking', themes.shepherd)).toBe('sky');
  });

  it('keeps failure red and the diff numbers green and clay', () => {
    expect(roleToken('markFailed', theme)).toBe('red');
    expect(roleToken('grass', theme)).toBe('grass');
    expect(roleToken('clay', theme)).toBe('clay');
  });

  it('is warm-biased on every dark ramp step — red ≥ green ≥ blue', () => {
    /*
     * The built-in ramp is true neutral and has a test saying so. This one is
     * the opposite claim, and it is the claim: every step of the ladder and the
     * ink over it leans warm, which is what makes the two skins read as
     * different designs rather than as one design with the contrast nudged.
     */
    const ladder = [
      'sunken',
      'canvas',
      'pane',
      'surface',
      'well',
      'wash',
      'raised',
      'active',
      'fill',
      'line',
      'lineStrong',
      'lineActive',
      'ink',
      'inkQuiet',
      'inkDim',
      'inkFaint',
      'inkMute',
      'inkGhost',
    ] as const;
    for (const token of ladder) {
      const hex = theme.palette[token].dark;
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
      expect(r, `${token} red`).toBeGreaterThanOrEqual(g);
      expect(g, `${token} green`).toBeGreaterThanOrEqual(b);
      expect(r, `${token} is not neutral`).toBeGreaterThan(b);
    }
  });

  it('climbs: every surface step is lighter than the one under it, in dark', () => {
    const steps = ['sunken', 'canvas', 'pane', 'well', 'raised', 'fill'] as const;
    const lumens = steps.map((token) => relativeLuminance(theme.palette[token].dark));
    for (let i = 1; i < lumens.length; i += 1) {
      expect(lumens[i], `${steps[i]} over ${steps[i - 1]}`).toBeGreaterThan(lumens[i - 1] as number);
    }
  });

  it('inverts on paper: the same steps descend in light', () => {
    const steps = ['canvas', 'wash', 'fill'] as const;
    const lumens = steps.map((token) => relativeLuminance(theme.palette[token].light));
    for (let i = 1; i < lumens.length; i += 1) {
      expect(lumens[i], `${steps[i]} under ${steps[i - 1]}`).toBeLessThan(lumens[i - 1] as number);
    }
  });

  it('sets the app’s face and the machine’s, and leaves the grid’s alone', () => {
    expect(theme.fonts.sans).toContain('Instrument Sans');
    expect(theme.fonts.data).toContain('Fragment Mono');
    // The grid needs the Nerd Font patch whatever the skin says — a codepoint
    // with no glyph is a tofu box, and macOS's cascade covers no PUA.
    expect(theme.fonts.mono).toBe(themes.shepherd.fonts.mono);
  });
});

describe('the built-in skin', () => {
  it('answers exactly as it did before skins existed', () => {
    for (const mode of modes) {
      for (const role of roleNames) {
        expect(roleValue(role, mode, themes.shepherd), role).toBe(roleValue(role, mode));
      }
    }
  });

  it('resolves `data` to `mono`, so a rule reading it is correct under either skin', () => {
    const vars = cssVariables('dark', metrics, themes.shepherd);
    expect(vars['--sh-font-data']).toBe(vars['--sh-font-mono']);
    const quiet = cssVariables('dark', metrics, themes['quiet-craft']);
    expect(quiet['--sh-font-data']).not.toBe(quiet['--sh-font-mono']);
  });
});

describe('resolveTheme', () => {
  it('answers the default for a name this build does not know', () => {
    expect(resolveTheme(undefined)).toBe(themes[DEFAULT_THEME]);
    expect(resolveTheme('a-skin-from-the-future')).toBe(themes[DEFAULT_THEME]);
    expect(resolveTheme('shepherd')).toBe(themes.shepherd);
  });
});
