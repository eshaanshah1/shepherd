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
 * "no inner hairlines" means as a rule rather than a wish — so a rule in here that
 * draws an edge from that role draws nothing at all.
 *
 * **What changed:** the panel is no longer a floating popover. The design fuses it
 * to the bottom of the well ("the picker is part of the well, not a popover over
 * it"), so the assertions about a *layer* — a shadow lifting it off the card, a
 * `color-mix` fill inventing a step above `raised`, a re-declared `--sh-line` for
 * the whole subtree — describe a treatment this file used to pin and the app no
 * longer has. They are replaced rather than deleted: the underlying invariant is
 * the same one, and it is the one the defect was about. **Every seam inside this
 * panel must name a value that is actually visible, and the panel must not be the
 * same colour as the card it is part of.**
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

  it('confirms the composer really does zero `--sh-line` for its subtree', () => {
    // The premise of every assertion below. If this stops being true they become
    // cargo, and a test that guards a workaround without asserting the thing
    // worked around is a test that outlives its own reason.
    expect(declared('.sh-ui-composer', '--sh-line')).toContain('transparent');
  });

  it('draws no seam from the role the composer zeroed', () => {
    /*
     * THE defect, stated directly. Any edge in this panel painted from
     * `var(--sh-line)` resolves to transparent, and the panel had two of them —
     * its own border and its header rule — so it rendered with no boundary at
     * all. The rule now covers the whole panel rather than just the two edges
     * that were wrong at the time.
     */
    const seams = ['border', 'border-top', 'border-bottom', 'border-left', 'border-right'];
    for (const rule of rulesMentioning('sh-composer-picker')) {
      for (const seam of seams) {
        const value = rule.style.getPropertyValue(seam).trim();
        if (value === '') continue;
        expect(`${rule.selectorText} { ${seam} }`, value).not.toContain('var(--sh-line)');
      }
    }
  });

  it('fuses to the well: a top seam, and no floating-layer machinery', () => {
    // A band in flow at the bottom of the card. Each of these was a property the
    // popover needed and a fused panel must not have — `position` and `z-index`
    // placed it over the card, `width` made it a panel of its own size, and
    // `box-shadow` lifted it off a surface it is now part of.
    expect(declared('.sh-composer-picker', 'border-top')).not.toHaveLength(0);
    for (const gone of ['position', 'z-index', 'width', 'box-shadow']) {
      expect(declared('.sh-composer-picker', gone), gone).toHaveLength(0);
    }
  });

  it('is NOT painted the card’s own fill, or it has no contrast with it', () => {
    /*
     * The card is `well`; this band is a step DOWN from it, which is the
     * direction the design takes it and the one that leaves a selected row's
     * fill above its ground rather than below it. Any value that resolves to the
     * card's own surface would make the two one undifferentiated block again —
     * which is what the first version of this panel did, one role higher up.
     */
    const background = declared('.sh-composer-picker', 'background');
    expect(background).not.toHaveLength(0);
    for (const value of background) {
      expect(value).not.toBe('var(--sh-well)');
      expect(value).not.toBe('var(--sh-raised)');
    }
  });

  it('takes the card’s bottom corners, less its border', () => {
    // The fused-panel maths `composer.css` names when it explains why the radius
    // is a token: a square-cornered band inside a 16px card pokes through it.
    const radius = declared('.sh-composer-picker', 'border-radius').join(' ');
    expect(radius).toContain('var(--sh-radius-soft)');
    expect(radius).toContain('calc');
  });

  it('paints its header rule from a value that is visible', () => {
    const seam = declared('.sh-composer-picker-head', 'border-bottom').join(' ');
    expect(seam).not.toBe('');
    expect(seam).not.toContain('var(--sh-line)');
  });
});

/**
 * MUTATION TARGET. Being the active row must not TAKE anything away.
 *
 * Three separate rules in this app cancelled something on a selected row —
 * the fuzzy-match highlight, the row's label colour and its metadata colour —
 * and all three gave the same reason: the fill is a solid block of `text`, so
 * ordinary ink would be unreadable on it. That was true of inverse video and
 * became false the day `fillSelected` was re-pointed at a luminance step. Nothing
 * caught it, because each rule was locally sensible and the premise lived in a
 * comment.
 *
 * The one that shipped visibly: you type `she`, arrow onto `shepherd`, and the
 * `she` stops being blue on the one row you are about to act on.
 *
 * So this asserts the SHAPE of that mistake rather than the three instances. A
 * rule may absolutely style a selected row — the fill is one — but a rule whose
 * whole content is "on a selected row, this colour goes away" is the bug, and it
 * now has to argue with a test.
 */
describe('selection adds, it does not subtract', () => {
  it('never cancels a colour just because the row is selected', () => {
    const cancels = rulesMentioning('sh-ui-row--selected')
      .filter((rule) => {
        const colour = rule.style.getPropertyValue('color').trim();
        // `inherit` is the tell: it means "whatever the row is", which is only
        // ever an improvement on a purpose-built colour when the row's own ink is
        // fighting an inverse-video fill.
        return colour === 'inherit';
      })
      .map((rule) => rule.selectorText);
    expect(cancels).toEqual([]);
  });

  it('keeps the fuzzy-match highlight on the active row', () => {
    // Positive half, so the rule above cannot be satisfied by deleting the
    // highlight altogether.
    expect(declared('.sh-composer-picker-hit', 'color')).toContain('var(--sh-sky)');
  });
});
