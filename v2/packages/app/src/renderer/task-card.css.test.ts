// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
// The sheet under test. Loaded explicitly rather than through `styles.css`, which
// does not import it — `main.tsx` pulls both in side by side.
import './task-card.css';

/**
 * The task card's stylesheet, asserted where it lives.
 *
 * The card is drawn by an extension (`@shepherd/ext-tasks/ui`) and PAINTED by the
 * shell — `task-card.css` is this package's, because §7's rule is that a
 * contribution supplies data and a token name and can set neither a colour nor a
 * length. So the component's own suite can assert its markup and nothing about
 * its geometry, and the geometry is where this defect lived.
 *
 * Same argument as `composer-card.css.test.ts` one file over: these are properties
 * of the rules, so the rules are what gets asserted.
 */

const ruleFor = (selector: string): CSSStyleRule | undefined =>
  rulesMentioning(selector).find((rule) => rule.selectorText === selector);

/**
 * The rule that CARRIES a selector, whether or not it is the only one on it.
 *
 * The trailing verb's rules are shared with the contributed fact — the two are
 * both things you do to the row, revealed together — so an exact match on
 * `.sh-task-card__action` finds nothing while the properties it asserts are all
 * still there. Matching on membership keeps those assertions about the
 * behaviour rather than about the selector list's punctuation.
 */
const ruleCarrying = (selector: string): CSSStyleRule | undefined =>
  rulesMentioning(selector)
    .find((rule) => rule.selectorText.split(',').some((part) => part.trim() === selector));

describe('the task card’s trailing action', () => {
  /**
   * MUTATION TARGET. The hover verb must not charge the title for space it does
   * not occupy at rest.
   *
   * The shared grid cell was paid for by the elapsed stamp: the track was as wide
   * as the wider of the two, so the button was free because the stamp already held
   * that space. Removing the stamp left the reservation behind — 33px of dead track
   * on every row, for a button invisible until you point at it — and every title in
   * the rail began truncating early. The region had just won 21px back by dropping
   * its state column, and this spent more than that on the other edge.
   */
  it('is out of the flow, so the title gets the whole line', () => {
    expect(ruleFor('.sh-task-card__trail')?.style.position).toBe('absolute');
    expect(ruleFor('.sh-task-card__trail')?.style.getPropertyValue('inset-inline-end')).toBe('0px');
  });

  it('is positioned against the head, which is its containing block', () => {
    // Absolute with no positioned ancestor escapes to the page — the button would
    // land in the window's top-left corner rather than the row's right edge.
    expect(ruleFor('.sh-task-card__head')?.style.position).toBe('relative');
  });

  it('reserves NO width in the flow, on any of its rules', () => {
    // The point of the whole change: a declaration here is the reservation coming
    // back, whatever it is called.
    for (const rule of rulesMentioning('sh-task-card__trail')) {
      for (const property of ['width', 'inline-size', 'min-inline-size', 'flex', 'margin-inline-end']) {
        expect(rule.style.getPropertyValue(property), `${rule.selectorText} declares ${property}`).toBe('');
      }
    }
  });

  it('backs the revealed button with the row’s OWN fill, never a new colour', () => {
    // `fillHover` and `fillSelected` are opaque (a `wash` token and a luminance
    // step), so the chip under the button is the same value as the row it sits on
    // and reads as the row ending early rather than as something dropped on the
    // text. A colour of its own would be a hue used for decoration, which §10 bans.
    const fills = rulesMentioning('sh-task-card__trail')
      .map((rule) => rule.style.background)
      .filter((value) => value !== '');
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      expect(['var(--sh-fill-hover)', 'var(--sh-fill-selected)']).toContain(fill);
    }
  });

  it('paints that backing only while the button is drawn', () => {
    // At rest the button is `visibility: hidden`. A backing that did not wait for
    // hover would put a rectangle of hover colour at the right edge of every row.
    expect(ruleFor('.sh-task-card__trail')?.style.background).toBe('');
    for (const rule of rulesMentioning('sh-task-card__trail')) {
      if (rule.style.background === '') continue;
      expect(rule.selectorText).toMatch(/:hover|:focus-within/);
    }
  });

  it('slides the verb in from the right, at the row entrance’s own distance', () => {
    /*
     * §8 refuses motion that translates a control, because a control that moves
     * under the cursor is a control whose target moved mid-click. Two things bound
     * it: the distance and duration are the row ENTRANCE's own (`row.css` animates
     * an arriving row by opacity and a 4px slide), so this is that precedent applied
     * to a control that is also arriving; and 4px sits inside the button's own hit
     * target, so the target does not meaningfully move.
     */
    const action = ruleCarrying('.sh-task-card__action');
    expect(action?.style.transform).toBe('translateX(var(--sh-space-xs))');
    expect(action?.style.transition).toContain('transform var(--sh-motion)');

    const revealed = rulesMentioning('sh-task-card__action').find((rule) =>
      rule.selectorText.includes(':hover'),
    );
    expect(revealed?.style.transform).toBe('none');
  });

  /**
   * MUTATION TARGET. The verb and its backing must arrive at the same speed as the
   * row they arrive on.
   *
   * The card fades its own fill over `--sh-motion`. The button toggled
   * `visibility` and the chip switched `background` with no transition, so both
   * snapped in over a background that was still easing — one element instant, the
   * one behind it moving, which reads as two unrelated events rather than as one
   * row waking up.
   */
  it('fades the verb and its backing over the row’s own duration', () => {
    expect(ruleCarrying('.sh-task-card__action')?.style.transition).toContain('opacity var(--sh-motion)');
    expect(ruleFor('.sh-task-card__trail')?.style.transition).toContain('background var(--sh-motion)');
  });

  it('keeps visibility in the transition, so the fade works in both directions', () => {
    /*
     * `visibility` is discrete, and a transition whose endpoints include `visible`
     * holds `visible` for the whole duration. That is what makes the button
     * hit-testable the moment it starts to appear, and keeps it painted while it
     * fades out — `opacity` alone would leave a control you cannot see but CAN
     * click and tab to, which is worse than no control.
     */
    const action = ruleCarrying('.sh-task-card__action');
    expect(action?.style.visibility).toBe('hidden');
    expect(action?.style.opacity).toBe('0');
    expect(action?.style.transition).toContain('visibility var(--sh-motion)');
  });

  it('removes the fade under reduced motion rather than shortening it', () => {
    // The same accommodation the row's entrance makes: there is no information in a
    // cross-fade, so the honest answer is that the verb is simply there.
    const reduced = rulesMentioning('sh-task-card__action').filter(
      (rule) => rule.style.transition === 'none',
    );
    expect(reduced.length).toBeGreaterThan(0);
  });

  it('draws no elapsed stamp, because there is no longer one to draw', () => {
    // Deleted rather than left unused: it reported task AGE on finished work, and a
    // corrected ship clock was true without earning a column beside every title.
    expect(rulesMentioning('sh-task-card__elapsed')).toHaveLength(0);
  });
});

