// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rulesMentioning } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import '../styles.css';
import '../takeover.css';
import { REGION_COLUMNS, TRAIL_ORDER, ageFor } from './columns.ts';
import { TRIAGE_ORDER } from './triage.ts';

/**
 * The overview's columns, against the sheet that draws them.
 *
 * Two halves that can drift and would drift silently: which cells a region
 * declares (here) and which track each cell is pinned to (`takeover.css`). A
 * cell whose CSS track disagreed with its position in `TRAIL_ORDER` would draw
 * in the wrong column — and jsdom lays nothing out, so nothing else in the suite
 * could see it.
 *
 * Asserted against the RULES rather than a computed style, for the reason
 * `css-rules.ts` gives: a test here may assert what a rule SAYS and never what
 * it renders.
 */

/** What `property` is declared as by rules for exactly `selector`. */
function declared(selector: string, property: string): string[] {
  return rulesMentioning(selector)
    .filter((rule) => rule.selectorText === selector)
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter((value) => value !== '');
}

describe('a region names its own columns', () => {
  it('has an answer for every region, so no row falls back to its payload', () => {
    for (const group of TRIAGE_ORDER) expect(REGION_COLUMNS[group]).toBeDefined();
  });

  it('draws the age only where a wait is the thing being reported', () => {
    /*
     * The whole editorial claim, as an assertion. `elapsed` is stamped on every
     * task row by `tasks`, and drawing it everywhere is what put `3m` on a
     * Running row — a number nothing you would do depends on, and the reason no
     * two rows in that region ended in the same place.
     */
    const withAge = TRIAGE_ORDER.filter((group) => REGION_COLUMNS[group].cells.includes('age'));
    expect(withAge).toEqual(['needs']);
  });

  it('draws a diff only where the change is what you are deciding about', () => {
    const withDiff = TRIAGE_ORDER.filter((group) => REGION_COLUMNS[group].cells.includes('diff'));
    // Not `running`: a diff mid-flight is a number that moves while you read it.
    // `needs` draws it because it holds the rows that changed something and the
    // rows that did not, and the diff is what tells those apart.
    expect(withDiff).toEqual(['needs', 'shipped']);
  });

  it('draws the repo everywhere, which is what earns it the last track', () => {
    // The claim the ordering rests on: a right edge made of a cell some rows
    // omit is ragged however well the tracks agree.
    for (const group of TRIAGE_ORDER) expect(REGION_COLUMNS[group].cells).toContain('repos');
    expect(TRAIL_ORDER[TRAIL_ORDER.length - 1]).toBe('repos');
  });

  it('names no cell it does not draw in `TRAIL_ORDER`', () => {
    for (const group of TRIAGE_ORDER) {
      for (const cell of REGION_COLUMNS[group].cells) expect(TRAIL_ORDER).toContain(cell);
    }
  });
});

describe('the age a region will print', () => {
  it('prints the stamp as sent, where the wait is the point', () => {
    expect(ageFor('14m', undefined)).toBe('14m');
    expect(ageFor(undefined, undefined)).toBeUndefined();
  });

  it('keeps only a day-or-older stamp at day granularity', () => {
    // No region asks for it today. The filter is kept because the argument
    // behind it survives: a stamp whose minutes nobody would act on is noise.
    expect(ageFor('3d', 'd')).toBe('3d');
    expect(ageFor('3m', 'd')).toBeUndefined();
    expect(ageFor('3h', 'd')).toBeUndefined();
  });
});

describe('the tracks the sheet pins each cell to', () => {
  it('numbers them in `TRAIL_ORDER`, after the mark and the name', () => {
    TRAIL_ORDER.forEach((cell, at) => {
      // Two columns precede them — the state mark, then the name — so the first
      // trailing cell is track 3.
      expect(declared(`.sh-take__cell[data-cell='${cell}']`, 'grid-column')).toEqual([String(at + 3)]);
    });
  });

  it('has the age reserve its widest form, since it changes on a clock', () => {
    /*
     * Every other cell changes only when the work does. The age ticks on a
     * minute timer, so an `auto` track would re-size the moment a row crossed
     * from `9m` to `10m` and step the columns left of it under the cursor.
     */
    // The padding is part of it: `box-sizing` is `border-box` app-wide, so a
    // bare `4ch` would hand the text three characters and the padding the rest.
    expect(declared(".sh-take__cell[data-cell='age']", 'min-inline-size')).toEqual([
      'calc(4ch + var(--sh-space-lg))',
    ]);
    for (const cell of ['diff', 'repos']) {
      expect(declared(`.sh-take__cell[data-cell='${cell}']`, 'min-inline-size')).toEqual([]);
    }
  });

  it('gives the section as many tracks as there are cells to hold', () => {
    const tracks = declared('.sh-take__group', 'grid-template-columns')[0] ?? '';
    expect(tracks.match(/auto/g)).toHaveLength(TRAIL_ORDER.length);
  });

  it('keeps every cell on the jump’s row, so a chip cannot start a second one', () => {
    /*
     * The jump pins itself to row 1 and spans to `-1`. A cell with a definite
     * column and an AUTO row cannot be placed there, so auto-placement put it
     * in an implicit second row: the row grew a line and the repo chip drew
     * above the hover icons rather than behind them, out of line with every
     * other row in the region. They share a cell only if both name their row.
     */
    expect(declared('.sh-take__cell', 'grid-row')).toEqual(['1']);
    expect(declared('.sh-take__jump', 'grid-row')).toEqual(['1']);
  });

  it('borrows the region’s tracks rather than declaring its own', () => {
    // An `auto` here would size a column to ONE row's content, which is the
    // defect this replaced: rows that agree with nothing but themselves.
    expect(declared('.sh-take__row', 'grid-template-columns')).toEqual(['subgrid']);
  });
});

describe('the question card’s verbs are not the row’s hover shortcuts', () => {
  it('leaves the card’s controls visible', () => {
    /*
     * These were both `.sh-take__acts`, declared 500 lines apart at equal
     * specificity, and the later rule's `visibility: hidden` reached the card —
     * whose buttons are the one thing on Home you cannot do any other way. Both
     * were in the DOM and both were clickable, so every test passed.
     */
    expect(declared('.sh-take__acts', 'visibility')).toEqual([]);
    expect(declared('.sh-take__jump', 'visibility')).toEqual(['hidden']);
  });
});
