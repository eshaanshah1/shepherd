// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import './styles.css';

/**
 * The takeover composer's vertical behaviour, asserted where it lives.
 *
 * Both facts below were shipped defects, and both were properties of the CSS
 * rather than of the markup — the shape §9 warns about, where a suite of green
 * component tests can see neither. They are one bug wearing two hats: something
 * on the screen was allowed to change the position of something above it.
 *
 *   - the column was centred on a point (`translateY(-50%)`), so every ⏎ walked
 *     the knob row up half a line;
 *   - the picker was in flow, so opening it pushed the column taller and — with
 *     a leader above it — moved the knob row again, in the other direction.
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

/** The last value to win the cascade among rules for exactly this selector. */
function last(selector: string, property: string): string {
  const values = declared(selector, property);
  return values.at(-1) ?? '';
}

describe('the composer grows down, then up', () => {
  beforeAll(() => {
    // The guard that stops every assertion below from passing vacuously: with a
    // stubbed stylesheet import every `rulesMentioning` returns `[]`.
    expect(rulesMentioning('sh-compose-frame').length).toBeGreaterThan(0);
  });

  it('nails the column top with a leader that yields, not with a coordinate', () => {
    /*
     * The leader may shrink — that is phase 2 — and it stops at the gutter, so
     * the block rises to the top margin and no further.
     */
    expect(last('.sh-compose-lead', 'flex')).toMatch(/0\s+1\s/);
    expect(last('.sh-compose-lead', 'min-block-size')).toBe('var(--sh-compose-gutter)');

    /*
     * The floor does not. It is the promise the whole mechanism turns on: with a
     * shrinkable floor the block would descend into the bottom eighth of the
     * window instead of rising out of it, and phase 2 would never happen.
     */
    expect(last('.sh-compose-floor', 'flex')).toMatch(/^0\s+0\s/);

    /*
     * And the column never gives space back to the leader. `flex-shrink: 1` here
     * would let the leader win a fight it is meant to lose, which reads as the
     * sentence being squeezed to keep a margin.
     */
    expect(last('.sh-compose', 'flex')).toMatch(/^0\s+0\s/);
  });

  it('does not centre the column on a point', () => {
    // The regression itself: `translateY(-50%)` grows the block in BOTH
    // directions, which is the top edge moving on every ⏎.
    expect(declared('.sh-compose', 'transform')).toEqual([]);
    expect(declared('.sh-compose', 'inset-block-start')).toEqual([]);
  });

  it('caps the brief against the frame rather than at a line count', () => {
    // A literal here — `40vh`, `12 lines` — is a cap that stops the field short
    // of room it can see, which is the thing the derived one exists to refuse.
    const cap = last('.sh-screen .sh-composer-brief', 'max-block-size');
    expect(cap).toContain('var(--sh-compose-gutter)');
    expect(cap).toContain('vh');
  });
});

describe('the picker is an overlay', () => {
  it('is positioned, so opening it moves nothing', () => {
    expect(last('.sh-screen .sh-composer-picker', 'position')).toBe('absolute');
    // Anchored to the column's bottom edge, which is the last line of the brief.
    expect(last('.sh-screen .sh-composer-picker', 'inset-block-start')).toContain('100%');
    // And the box it is anchored to has to be the positioning context.
    expect(last('.sh-compose', 'position')).toBe('relative');
  });

  it('leaves nothing in flow below the brief for the floor to measure to', () => {
    /*
     * The send line and an empty status are the two things that would sit under
     * the sentence and take the column's bottom edge with them — the edge both
     * the picker and the hint anchor to, and the edge the floor is a promise
     * about. A caption on the comfort line is the caret one line above it.
     */
    expect(last('.sh-screen .sh-composer-send', 'position')).toBe('absolute');
    expect(last('.sh-compose .sh-ext-answer:empty', 'display')).toBe('none');
  });
});
