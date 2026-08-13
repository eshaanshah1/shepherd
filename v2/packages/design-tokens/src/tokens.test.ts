import { describe, expect, it } from 'vitest';
import { colorTokens, palette, type ColorToken, type ThemeMode } from './palette.ts';
import { cssVarName, cssVariableBlock, cssVariables } from './css.ts';
import { roleVarName } from './roles.ts';
import { xtermTheme, type XtermTheme } from './xterm.ts';
import { metrics } from './metrics.ts';

const HEX = /^#[0-9A-F]{6}$/;

describe('palette', () => {
  it('gives every token a dark value, a light value and a job', () => {
    for (const token of colorTokens) {
      const spec = palette[token];
      expect(spec.dark, `${token}.dark`).toMatch(HEX);
      expect(spec.light, `${token}.light`).toMatch(HEX);
      expect(spec.job.length, `${token}.job`).toBeGreaterThan(0);
    }
  });

  it('pins the canonical dark values from §2', () => {
    expect(palette.sunken.dark).toBe('#070708');
    expect(palette.canvas.dark).toBe('#0A0A0A');
    expect(palette.pane.dark).toBe('#0D0D0D');
    expect(palette.surface.dark).toBe('#0F0F0F');
    expect(palette.well.dark).toBe('#121212');
    expect(palette.raised.dark).toBe('#161616');
    expect(palette.fill.dark).toBe('#1B1B1B');
    expect(palette.line.dark).toBe('#1C1C1C');
    expect(palette.lineStrong.dark).toBe('#272727');
    expect(palette.ink.dark).toBe('#EDEDED');
    expect(palette.inkFaint.dark).toBe('#A8A8A8');
    expect(palette.inkMute.dark).toBe('#8C8C8C');
    expect(palette.inkGhost.dark).toBe('#5A5A5A');
    expect(palette.sky.dark).toBe('#7FB6E8');
    expect(palette.grass.dark).toBe('#86C06A');
    expect(palette.clay.dark).toBe('#C4796B');
    expect(palette.red.dark).toBe('#E05C4F');
  });

  it('pins the light ramp, which is derived rather than re-decided', () => {
    expect(palette.sunken.light).toBe('#F4F4F4');
    expect(palette.canvas.light).toBe('#EFEFEF');
    expect(palette.pane.light).toBe('#FFFFFF');
    expect(palette.surface.light).toBe('#FAFAFA');
    expect(palette.fill.light).toBe('#E4E4E4');
    expect(palette.line.light).toBe('#E2E2E2');
    expect(palette.lineStrong.light).toBe('#D2D2D2');
    expect(palette.inkFaint.light).toBe('#565656');
    expect(palette.inkMute.light).toBe('#6E6E6E');
    expect(palette.inkGhost.light).toBe('#767676');
    expect(palette.sky.light).toBe('#2E6FB8');
    expect(palette.grass.light).toBe('#3F7A50');
    expect(palette.clay.light).toBe('#A8483A');
    expect(palette.red.light).toBe('#C4392C');
  });

  it('turns `wool` into ink: on paper the loudest thing available is black', () => {
    // The one substantive change light makes beyond inverting the ramp. Everything
    // that carries "your move" in dark carries it in light for the same reason,
    // and that reason is "loudest against this surface", not "white".
    expect(palette.ink.dark).toBe('#EDEDED');
    expect(palette.ink.light).toBe('#141414');
  });

  it('is true neutral in dark — no cast on any ramp step', () => {
    // §2's first claim about the ramp, and the thing that separates it from
    // Flock's warm ink. A step whose channels are not equal is a step with a hue,
    // and a hue without a job is banned. `sunken` is the documented exception: one
    // point of blue at the very bottom, which is the design's own value.
    const ramp = ['canvas', 'pane', 'surface', 'well', 'wash', 'raised', 'active', 'fill', 'line', 'lineStrong'] as const;
    for (const token of ramp) {
      const [r, g, b] = [1, 3, 5].map((i) => palette[token].dark.slice(i, i + 2));
      expect(new Set([r, g, b]).size, `${token} = ${palette[token].dark} has a cast`).toBe(1);
    }
  });

  it('has no two ramp steps sharing a dark value — each step is a real step', () => {
    const ramp = colorTokens.filter((t) => !t.startsWith('repo') && !t.startsWith('scn') && t !== 'scrimBase');
    const inks = ramp.map((t) => palette[t].dark);
    // Light legitimately collapses `pane`, `well` and `raised` onto #FFFFFF —
    // paper has no room above white — so only dark is asserted to be all-distinct.
    expect(new Set(inks).size, 'a duplicated dark value is a step that does nothing').toBe(inks.length);
  });

  it('keeps grass out of the repo-identity set', () => {
    // Stated in §2: a repo tinted green would read as something that passed.
    for (const mode of ['dark', 'light'] as const) {
      const identity = (['repoSky', 'repoStone', 'repoTaupe', 'repoSlate'] as const).map((t) => palette[t][mode]);
      expect(identity).not.toContain(palette.grass[mode]);
    }
  });
});

