// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import { SHEPHERD_DIFF_SIZING } from '@shepherd/ext-github/ui';
import '@shepherd/ui/styles.css';
import './styles.css';
// The sheet under test. Not reached through `styles.css` — the pane sheets are
// imported by `main.tsx`, one per pane.
import './review-pane.css';

/**
 * The diff virtualiser's reserved box against the rules that paint it.
 *
 * `CodeView` sizes its scroll from NUMBERS PASSED IN JS, before a file is built
 * and before there is any DOM to measure. So the same two heights are stated
 * twice — once in `diff-theme.ts` for the virtualiser, once in
 * `review-pane.css` for the paint — and nothing but this test holds them
 * together.
 *
 * **Bought by a shipped defect.** `WorkingChanges` drew its diffs through the
 * same class as the Files tab and passed no metrics at all, so the virtualiser
 * reserved the package's own chrome (a 44px header over 20px lines) while these
 * rules drew 29 over 18. The reserved boxes and the painted rows ended up in
 * different places: a band of nothing above the file, and a drag over that band
 * selecting text a couple of hundred pixels below the pointer, because selection
 * hit-tests the real boxes while the eye reads the paint.
 *
 * Asserted against the RULES rather than a computed style, for the reason
 * `css-rules.ts` gives: jsdom lays nothing out, so a test may assert what a rule
 * says and never what it renders.
 */

/** What `property` is declared as by rules for exactly `selector`. */
function declared(selector: string, property: string): string[] {
  return rulesMentioning(selector)
    .filter((rule) => rule.selectorText === selector)
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter((value) => value !== '');
}

describe('the diff metrics the virtualiser is told', () => {
  it('reserves the line height this stylesheet paints', () => {
    const painted = declared('.sh-pr-diff__view', '--diffs-line-height');
    expect(painted).toEqual([`${SHEPHERD_DIFF_SIZING.itemMetrics.lineHeight}px`]);
  });

  it('states a header height at all, which the package default would not', () => {
    // 44 is the package's own chrome. Reserving it under a 29px header is the
    // shipped defect above, and the numbers being equal is what "no band" means.
    expect(SHEPHERD_DIFF_SIZING.itemMetrics.diffHeaderHeight).toBeLessThan(44);
  });
});
