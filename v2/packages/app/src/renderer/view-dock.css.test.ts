// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { allRules } from '@shepherd/ui/css-rules';
import './styles.css';

/**
 * The shell may not draw its own line between two dock sections.
 *
 * A rail section is a `SectionLabel` over a list, and the label's trailing rule
 * IS the division — `section-label.css` calls it "the trailing rule" and
 * `view-dock.tsx` says the rule is what makes a heading read as a band across
 * the list. That the rule is drawn at all is asserted where it lives, in
 * `packages/ui/src/section-label.test.tsx`; this file asserts the other side of
 * it, which is that nothing here draws a SECOND one.
 *
 * Only `./styles.css` is loaded, deliberately: jsdom does not resolve `@import`,
 * so pulling `@shepherd/ui/styles.css` in would contribute no rules and imply a
 * coverage this file does not have. The refusal is about the shell's own sheet
 * and the shell's own sheet is what is under test.
 *
 * Asserted on the rules rather than through `getComputedStyle` for this file's
 * usual reason: an adjacent-sibling edge is a property of the sheet, and a jsdom
 * tree holding one section cannot be put into the state that reveals a second.
 */

/** Every way a rule in this sheet could paint a horizontal edge on a box. */
const EDGE = ['box-shadow', 'border-top', 'border-top-width', 'border-block-start'];

describe('the seam between two dock sections', () => {
  /**
   * MUTATION TARGET. Two mechanisms drew this line and the screen showed both: a
   * full-width inset hairline at the top of every section after the first, and —
   * since a tree's declared title became its heading — the heading's own trailing
   * rule, which starts after the word rather than at the edge. Offset from each
   * other, so they read as two lines rather than as one line drawn twice.
   *
   * The inset one went. It dates from `9a17a209`, when a tree had no heading and
   * there was genuinely nothing else to divide two sections with; every rendered
   * section draws a `SectionLabel` now — `shown` derives from `views`, so the
   * heading is present whenever the section is — which leaves the hairline as the
   * half that no longer has a job.
   */
  it('is never painted by an adjacent-sibling rule of its own', () => {
    const painted = allRules()
      .filter((rule) => /\.sh-side-view\s*\+/.test(rule.selectorText))
      .filter((rule) => EDGE.some((property) => rule.style.getPropertyValue(property) !== ''))
      .map((rule) => rule.selectorText);

    expect(painted).toEqual([]);
  });
});