describe('cssVariables', () => {
  it('namespaces every variable under --sh-', () => {
    for (const name of Object.keys(cssVariables('dark'))) {
      expect(name.startsWith('--sh-')).toBe(true);
    }
  });

  it('emits the role set plus the metric/font set, and no palette name', () => {
    const vars = cssVariables('dark');
    expect(vars['--sh-canvas']).toBe(palette.canvas.dark);
    expect(vars['--sh-text']).toBe(palette.ink.dark);
    expect(vars['--sh-row-height']).toBe(`${metrics.rowHeight}px`);
    expect(vars['--sh-line-height']).toBe(`${metrics.lineHeight}px`);
    // Tier 1 is private; `--sh-ink` is a luminance step's own name and a
    // stylesheet may not reach it. See the roles suite for the full guarantee.
    expect(vars['--sh-ink']).toBeUndefined();
  });

  it('carries the chrome bands the shell is built from', () => {
    const vars = cssVariables('dark');
    // The three that never move: an OS constant, a drawing, and a content
    // measurement. The rest follow the shipped density (`compact`).
    expect(vars['--sh-band-titlebar']).toBe('44px');
    expect(vars['--sh-band-rail']).toBe('264px');
    expect(vars['--sh-band-sky-strip']).toBe('124px');
    expect(vars['--sh-band-tab-strip']).toBe('34px');
    expect(vars['--sh-band-pane-head']).toBe('32px');
    expect(vars['--sh-band-tab']).toBe('24px');
  });

  it('changes with the mode', () => {
    expect(cssVariables('light')['--sh-canvas']).toBe(palette.canvas.light);
    expect(cssVariables('dark')['--sh-canvas']).toBe(palette.canvas.dark);
  });

  it('renders a stylesheet block against the given selector', () => {
    const block = cssVariableBlock('dark', ':root[data-theme="dark"]');
    expect(block.startsWith(':root[data-theme="dark"] {\n')).toBe(true);
    expect(block).toContain(`  --sh-sky: ${palette.sky.dark};`);
    expect(block.trimEnd().endsWith('}')).toBe(true);
  });
});

/**
 * The reason this package exists.
 *
 * v1 had two palettes: `Theme.swift` for the chrome and `writeBaseTheme()` in
 * `Ghostty.swift` for the terminal grid, kept in step by a comment asking the
 * next person to remember. They drifted, because that is what hand-synced pairs
 * do — and the tell was a terminal background a shade off the surface behind it,
 * which nobody reports as a bug.
 *
 * Here both surfaces are generated, so the failure mode has to be a hex typed
 * into a generator instead of read from `palette`. These cases exist to make
 * exactly that fail. The last one is the structural one: it needs no table of
 * its own, so it cannot itself drift.
 */
