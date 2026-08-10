// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import './styles.css';

/**
 * The picker's boundary, asserted in the CSS because that is where it lives.
 *
 * **Bought by a shipped defect, and it was invisible in the only sense that
 * matters: the popover could not be seen.** `composer.css` re-declares
 * `--sh-line: transparent` for the whole `.sh-ui-composer` subtree — that is what
 * "no inner hairlines" means as a rule rather than a wish — and it documents the
 * way out in the same breath: "a control that genuinely needs an edge in here
 * re-declares `--sh-line` back on itself". The picker did not, so its border and
 * its header rule both resolved to transparent; and it was painted
 * `--sh-surface-raised`, which is the card's OWN fill, so it had no contrast
 * either. A floating panel with no edge and no fill difference is a panel that
 * renders and cannot be found, which is the one bug a screenshot catches and no
 * unit test did.
 *
 * Asserted against the RULES rather than a computed style, for the reason
 * `css-rules.ts` gives: jsdom lays nothing out, so a test may assert what a rule
 * says and never what it renders.
 */

/**
 * Every declaration of `property` by rules for EXACTLY this selector.
 *
 * `rulesMentioning` is a substring match, which is right for its own job and
 * wrong here: `.sh-composer-picker` is a prefix of `.sh-composer-picker-mark`,
 * whose `background: currentColor` sailed into the fill assertion below and made
 * it fail for a reason that had nothing to do with the panel.
 */
function declared(selector: string, property: string): string[] {
  return rulesMentioning(selector)
    .filter((rule) => rule.selectorText.split(',').some((part) => part.trim() === selector))
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter((value) => value !== '');
}

describe('the picker draws a boundary', () => {
  beforeAll(() => {
    /*
     * The guard that stops every assertion below from passing vacuously.
     *
     * With `css: false` a stylesheet import is stubbed to nothing, so
     * `document.styleSheets` is empty, every `rulesMentioning` returns `[]` and
     * every `expect` on it holds. That is the same shape as this repo's
     * `-only-testing:` trap — a suite that matches nothing reports success — and
     * it is worth one assertion to make impossible.
     */
    expect(rulesMentioning('sh-composer-picker').length).toBeGreaterThan(0);
    expect(rulesMentioning('sh-ui-composer').length).toBeGreaterThan(0);
  });

  it('re-declares `--sh-line`, because the composer set it to transparent', () => {
    // The escape hatch, used. Without it the border below draws nothing.
    const lines = declared('.sh-composer-picker', '--sh-line');
    expect(lines).not.toHaveLength(0);
    for (const value of lines) expect(value).not.toBe('transparent');
  });

  it('confirms the composer really does zero `--sh-line` for its subtree', () => {
    // The other half of the pair: if this ever stops being true the rule above
    // becomes cargo, and a test that asserts a workaround without asserting the
    // thing worked around is a test that outlives its own reason.
    expect(declared('.sh-ui-composer', '--sh-line')).toContain('transparent');
  });

  it('draws a border that reads the re-declared role', () => {
    const border = declared('.sh-composer-picker', 'border');
    expect(border.join(' ')).toContain('var(--sh-line)');
  });

  it('is NOT painted the card‘s own fill, or it has no contrast with it', () => {
    /*
     * The ladder is canvas → surface → surfaceRaised and stops, and the composer
     * card is already `surfaceRaised` — so there is no role above it and a
     * popover painted `surfaceRaised` is painted the colour of the thing it floats
     * over. The fill must therefore be a step INVENTED for it (a wash over the
     * card's own colour), which is the recorded `surfaceOverlay` finding.
     */
    const background = declared('.sh-composer-picker', 'background');
    expect(background).not.toHaveLength(0);
    for (const value of background) {
      expect(value).not.toBe('var(--sh-surface-raised)');
      expect(value).toContain('color-mix');
    }
  });

  it('lifts off the card with a shadow, softened for the light theme', () => {
    // A departure from rule 2, deliberate and reasoned in the stylesheet: the
    // rule's premise is a step that does not exist above `surfaceRaised`. Both
    // themes are declared, because one 55%-black shadow reads as soot on a pale
    // surface.
    expect(declared('.sh-composer-picker', 'box-shadow')).not.toHaveLength(0);
    expect(rulesMentioning('sh-composer-picker').some((rule) => rule.selectorText.includes('light'))).toBe(
      true,
    );
  });

  it('paints its header rule from the same role, inherited from the panel', () => {
    // One `--sh-line` declaration covers the panel edge and the header seam
    // under it — custom properties inherit, so the header needs no opinion.
    expect(declared('.sh-composer-picker-head', 'border-bottom').join(' ')).toContain(
      'var(--sh-line)',
    );
  });
});
