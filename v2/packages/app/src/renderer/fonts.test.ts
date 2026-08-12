import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fonts } from '@shepherd/design-tokens';

/**
 * The app SHIPS the faces its tokens name.
 *
 * Bought by a defect that no other check could see, because nothing was broken
 * in any file it looked at: the design tokens named `Geist`, the renderer went on
 * bundling v1's `DMSans.ttf` — which no rule and no token referenced any more —
 * and the fallback chain silently took over. On a machine with Geist installed
 * the app looked right; anywhere else the whole of it was drawn in the system
 * face. The symptom reads as "the fonts are wrong", never as "the font failed to
 * load", so it survives being looked at.
 *
 * Asserted against the stylesheet's TEXT rather than through jsdom: `@font-face`
 * is not a style rule, so it does not survive `document.styleSheets` in a
 * cssom that keeps only what it can match a selector against — and the file on
 * disk is the thing that has to exist anyway.
 */

const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(resolve(here, 'styles.css'), 'utf8');

/** The first family of a stack — the one the browser actually tries first. */
function firstFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? '';
  return first.replace(/^['"]|['"]$/g, '');
}

describe.each([
  ['sans', fonts.sans],
  ['mono', fonts.mono],
])('%s', (_job, stack) => {
  const family = firstFamily(stack);

  it(`declares an @font-face for “${family}”`, () => {
    const faces = sheet.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const mine = faces.filter((face) => face.includes(`'${family}'`));
    expect(mine, `no @font-face for ${family}`).toHaveLength(1);
  });

  it('bundles the file that @font-face points at', () => {
    const faces = sheet.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const mine = faces.find((face) => face.includes(`'${family}'`)) ?? '';
    const url = /url\('([^']+)'\)/.exec(mine)?.[1];
    expect(url, `no url() in the ${family} @font-face`).toBeDefined();
    expect(existsSync(resolve(here, url ?? '')), `${url} is not in the bundle`).toBe(true);
  });
});

it('bundles no face nothing names', () => {
  // The other direction, and the half that let the mismatch sit unnoticed: a
  // font file with no token pointing at it is 240KB of dead weight AND the
  // strongest possible evidence that the face somebody meant is not loading.
  const named = [fonts.sans, fonts.mono, fonts.serif].map(firstFamily);
  for (const face of sheet.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const family = /font-family:\s*'([^']+)'/.exec(face)?.[1];
    expect(family, face).toBeDefined();
    expect(named, `${family} is bundled but no token names it`).toContain(family);
  }
});