describe('a contributed fact', () => {
  /**
   * MUTATION TARGET. A fact is a VERB, and it is revealed WITH the row's other
   * one.
   *
   * The PR glyph opens the review tab; Ship ships the task. Two things you do to
   * the row, so one cell and one reveal. The shape this replaced reserved the
   * verb's width and left the glyph floating in the middle of it — a control
   * offset from the row's edge by exactly the width of a button that was not
   * drawn yet, which reads as a mistake because it is one.
   *
   * The regression this guards is the reservation coming back: it charges every
   * fact-bearing title for space that is empty at rest.
   */
  it('is hidden at rest and revealed with the row’s verb', () => {
    // The one that DECLARES visibility: `.sh-task-card__fact` also has an
    // earlier block for its own type and colour, and finding that one first
    // would make this assert about the wrong rule.
    const resting = rulesMentioning('sh-task-card__fact').find(
      (rule) => rule.style.visibility !== '' && rule.selectorText.includes('.sh-task-card__fact'),
    );
    expect(resting?.style.visibility).toBe('hidden');

    const revealed = rulesMentioning('sh-task-card__fact').find((rule) =>
      rule.selectorText.includes(':hover .sh-task-card__fact'),
    );
    expect(revealed?.style.visibility).toBe('visible');
  });

  it('charges the title nothing at rest', () => {
    // No reserved slot anywhere: the head's trailing inset is the regression.
    expect(ruleFor('.sh-task-card__head')?.style.getPropertyValue('padding-inline-end')).toBe('');
    expect(rulesMentioning('sh-task-card').some((rule) => rule.selectorText.includes('data-has-fact'))).toBe(false);
  });
});
