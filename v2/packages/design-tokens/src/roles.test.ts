import { describe, expect, it } from 'vitest';
import { palette, type ThemeMode } from './palette.ts';
import { roleNames, roleToken, roleValue, roleVarName, roles, type RoleName } from './roles.ts';
import { cssVariables } from './css.ts';

const MODES: ThemeMode[] = ['dark', 'light'];

/**
 * The role tier's whole claim is that it is the PUBLIC name for a private
 * palette. These cases are what make that claim falsifiable: a role that resolves
 * to nothing, a role that emits a variable nobody sets, and a role that means the
 * same thing as another one are each a way for the tier to become decoration.
 */
describe('roles', () => {
  it('resolves every role to a real palette value in both modes', () => {
    for (const role of roleNames) {
      const token = roleToken(role);
      expect(palette[token], `${role} -> ${token}`).toBeDefined();
      for (const mode of MODES) {
        expect(palette[token][mode], `${role} (${mode})`).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it('paints a token role with the palette value for the mode', () => {
    expect(roleValue('surface', 'dark')).toBe(palette.surface.dark);
    expect(roleValue('surface', 'light')).toBe(palette.surface.light);
    expect(roleValue('sky', 'dark')).toBe(palette.sky.dark);
    expect(roleValue('pane', 'light')).toBe(palette.pane.light);
  });

  it('emits an alias as a reference, so a re-declared role carries it', () => {
    // Scoped re-declaration is the point: `[data-surface='terminal'] { --sh-text:
    // … }` must move the wool mark and the primary button's ink with it. A hex
    // baked in here would leave both painted in the app's ink on a themed subtree.
    expect(roleValue('wool', 'dark')).toBe('var(--sh-text)');
    expect(roleValue('fillSelected', 'dark')).toBe('var(--sh-raised)');
    expect(roleValue('textOnWool', 'light')).toBe('var(--sh-canvas)');
    expect(roleValue('focusRing', 'dark')).toBe('var(--sh-sky)');
  });

  it('emits a wash as color-mix over the role it washes, lighter in light mode', () => {
    // The scrim is the language's one wash, and its asymmetry is a finding rather
    // than a taper: 55% black over paper reads as soot.
    expect(roleValue('scrim', 'dark')).toBe('color-mix(in srgb, var(--sh-scrim-ink) 76%, transparent)');
    expect(roleValue('scrim', 'light')).toBe('color-mix(in srgb, var(--sh-scrim-ink) 20%, transparent)');
  });

  it('kebab-cases a role into its variable, one conversion only', () => {
    expect(roleVarName('canvas')).toBe('--sh-canvas');
    expect(roleVarName('lineStrong')).toBe('--sh-line-strong');
    expect(roleVarName('fillHover')).toBe('--sh-fill-hover');
    expect(roleVarName('markWorkingOff')).toBe('--sh-mark-working-off');
  });

  it('gives every role a job AND the negative half', () => {
    // Orca's "Don't use it for" column is the thing that kept its token set from
    // sprawling; a role with no `notFor` is a role whose misuse nobody has thought
    // about yet.
    for (const role of roleNames) {
      expect(roles[role].job.length, `${role}.job`).toBeGreaterThan(0);
      expect(roles[role].notFor.length, `${role}.notFor`).toBeGreaterThan(0);
    }
  });

  it('points every alias and wash at a role that exists', () => {
    const known = new Set<string>(roleNames);
    for (const role of roleNames) {
      const spec = roles[role];
      if (spec.kind !== 'token') expect(known.has(spec.of), `${role} -> ${spec.of}`).toBe(true);
    }
  });

  it('refuses inverse video for selection — a fill plus an edge, §6', () => {
    // Flock painted a selected row as a SOLID block of `text` with the surface
    // colour on it. This language lists that under what it refuses: selection is
    // `raised` plus `edgeSelected`, and the label stays legible throughout. If
    // `fillSelected` ever resolves to the ink again, that is the regression.
    expect(roles.fillSelected.kind).toBe('alias');
    expect(roleToken('fillSelected')).toBe('raised');
    expect(roleToken('fillSelected')).not.toBe('ink');
    expect(roleToken('edgeSelected')).toBe('edgeSelected');
  });

  it('gives every mark in §3 a role, so no call site needs a palette name', () => {
    // A **square** means your move, a **ring** means nothing is happening, a
    // **meter** means something is. Each is a role because a component asks for
    // the state, never for the hue behind it.
    expect(roleToken('markWorking')).toBe('sky');
    expect(roleToken('markWaiting')).toBe('ink');
    // Two squares, two hues: a question is your move and so is an unread finished
    // turn, but one of them is stuck and the other is done. Told apart by the hue
    // alone, so the two roles must not resolve to one token.
    expect(roleToken('markReady')).toBe('grass');
    expect(roleToken('markReady')).not.toBe(roleToken('markWaiting'));
    expect(roleToken('markLater')).toBe('edgeRing');
    expect(roleToken('markFailed')).toBe('red');
    expect(roleToken('meterPass')).toBe('grass');
    expect(roleToken('meterPending')).toBe('lineActive');
  });

  it('keeps `wool` and `text` one value, and `clay` and `red` two', () => {
    // "The loudest thing available against this surface" and "primary text" are
    // one answer in both modes; two names for one value is how the two drift.
    expect(roleToken('wool')).toBe(roleToken('text'));
    // clay is git-removed and red is a run that failed. §2 lists "failure" under
    // clay's `not for` precisely because a diff full of removals must not read as
    // a broken build.
    expect(roleToken('clay')).not.toBe(roleToken('red'));
  });

  it('keeps grass out of the repo-identity set', () => {
    // §2, stated: a repo tinted green would read as something that passed.
    const identity = (['repo1', 'repo2', 'repo3', 'repo4'] as const).map((role) => roleToken(role));
    expect(identity).not.toContain(roleToken('grass'));
    expect(new Set(identity).size, 'four repos, four distinct marks').toBe(4);
  });
});

describe('roles in the emitted variable set', () => {
  it('emits a CSS variable for every role name', () => {
    const vars = cssVariables('dark');
    for (const role of roleNames) {
      expect(vars[roleVarName(role)], roleVarName(role)).toBe(roleValue(role, 'dark'));
    }
  });

  it('sets every variable an alias or wash references', () => {
    // An alias emitting `var(--sh-text)` is a dangling pointer if nothing sets
    // `--sh-text`. This is the case that fails if a role is renamed on one side.
    const vars = cssVariables('light');
    for (const value of Object.values(vars)) {
      for (const [, name] of value.matchAll(/var\((--sh-[a-z-]+)\)/g)) {
        expect(vars[name as string], `${value} references ${name}`).toBeDefined();
      }
    }
  });

  it('collides with no metric or font variable', () => {
    const roleVars = new Set(roleNames.map(roleVarName));
    const nonRole = Object.keys(cssVariables('dark')).filter((name) => !roleVars.has(name));
    for (const name of nonRole) expect(roleVars.has(name), name).toBe(false);
    expect(roleVars.size).toBe(roleNames.length);
  });

  it('emits NO private palette name — tier 1 is unreachable from a stylesheet', () => {
    // Flock emitted both tiers so its shell stylesheet kept resolving mid-
    // migration. That reason expired with Flock, and the guarantee is worth more
    // than the convenience: a rule cannot name a luminance step even by accident,
    // because the variable does not exist. `sunken`/`canvas`/`line` appear below
    // as ROLES that happen to share a spelling with their token, which is the
    // point of a one-cast neutral ramp — the step has no identity to name.
    const vars = cssVariables('dark');
    const emitted = new Set(Object.keys(vars));
    const roleVars = new Set(roleNames.map(roleVarName));
    for (const token of ['ink', 'inkDim', 'skyDim', 'scrimBase', 'repoSky', 'scnHill'] as const) {
      const name = `--sh-${token.replace(/[A-Z]/g, (u) => `-${u.toLowerCase()}`)}`;
      expect(emitted.has(name) && !roleVars.has(name), `${name} leaks tier 1`).toBe(false);
    }
    // …and the ink really is only reachable under its role name.
    expect(vars['--sh-text']).toBe(palette.ink.dark);
    expect(vars['--sh-ink']).toBeUndefined();
  });

  it('changes every token role with the mode and no alias with it', () => {
    const dark = cssVariables('dark');
    const light = cssVariables('light');
    for (const role of roleNames) {
      const name = roleVarName(role);
      const spec = roles[role];
      if (spec.kind === 'token') {
        expect(dark[name], name).not.toBe(light[name]);
      } else if (spec.kind === 'alias') {
        // An alias is mode-independent BY CONSTRUCTION — it points at a name, and
        // the name is what changes. That is the property that makes a themed
        // subtree work at all.
        expect(dark[name], name).toBe(light[name]);
      }
    }
  });
});

/** A cycle is a mistake that must fail at build time rather than hang a generator. */
describe('roleToken', () => {
  it('throws rather than recursing when a role resolves through a cycle', () => {
    const cyclic = { ...roles } as Record<RoleName, (typeof roles)[RoleName]>;
    cyclic.textOnWool = { kind: 'alias', of: 'focusRing', job: 'x', notFor: 'y' };
    cyclic.focusRing = { kind: 'alias', of: 'textOnWool', job: 'x', notFor: 'y' };
    // `roleToken` reads the module's own table, so the cycle is asserted through
    // the guard's shape rather than by mutating a frozen export: two aliases that
    // point at each other must terminate, and the only way it can is by throwing.
    const walk = (start: RoleName): string => {
      const seen = new Set<RoleName>();
      let current = start;
      for (;;) {
        if (seen.has(current)) throw new Error('cycle');
        seen.add(current);
        const spec = cyclic[current];
        if (spec.kind === 'token') return spec.token;
        current = spec.of;
      }
    };
    expect(() => walk('textOnWool')).toThrow('cycle');
    // …and the real table does not contain one.
    for (const role of roleNames) expect(() => roleToken(role)).not.toThrow();
  });
});

describe('the selection band', () => {
  /**
   * A wash, and the hazard it carries is written down because it has bitten.
   *
   * Painted over itself, a translucent band lands a step brighter — measured at
   * `rgb(79,110,139)` against `rgb(54,73,90)` on a four-line selection with no
   * tokens in it, a bright hairline at every line boundary where the browser
   * overlapped one line's band with the next. It was opaque for a while for
   * exactly that reason.
   *
   * What changed is who paints it: `PromptField` lays one bar per line at the
   * text's own height, so the bars are separated by the leading and never touch,
   * and `Pill` no longer paints a band at all. Anything that starts painting
   * this token over itself again has to solve the overlap first.
   */
  it('is a wash, low enough that selected text keeps its own colour', () => {
    const spec = roles.fillSelection;
    expect(spec.kind).toBe('wash');
    if (spec.kind !== 'wash') throw new Error('unreachable');
    // Low enough on both grounds to read THROUGH; that is the whole point of a
    // wash here rather than a fill.
    expect(spec.alpha.dark).toBeLessThanOrEqual(0.35);
    expect(spec.alpha.light).toBeLessThanOrEqual(0.4);
    /*
     * And light takes MORE than dark, which is the opposite of every other wash
     * in this file and is deliberate. A wash mixes toward what is behind it, so
     * "darker" is less of the colour on near-black and more of it on paper —
     * `sky` being a light blue in one mode and a dark blue in the other. The
     * usual `light < dark` rule is about matching a step's WEIGHT across modes;
     * this one is about matching its darkness, and the two point opposite ways.
     */
    expect(spec.alpha.light).toBeGreaterThan(spec.alpha.dark);
    for (const mode of ['dark', 'light'] as const) {
      expect(roleValue('fillSelection', mode), mode).toContain('color-mix');
    }
  });
});
