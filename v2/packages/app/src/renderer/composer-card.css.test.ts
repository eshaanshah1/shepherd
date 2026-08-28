// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import './styles.css';

/**
 * The composer's card, and its control row, asserted in the CSS.
 *
 * Every clause here was a shipped defect, and all four were invisible to a unit
 * test that could only see markup: the class names were right the whole time.
 * Same argument as `composer-picker.css.test.ts` one file over — these are
 * properties of the rules, so the rules are what gets asserted.
 */

/** Every declaration of `property` by rules for EXACTLY this selector. */
function declared(selector: string, property: string): string[] {
  return rulesMentioning(selector)
    .filter((rule) => rule.selectorText.split(',').some((part) => part.trim() === selector))
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter((value) => value !== '');
}

/** `0` and `0px` are the same declaration; the cssom picks which one to keep. */
const isZero = (value: string): boolean => /^0(px)?$/.test(value);

/**
 * Does this rule style the COMPOSER, or something that merely mentions it?
 *
 * `:has(.sh-ui-composer)` names the composer to describe its ancestor — the
 * subject is the modal, and the modal zeroing its own radius is the fix rather
 * than the defect. Stripping the argument leaves the real subject behind.
 */
const stylesTheComposer = (selector: string): boolean =>
  selector.replace(/:has\([^)]*\)/g, '').includes('sh-ui-composer');

describe('one card, and the well is it', () => {
  beforeAll(() => {
    // The guard against a vacuous pass: with the CSS stubbed out every
    // assertion below holds against an empty rule list.
    expect(rulesMentioning('sh-ui-composer').length).toBeGreaterThan(0);
    expect(rulesMentioning('sh-composer-slot').length).toBeGreaterThan(0);
  });

  it('has the MODAL drop its surface, not the composer', () => {
    /*
     * The shipped reset went the other way — it stripped the composer's fill,
     * radius and padding and kept the modal's box, so what you saw was a
     * `raised` panel with the composer's surviving `lineStrong` border drawn on
     * it at radius 0: a hard square rectangle on a grey card, and neither of
     * the two boxes was `well`.
     */
    const modal = '.sh-ui-modal:has(.sh-ui-composer)';
    expect(declared(modal, 'background')).toContain('transparent');
    expect(declared(modal, 'border').some(isZero)).toBe(true);
    expect(declared(modal, 'padding').some(isZero)).toBe(true);
  });

  it('lets nothing zero the composer’s own radius', () => {
    /*
     * The half of that defect that did the visible damage. A border with its
     * radius taken away is a *different shape*, not a quieter one — so any rule
     * that wants the composer to stop being a card has to drop the border in
     * the same breath. Asserting the absence rather than the fix, because the
     * next way to reintroduce this will not be the same rule.
     */
    const zeroed = rulesMentioning('sh-ui-composer')
      .filter((rule) => stylesTheComposer(rule.selectorText))
      .filter((rule) => isZero(rule.style.getPropertyValue('border-radius').trim()))
      .map((rule) => rule.selectorText);
    expect(zeroed).toEqual([]);
  });
});

describe('the control row', () => {
  /*
   * The three assertions here used to be about `.sh-composer-spacer` and
   * `.sh-composer-select` — a spacer pushing a send circle hard right, and a
   * ghost select overriding the settings column's `min-width` and chevron
   * placement. All three are gone with their markup, because the composer stopped
   * being a card: there is no circle to push, and the controls are not selects.
   *
   * What replaced them is a row of bare `<button>`s, and what has to be asserted
   * is the same class of thing at CSS level — that the row draws no boxes it was
   * not asked to, and that its one fill means something.
   */
  it('draws no box at rest, which is the whole row', () => {
    /*
     * A `<button>` arrives with a border, a background and a radius from the UA
     * sheet, and every one of them is a box. On a surface built out of bare text
     * a box is the loudest thing present, so the reset is not tidying — it is
     * the rule.
     */
    expect(declared('.sh-composer-slot', 'border').some(isZero)).toBe(true);
    expect(declared('.sh-composer-slot', 'background')).toContain('none');
    expect(declared('.sh-composer-incognito', 'border').some(isZero)).toBe(true);
    expect(declared('.sh-composer-incognito', 'background')).toContain('none');
  });

  it('gives a fill to exactly one state, and it is the open one', () => {
    /*
     * The open slot is the only element in the row with an edge, and that is
     * what makes the edge mean something — it answers "which control am I
     * inside", which nothing else on the screen is asking.
     *
     * Asserted as an ABSENCE too: a resting slot that also had a fill would make
     * the open one a slightly different grey rather than a box.
     */
    expect(declared('.sh-composer-slot[data-open]', 'background')).toContain('var(--sh-fill-active)');
    expect(declared('.sh-composer-slot', 'background')).not.toContain('var(--sh-fill-active)');
  });

  it('draws a default at the resting role and a decision at ink', () => {
    /*
     * The row's one idea: ink is a decision you made, the ghost step is a
     * default you left alone. Spending the loudest step of the ramp on facts
     * nobody chose leaves the knob you DID turn with nothing to be louder than.
     */
    expect(declared('.sh-composer-slot', 'color')).toContain('var(--sh-text-mute)');
    expect(declared('.sh-composer-slot[data-chosen]', 'color')).toContain('var(--sh-text)');
  });

  it('keeps the incognito mark ink when it is on, and never a hue', () => {
    /*
     * Red is a run that failed. A privacy control is not a warning — it is the
     * one choice on the line made against the grain, so it takes the loudest
     * step of the neutral ramp and no colour at all.
     */
    const on = declared('.sh-composer-incognito[data-on]', 'color');
    expect(on).toContain('var(--sh-text)');
    expect(on.join(' ')).not.toContain('--sh-red');
  });

});

describe('the brief’s line box', () => {
  /**
   * A shipped defect, and the reason it is asserted at the CSS level.
   *
   * `--sh-line-height` is the contract for "how tall is a line here", and things
   * INSIDE a line measure themselves against it — a `Pill` sizes its selected
   * band from it, because CSS gives an element no way to read the line-height it
   * inherited once it has set its own. The brief used to set `line-height: 26px`
   * as a literal, so its lines were 26px while every token-reading thing in them
   * still believed 20px. Selecting text then drew a 26px band and a 20px pill,
   * notched 3px top and bottom at every boundary — measured 52/40/52 device
   * pixels at 2x, which is exactly what the screenshot showed.
   */
  it('re-declares the token rather than overriding it with a literal', () => {
    // The value comes from the token layer, derived from the base step like every
    // other length, so it scales with density instead of sitting here as a 26.
    expect(declared('.sh-composer-brief', '--sh-line-height')).toEqual([
      'var(--sh-line-height-large)',
    ]);
    // And the line-height itself READS that, so the two can never disagree.
    expect(declared('.sh-composer-brief', 'line-height')).toEqual(['var(--sh-line-height)']);
  });

  it('leaves no literal line-height anywhere a Pill can land', () => {
    // The brief is the one surface in the app that holds pills in running text.
    // A bare length here is the defect above, re-entered by a different door.
    for (const value of declared('.sh-composer-brief', 'line-height')) {
      expect(value, 'line-height must come from the token').toContain('var(--sh-line-height)');
    }
  });
});
