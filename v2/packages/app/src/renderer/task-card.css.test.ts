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

  it('draws no elapsed stamp, because there is no longer one to draw', () => {
    // Deleted rather than left unused: it reported task AGE on finished work, and a
    // corrected ship clock was true without earning a column beside every title.
    expect(rulesMentioning('sh-task-card__elapsed')).toHaveLength(0);
  });
});
