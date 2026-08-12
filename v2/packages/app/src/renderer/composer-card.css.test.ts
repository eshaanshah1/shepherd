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
    expect(rulesMentioning('sh-composer-select').length).toBeGreaterThan(0);
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
  it('pushes the one weighted control hard right', () => {
    // `.sh-composer-spacer` is in the markup and was in no stylesheet at all,
    // so the send circle sat wherever the pickers happened to leave it.
    expect(declared('.sh-composer-spacer', 'flex').join(' ')).toContain('1');
  });

  it('lets a ghost select hug its own label', () => {
    /*
     * `Select`'s own `min-width` and `space-between` are the settings column's:
     * every row the same width, chevrons down one edge. On this row they made
     * each picker a fixed box with its chevron flung past the word it belongs
     * to — so the composer overrides both, and this is what says so.
     */
    expect(declared('.sh-composer-select', 'min-inline-size').some(isZero)).toBe(true);
    expect(declared('.sh-composer-select .sh-ui-select__trigger', 'justify-content')).toContain(
      'flex-start',
    );
  });

  it('draws its labels at the role whose job is “a control at rest”', () => {
    // `textDim` is a resting card's TITLE, one step brighter, and three of them
    // at 12.5px were the second-loudest thing on the card.
    const ink = declared('.sh-composer-select .sh-ui-select__trigger', 'color');
    expect(ink).toContain('var(--sh-text-faint)');
    expect(ink).not.toContain('var(--sh-text-dim)');
  });
});