describe('one token map', () => {
  const MODES: ThemeMode[] = ['dark', 'light'];

  /** The colour jobs the chrome and the grid must agree on, by name. */
  const SHARED: ReadonlyArray<readonly [keyof XtermTheme, ColorToken]> = [
    ['background', 'pane'],
    ['foreground', 'inkDim'],
    ['selectionBackground', 'line'],
    ['cursor', 'ink'],
    ['blue', 'sky'],
    ['green', 'grass'],
    ['red', 'red'],
    ['yellow', 'clay'],
    ['brightWhite', 'ink'],
    ['brightBlack', 'inkGhost'],
    ['black', 'canvas'],
  ];

  it.each(MODES)('gives chrome and grid the same value for every shared job (%s)', (mode) => {
    // The chrome reaches these through their ROLE names, which is the whole
    // point: the grid asks the palette, the chrome asks a role, and this asserts
    // the two arrive at one value.
    const ROLE_OF: Partial<Record<ColorToken, string>> = {
      pane: 'pane',
      inkDim: 'textDim',
      line: 'line',
      ink: 'text',
      sky: 'sky',
      grass: 'grass',
      red: 'red',
      clay: 'clay',
      inkGhost: 'textGhost',
      canvas: 'canvas',
    };
    const css = cssVariables(mode);
    const term = xtermTheme(mode);
    for (const [slot, token] of SHARED) {
      const role = ROLE_OF[token];
      expect(role, `${token} has no role`).toBeDefined();
      expect(term[slot], `${slot} vs ${roleVarName(role as never)}`).toBe(css[`--sh-${role as string}`.replace(/[A-Z]/g, (u) => `-${u.toLowerCase()}`)]);
    }
  });

  it('sets no terminal colour the palette does not carry', () => {
    for (const mode of MODES) {
      const known = new Set(colorTokens.map((t) => palette[t][mode]));
      for (const [slot, value] of Object.entries(xtermTheme(mode))) {
        expect(known.has(value), `${mode}.${slot} = ${value} is not a palette value`).toBe(true);
      }
    }
  });

  it('moves both generators together when the mode changes', () => {
    // Same values in one mode and different values in the other would mean one
    // generator is reading `palette` and the other a frozen copy of it.
    for (const [slot, token] of SHARED) {
      expect(xtermTheme('dark')[slot]).toBe(palette[token].dark);
      expect(xtermTheme('light')[slot]).toBe(palette[token].light);
      expect(xtermTheme('dark')[slot], `${slot} is the same in both modes`).not.toBe(xtermTheme('light')[slot]);
    }
  });

  it('leaves no colour token that only one generator knows about', () => {
    // Every token reaches the chrome by construction; the grid uses a subset, and
    // this pins WHICH subset — so a token that quietly stops being drawn (or one
    // only the terminal knows) fails here.
    const inTerm = new Set(Object.values(xtermTheme('dark')));
    const drawn = colorTokens.filter((token) => inTerm.has(palette[token].dark));
    expect([...drawn].sort()).toEqual(
      // `repoSky` is here because it IS `sky` — §2 gives the first repo mark the
      // same value, and this list is matched on values rather than names. That is
      // the honest reading: the grid draws one colour, and two roles claim it.
      //
      // `scnGlow` is the third claim, and it only became visible when the sky
      // strip's gradient stopped being four hex literals. The strip is the one
      // sanctioned decorative surface, so a job-carrying hue appearing there at
      // 13% is a question worth asking rather than a defect to assert on — but it
      // is now asked here instead of hiding in a `rgb(127 182 232 / 13%)`.
      ['canvas', 'clay', 'grass', 'ink', 'inkDim', 'inkFaint', 'inkGhost', 'line', 'pane', 'red', 'repoSky', 'scnGlow', 'sky'].sort(),
    );
  });

  it('spends no hue the five-colour language does not have', () => {
    // §6 refuses a sixth hue outright, and a terminal theme is the easiest place
    // to smuggle one in: yellow/magenta/cyan have no job here and must borrow.
    const term = xtermTheme('dark');
    const hues = new Set([palette.sky.dark, palette.grass.dark, palette.clay.dark, palette.red.dark]);
    for (const slot of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      expect(hues.has(term[slot]), `${slot} = ${term[slot]} is a sixth hue`).toBe(true);
    }
  });
});
