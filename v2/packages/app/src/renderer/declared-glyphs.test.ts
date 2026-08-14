/**
 * Every icon name an extension declares has to be one the allow-list carries.
 *
 * This is the compiler a string crossing a port does not have. `namedGlyph`
 * answers `IconDots` for anything it does not recognise — deliberately, because
 * a hover action with no glyph is an invisible button — so a misspelled or simply
 * absent name draws *something* and fails nothing. `icon: 'check'` shipped on
 * every task row that way and drew three dots for its entire life, in the one
 * place a check mark was the whole point.
 *
 * Scanned rather than listed by hand, because a hand-maintained list drifts the
 * same way the allow-list did: the next `icon:` added to an extension has to fail
 * here without anybody remembering this file exists.
 *
 * It lives in the app because the app is what fails to draw: the extension's
 * service half runs in a utility process, may not import `@shepherd/ui` at all
 * (ADR 0033's boundary), and is in no position to check its own strings.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NAMED_GLYPHS } from '@shepherd/ui';

/** `<repo>/v2` — four levels up from `packages/app/src/renderer`. */
const V2_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `out-tsc` is build output and holds a stale copy of every name.
    if (entry === 'node_modules' || entry === 'out-tsc' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    /*
     * Source only, never a test.
     *
     * A test that pins what an UNKNOWN glyph name does — `task-card.test.tsx`
     * asserts that a fact naming one draws no glyph rather than a placeholder —
     * has to write an unknown name down, and there is no way to do that which
     * this scan would not read as a defect. Excluding tests is the narrower fix
     * than teaching the regex about intent.
     */
    if (entry.includes('.test.')) continue;
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/**
 * Every `icon: '<name>'` in the extensions tree, with where it was written.
 *
 * A literal only — a computed icon cannot be checked here, and there are none.
 * If one appears, this regex quietly stops covering it, which is why the test
 * below also asserts the scan found something at all.
 */
function declaredIcons(): readonly { readonly name: string; readonly at: string }[] {
  const found: { name: string; at: string }[] = [];
  for (const file of sourceFiles(join(V2_ROOT, 'extensions'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bicon:\s*'([^']+)'/g)) {
      found.push({ name: match[1] as string, at: file.slice(V2_ROOT.length + 1) });
    }
  }
  return found;
}

describe('the icon names extensions declare', () => {
  it('finds some, or the scan has stopped covering anything', () => {
    expect(declaredIcons().length).toBeGreaterThan(0);
  });

  it('are all in the allow-list, so none of them silently draws the fallback', () => {
    const missing = declaredIcons()
      .filter((entry) => !Object.prototype.hasOwnProperty.call(NAMED_GLYPHS, entry.name))
      .map((entry) => `${entry.name} (${entry.at})`);
    expect(missing).toEqual([]);
  });
});
