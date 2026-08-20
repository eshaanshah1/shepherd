import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssVariables } from '@shepherd/design-tokens';

/**
 * The theme is CSS-in-JS, so what is worth asserting is the RULE it must not
 * break rather than a computed pixel: light and dark both come from tokens, and
 * a literal colour here is a colour that cannot follow the palette (ADR 0040).
 */
const source = readFileSync(join(import.meta.dirname, 'theme.ts'), 'utf8');
const preview = readFileSync(join(import.meta.dirname, 'live-preview.ts'), 'utf8');

/**
 * Every token the design system actually publishes, GENERATED rather than
 * parsed out of a stylesheet — there is no stylesheet, `cssVariableBlock` is
 * where the variables come from.
 */
const KNOWN = new Set(Object.keys(cssVariables('dark')));

describe('the scratch theme', () => {
  it('names no literal hex colour', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('names no literal rgb() or hsl() colour', () => {
    expect(source).not.toMatch(/\b(rgba?|hsla?)\(/);
  });

  it('styles every class live-preview.ts emits', () => {
    const classes = [...preview.matchAll(/'(sh-scratch-[a-z0-9]+)'/g)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of new Set(classes)) {
      expect(source, `live-preview emits .${cls} and the theme does not style it`).toContain(cls);
    }
  });

  it('names only tokens the design system publishes', () => {
    // A var() naming a token that does not exist fails SILENTLY at runtime,
    // which is the whole reason this assertion is here rather than in a review.
    expect(KNOWN.size).toBeGreaterThan(20);
    for (const used of new Set(source.match(/--sh-[a-z0-9-]+/g) ?? [])) {
      expect(KNOWN, `${used} is not a published token`).toContain(used);
    }
  });
});
