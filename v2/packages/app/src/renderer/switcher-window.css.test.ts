// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import './takeover.css';

/**
 * **⌘K's list is a window, and the assertion has to be about the CSS.**
 *
 * The switcher lists every task the takeover knows, and the tail of that list is
 * the shipped record — unbounded by design, because finished work is kept rather
 * than counted. A card that draws all of it runs off the bottom of a scrim which
 * is `position: fixed` and scrolls nothing, so the rows past the fold are
 * unreachable by pointer and invisible to the keyboard at once. Nothing in the
 * markup can be asked about that: the defect is three declarations, or the
 * absence of them.
 *
 * The scale is asserted alongside the window because the window is written in
 * terms of it. The overlays mount at the app's root rather than inside
 * `.sh-take`, so `--sh-take-row` reaches them only if the scrim declares it, and
 * an undeclared custom property does not fail loudly — it makes every length
 * written from it compute to its initial value and the card silently loses its
 * rhythm.
 *
 * Asserted against the RULES rather than a computed style, for the reason
 * `css-rules.ts` gives: jsdom lays nothing out, so a test may assert what a rule
 * says and never what it renders.
 */

/** Every declaration of `property` by rules for EXACTLY this selector. */
function declared(selector: string, property: string): string[] {
  return rulesMentioning(selector)
    .filter((rule) => rule.selectorText.split(',').some((part) => part.trim() === selector))
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter((value) => value !== '');
}

describe('the switcher list is bounded', () => {
  beforeAll(() => {
    // The guard against a vacuous suite: with `css: false` a stylesheet import is
    // stubbed to nothing, `document.styleSheets` is empty, and every assertion
    // below holds over an empty list.
    expect(rulesMentioning('sh-take__krows').length).toBeGreaterThan(0);
    expect(rulesMentioning('sh-take__scrim').length).toBeGreaterThan(0);
  });

  it('caps the rows and scrolls them', () => {
    // THE defect, stated directly. Either half alone is worse than neither: a cap
    // without a scroller clips the tail, and a scroller without a cap never has
    // anything to scroll.
    expect(declared('.sh-take__krows', 'max-block-size')).not.toHaveLength(0);
    expect(declared('.sh-take__krows', 'overflow-y')).toContain('auto');
  });

  it('measures the window in the takeover’s own row, not a length of its own', () => {
    // The switcher and a windowed region on Home are the same ten rows. A number
    // typed here is one that stops agreeing with Home the day the row changes.
    const cap = declared('.sh-take__krows', 'max-block-size').join(' ');
    expect(cap).toContain('var(--sh-take-region-rows)');
    expect(cap).toContain('var(--sh-take-row)');
  });

  it('gives the scrim the scale the window is written in', () => {
    /*
     * The premise of the rule above. These overlays render at the app's root,
     * outside `.sh-take` and outside `.sh-take-band`, so every `--sh-take-*` a
     * row reads has to be declared here or it resolves to nothing.
     */
    for (const property of ['--sh-take-row', '--sh-take-region-rows', '--sh-take-head', '--sh-take-radius']) {
      expect(declared('.sh-take__scrim', property), property).not.toHaveLength(0);
    }
  });

  it('agrees with the scopes that declare the same scale', () => {
    // Three declarations of one scale is what a tier-3 property costs; three
    // different values is a card whose rows are a different height depending on
    // which layer drew them.
    for (const property of ['--sh-take-row', '--sh-take-head', '--sh-take-radius']) {
      const scrim = declared('.sh-take__scrim', property);
      expect(declared('.sh-take-band', property), property).toEqual(scrim);
      expect(declared('.sh-take', property), property).toEqual(scrim);
    }
  });

  it('holds the heading outside the scroller', () => {
    // `Jump to` names the whole list. Inside the window it would be a label that
    // is absent for nine rows out of ten.
    expect(declared('.sh-take__klist', 'overflow-y')).toHaveLength(0);
    expect(declared('.sh-take__klist', 'max-block-size')).toHaveLength(0);
  });

  it('draws the app’s scrollbar: a thumb, and no track or chrome', () => {
    expect(declared('.sh-take__krows', 'scrollbar-width')).toContain('thin');
    expect(declared('.sh-take__krows', 'scrollbar-color')).toContain('var(--sh-line) transparent');
    expect(declared('.sh-take__krows::-webkit-scrollbar-track', 'background')).toContain('transparent');
    expect(declared('.sh-take__krows::-webkit-scrollbar-thumb', 'background')).toContain('var(--sh-line)');
    // Squared off, like every other bar in the app. A rounded thumb is chrome
    // asking to be looked at on a surface whose whole job is the list under it.
    // `0px` rather than `0`: jsdom serialises the length back with its unit.
    expect(declared('.sh-take__krows::-webkit-scrollbar-thumb', 'border-radius')).toContain('0px');
  });
});
