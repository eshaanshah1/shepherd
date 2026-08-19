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

/**
 * Whether a TrueType file has a glyph for a codepoint.
 *
 * Hand-rolled, and small enough to be: the question is one table deep, and
 * every library that answers it is a megabyte of parser to ask a yes/no. Reads
 * the `cmap`'s Unicode subtable — format 12 when the file has one, because it is
 * the only format that reaches past the BMP and that is where the Material
 * Design half of the Nerd Font ranges lives; format 4 otherwise.
 */
function glyphCoverage(file: string): (codepoint: number) => boolean {
  const buf = readFileSync(file);
  const tableCount = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    if (buf.toString('ascii', record, record + 4) === 'cmap') cmap = buf.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error(`${file} has no cmap table`);

  let subtable = -1;
  let format = -1;
  for (let i = 0; i < buf.readUInt16BE(cmap + 2); i += 1) {
    const record = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(record);
    const encoding = buf.readUInt16BE(record + 2);
    // Unicode (0, any) or Windows BMP/full (3, 1) / (3, 10).
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const at = cmap + buf.readUInt32BE(record + 4);
    const kind = buf.readUInt16BE(at);
    if ((kind === 4 || kind === 12) && kind > format) [subtable, format] = [at, kind];
  }
  if (subtable < 0) throw new Error(`${file} has no format 4 or 12 cmap subtable`);

  if (format === 12) {
    return (codepoint) => {
      const groups = buf.readUInt32BE(subtable + 12);
      for (let g = 0; g < groups; g += 1) {
        const group = subtable + 16 + g * 12;
        const start = buf.readUInt32BE(group);
        if (codepoint < start || codepoint > buf.readUInt32BE(group + 4)) continue;
        return buf.readUInt32BE(group + 8) + (codepoint - start) !== 0;
      }
      return false;
    };
  }

  const segments = buf.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codepoint) => {
    if (codepoint > 0xffff) return false;
    for (let s = 0; s < segments; s += 1) {
      const start = buf.readUInt16BE(starts + s * 2);
      if (codepoint < start || codepoint > buf.readUInt16BE(ends + s * 2)) continue;
      const delta = buf.readInt16BE(deltas + s * 2);
      const rangeOffset = buf.readUInt16BE(rangeOffsets + s * 2);
      if (rangeOffset === 0) return ((codepoint + delta) & 0xffff) !== 0;
      const glyph = buf.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (codepoint - start) * 2);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
}

/**
 * The mono face draws the icons a terminal is asked to draw.
 *
 * Not a nicety and not a preference: a prompt, `eza`, `lazygit`, `starship` and
 * Claude Code's own output all emit Nerd Font codepoints, and a codepoint with
 * no glyph anywhere in the stack is a tofu box — the grid fills with them and
 * the terminal reads as broken. Unpatched JetBrains Mono has none of these, and
 * neither has any fallback the stack could name: macOS resolves a missing glyph
 * through CoreText's cascade list, which is system faces only and covers no
 * Private Use Area at all. So an installed Nerd Font on the machine does NOT
 * rescue this — the app either ships the coverage or there is none.
 *
 * Asserted against the file the `@font-face` points at, so a font swap that
 * drops the icons fails here rather than in a screenshot.
 */
describe('the mono face', () => {
  const faces = sheet.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const family = firstFamily(fonts.mono);
  const face = faces.find((each) => each.includes(`'${family}'`)) ?? '';
  const url = /url\('([^']+)'\)/.exec(face)?.[1] ?? '';
  const covers = glyphCoverage(resolve(here, url));

  it.each([
    ['nf-custom-folder', 0xe5ff],
    ['nf-dev-git', 0xe702],
    ['nf-fa-folder', 0xf07b],
    ['nf-fa-file_text', 0xf15c],
    // Past the BMP, where Nerd Fonts moved the Material Design set. A face can
    // cover every range above and still miss this one.
    ['nf-md-file_document', 0xf0219],
  ])('has a glyph for %s', (_name, codepoint) => {
    expect(covers(codepoint)).toBe(true);
  });

  /*
   * The reader above is the thing being trusted, so it says something falsifiable
   * about a face it has already answered for: a parser that returned `true` for
   * everything would satisfy every assertion in this block but one.
   */
  it('reads the cmap rather than assuming coverage', () => {
    expect(covers(0x4d), 'M').toBe(true);
    expect(covers(0xffff0), 'an unassigned codepoint').toBe(false);
  });
});
