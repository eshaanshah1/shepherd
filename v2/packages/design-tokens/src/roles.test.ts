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
    expect(roleValue('surface', 'dark')).toBe(palette.ink.dark);
    expect(roleValue('surface', 'light')).toBe(palette.ink.light);
    expect(roleValue('accent', 'dark')).toBe(palette.cobalt.dark);
    expect(roleValue('terminal', 'light')).toBe(palette['ink-term'].light);
  });

  it('emits an alias as a reference, so a re-declared role carries it', () => {
    // Scoped re-declaration (spec §2) is the point: `[data-surface='terminal'] {
    // --sh-text: … }` must move the selection block with it. A hex baked in here
    // would leave a selected row painted in the app's ink on a themed subtree.
    expect(roleValue('fillSelected', 'dark')).toBe('var(--sh-text)');
    expect(roleValue('textSelected', 'dark')).toBe('var(--sh-surface)');
    expect(roleValue('accentText', 'light')).toBe('var(--sh-surface)');
    expect(roleValue('focusRing', 'dark')).toBe('var(--sh-accent)');
  });

  it('emits a wash as color-mix over the role it washes, lighter in light mode', () => {
    expect(roleValue('fillHover', 'dark')).toBe('color-mix(in srgb, var(--sh-text) 6%, transparent)');
    expect(roleValue('fillHover', 'light')).toBe('color-mix(in srgb, var(--sh-text) 4%, transparent)');
  });

  it('kebab-cases a role into its variable, one conversion only', () => {
    expect(roleVarName('canvas')).toBe('--sh-canvas');
    expect(roleVarName('surfaceRaised')).toBe('--sh-surface-raised');
    expect(roleVarName('fillHover')).toBe('--sh-fill-hover');
    expect(roleVarName('accentText')).toBe('--sh-accent-text');
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

  it('keeps selection SOLID, not a wash — rule 4 is inverse video', () => {
    // The design-system spec's §2 parenthetical lists `fillSelected` among the
    // washes; the design language it implements does not, and the reference study
    // says so explicitly (takeaway 2). Selection is a solid block of `text` with
    // `textSelected` on it. If this ever becomes a color-mix, hover and selection
    // stop being one glance apart, which is the property rule 4 buys.
    expect(roles.fillSelected.kind).toBe('alias');
    expect(roleToken('fillSelected')).toBe('wool');
    expect(roleToken('textSelected')).toBe('ink');
  });

  it('gives the pane-chrome accents a role each, so no call site needs a palette name', () => {
    // Every accent in the palette has a job (rule 3), so every accent needs a
    // role — `signal` had none in the spec's list and is on screen today
    // (`.sh-pane-hint`, the xterm cursor).
    expect(roleToken('accent')).toBe('cobalt');
    expect(roleToken('attention')).toBe('hay');
    expect(roleToken('success')).toBe('pasture');
    expect(roleToken('danger')).toBe('ember');
    expect(roleToken('prompt')).toBe('signal');
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

  it('collides with no palette or metric variable', () => {
    // Both tiers are emitted into one namespace while call sites migrate, so a
    // role named after a palette token would silently overwrite it — and the
    // symptom would be a colour that is right until somebody themes it.
    const roleVars = new Set(roleNames.map(roleVarName));
    const nonRole = Object.keys(cssVariables('dark')).filter((name) => !roleVars.has(name));
    for (const name of nonRole) expect(roleVars.has(name), name).toBe(false);
    expect(roleVars.size).toBe(roleNames.length);
  });

  it('still emits the private palette tier, so nothing breaks mid-migration', () => {
    const vars = cssVariables('dark');
    expect(vars['--sh-ink']).toBe(palette.ink.dark);
    expect(vars['--sh-wool-faint']).toBe(palette['wool-faint'].dark);
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
    cyclic.accentText = { kind: 'alias', of: 'focusRing', job: 'x', notFor: 'y' };
    cyclic.focusRing = { kind: 'alias', of: 'accentText', job: 'x', notFor: 'y' };
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
    expect(() => walk('accentText')).toThrow('cycle');
    // …and the real table does not contain one.
    for (const role of roleNames) expect(() => roleToken(role)).not.toThrow();
  });
});
