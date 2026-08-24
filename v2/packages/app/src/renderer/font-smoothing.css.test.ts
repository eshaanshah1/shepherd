import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `-webkit-font-smoothing: antialiased` is a RETINA-ONLY opt-out.
 *
 * The shipped defect this asserts against: it was set unconditionally on `body`.
 * `antialiased` is not "better antialiasing" — it is the lighter of macOS's two
 * grayscale weights. At 2x the extra device pixels put the weight back and it
 * reads as crisp; at 1x, an external monitor at its native resolution, there are
 * no extra pixels and it only strips stem weight off a 13px glyph. The app
 * looked broken on exactly one of a user's two displays.
 *
 * It reaches the GRID, not just the chrome: `xterm-terminal.ts` loads Fit and
 * Search and no renderer addon, so the terminal is xterm's DOM renderer and every
 * cell is a span inheriting this from `body`. An unconditional declaration is one
 * every character of agent output is drawn with.
 *
 * ---------------------------------------------------------- why the SOURCE text
 *
 * Every other CSS assertion in this package walks the CSSOM
 * (`@shepherd/ui/css-rules`), and this one cannot: jsdom's CSSOM drops BOTH
 * halves of the fact. `-webkit-font-smoothing` is not in cssstyle's property
 * table, so it never survives into a rule's `style`; and a media query on a
 * resolution feature is not one jsdom's parser keeps, so the grouping rule that
 * carries the whole point vanishes too. Measured — a probe over
 * `document.styleSheets` after importing this sheet returns zero rules
 * mentioning either. A CSSOM test here would pass against a file that had
 * regressed, which is worse than no test.
 *
 * So the sheet is read as text. That buys less than a parsed rule would — it
 * cannot see cascade or specificity — but the invariant is not about cascade: it
 * is "this declaration appears nowhere outside that one block", and text is
 * enough to say it and is the only thing that can.
 */

const SHEET = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** The `@media (min-resolution: 2dppx) { … }` block, brace-matched from its header. */
function retinaBlock(sheet: string): string | null {
  const header = /@media\s*\(\s*min-resolution:\s*2dppx\s*\)\s*\{/.exec(sheet);
  if (!header) return null;
  let depth = 1;
  let i = header.index + header[0].length;
  const start = i;
  for (; i < sheet.length && depth > 0; i++) {
    if (sheet[i] === '{') depth++;
    else if (sheet[i] === '}') depth--;
  }
  return depth === 0 ? sheet.slice(start, i - 1) : null;
}

/** Declarations only — the file explains this property at length in prose. */
const declarationsOf = (sheet: string): RegExpMatchArray[] =>
  Array.from(sheet.matchAll(/^\s*-webkit-font-smoothing\s*:/gm));

describe('font smoothing is scoped to the density that asked for it', () => {
  const block = retinaBlock(SHEET);

  it('has a 2x block at all', () => {
    // The guard against a vacuous pass: with the media query renamed or removed,
    // "every declaration is inside it" holds trivially against nothing.
    expect(block).not.toBeNull();
  });

  it('declares the property once, and inside that block', () => {
    expect(declarationsOf(SHEET)).toHaveLength(1);
    expect(declarationsOf(block ?? '')).toHaveLength(1);
  });

  it('smooths `body`, which is what the grid inherits from', () => {
    expect(block).toMatch(/body\s*\{[^}]*-webkit-font-smoothing:\s*antialiased/);
  });

  it('leaves body’s unconditional rule with no smoothing in it', () => {
    /*
     * Matched from the top-level `body {` specifically, because the one inside
     * the media query is a `body {` too and a lazier pattern finds that one and
     * passes for the wrong reason.
     */
    const unconditional = /^body\s*\{([^}]*)\}/m.exec(SHEET);
    expect(unconditional).not.toBeNull();
    expect(unconditional?.[1]).not.toMatch(/font-smoothing/);
  });
});
