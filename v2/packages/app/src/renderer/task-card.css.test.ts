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

describe('the meta line', () => {
  it('closes the card’s own gap, so the title and the numbers read as one block', () => {
    /*
     * The regression this pins: a dense head is `--sh-row-height` (right for a
     * row whose whole content is one centred title) and the card gaps its
     * children by `md` (right between a title and a question). Together they put
     * 9px of nothing under a title floating in 34px, and the pair read as two
     * rows rather than as one task saying two things.
     */
    const meta = ruleFor('.sh-task-card__meta');
    expect(meta?.style.getPropertyValue('margin-block-start')).toBe(
      'calc(var(--sh-space-sm) - var(--sh-space-md))',
    );

    // And the head stops being a fixed row when it is only half of one.
    const head = rulesMentioning('sh-task-card__head').find((rule) =>
      rule.selectorText.includes(':has(> .sh-task-card__meta)'),
    );
    expect(head?.style.getPropertyValue('block-size')).toBe('auto');
  });

  it('draws the elapsed stamp on the META line, never back in the title track', () => {
    /*
     * A stamp lived here once and was deleted for a good reason: it reported
     * task AGE, which on finished work is the wrong subject, and a corrected
     * ship clock was true without earning a column beside every title.
     *
     * What came back is a different measurement — how long the task has been in
     * the state its MARK reports — and it came back on the second line, where
     * the diff numbers used to be. The regression this guards is it creeping
     * back into the head, which is the arrangement that charged every title for
     * it.
     */
    const stamp = ruleFor('.sh-task-card__elapsed');
    // jsdom expands the `none` shorthand; what matters is that it never grows.
    expect(stamp?.style.flexGrow).toBe('0');
    expect(stamp?.style.flexShrink).toBe('0');
    expect(stamp?.style.color).toBe('var(--sh-text-ghost)');

    const inHead = rulesMentioning('sh-task-card__elapsed').filter((rule) =>
      rule.selectorText.includes('__head'),
    );
    expect(inHead).toEqual([]);
  });

  it('starts under the TITLE, not under the mark', () => {
    // The mark's slot is the column the eye uses to find state. A second line
    // beginning in it puts text where a mark belongs.
    for (const selector of ['.sh-task-card__meta', '.sh-task-card__foot', '.sh-task-card__suiteRow']) {
      expect(ruleFor(selector)?.style.getPropertyValue('padding-inline-start'), selector).toBe(
        'var(--sh-task-gutter)',
      );
    }
  });
});

describe('the task card’s trailing action', () => {
  /**
   * MUTATION TARGET. The glyph and the verb sit IN their lines, not over them.
   *
   * They spent three rounds as an absolutely positioned column spanning both
   * rows, told where those rows were by a grid whose track sizes had to be kept
   * in step with the card's padding and line heights by hand. Each time one of
   * those numbers moved, the glyph landed on the wrong line or the verb fell out
   * through the bottom of the card onto the row below. Every one of those was
   * the same bug wearing different clothes: a box told where a line was, instead
   * of being put in it.
   *
   * So the invariant is now structural, and this is what guards it: nothing in
   * this file may position either of them.
   */
  it('positions neither the glyph nor the verb — they are IN their lines', () => {
    for (const selector of ['sh-task-card__fact', 'sh-task-card__action']) {
      // Pseudo-elements excluded: a clickable fact grows its hit area with an
      // absolutely positioned `::after` (§9's coarse-pointer rule), which is a
      // box inside the element rather than the element being placed on a line.
      const rules = rulesMentioning(selector).filter((rule) => !rule.selectorText.includes('::'));
      for (const rule of rules) {
        // `position: relative` is allowed — a clickable fact grows its hit area
        // through a pseudo-element and needs to be its own containing block.
        // What is banned is being PLACED: taken out of flow and given a spot.
        expect(rule.style.position, `${rule.selectorText} is positioned`).not.toBe('absolute');
        for (const property of ['inset-block', 'inset-inline-end', 'top', 'bottom']) {
          expect(rule.style.getPropertyValue(property), `${rule.selectorText} sets ${property}`).toBe('');
        }
      }
    }
  });

  it('has no positioned column left to go wrong', () => {
    // The wrapper is gone entirely, not merely unstyled: a rule naming it would
    // be the apparatus growing back.
    expect(rulesMentioning('sh-task-card__trail')).toEqual([]);
  });

  it('sends the verb to the end of its line, without naming a width', () => {
    // `margin-inline-start: auto` rather than a reserved track: the element IS
    // the reservation, so there is no number to keep in step with a control's
    // size and no way for the two to disagree.
    expect(ruleFor('.sh-task-card__action')?.style.getPropertyValue('margin-inline-start')).toBe('auto');
  });

  it('lines the verb’s GLYPH up with the fact above it, not its box', () => {
    /*
     * The fact on the title line is a bare glyph; the verb under it is an
     * `IconButton`, a `--sh-control-sm` square with the same glyph centred in it.
     * Flushed against the same padding edge, the two marks land half the
     * difference apart — a column of two glyphs that do not share an edge, which
     * is the kind of misalignment you see without being able to name.
     *
     * The half-difference comes back as a negative end margin, and only when the
     * verb IS the trailing edge: with repo chips after it there is nothing above
     * to line up with and the shift would eat the line's gap.
     */
    const rule = ruleFor('.sh-task-card__action:last-child');
    expect(rule?.style.getPropertyValue('margin-inline-end')).toBe(
      'calc((var(--sh-font-size-medium) - var(--sh-control-sm)) / 2)',
    );
  });

  it('reserves ONE width, whether or not a row happens to have a fact', () => {
    /*
     * A `data-has-fact` variant would make the title's run depend on whether a
     * task's repo has a GitHub remote, so two rows in one list would truncate at
     * different places for a reason nothing on screen states.
     */
    expect(rulesMentioning('sh-task-card').some((rule) => rule.selectorText.includes('data-has-fact'))).toBe(false);
  });

  it('lets the slot ellipsise rather than run past the row’s edge', () => {
    /*
     * The step and the summary SHARE the slot, so they share one rule — a
     * declaration of its own for either is how the two would drift. Neither ever
     * GROWS: the duration beside them keeps its whole width, since a duration is
     * three characters and whole where a sentence truncates fine.
     */
    for (const selector of ['.sh-task-card__stage', '.sh-task-card__summary']) {
      const rule = ruleCarrying(selector);
      expect(rule?.style.getPropertyValue('text-overflow'), selector).toBe('ellipsis');
      expect(rule?.style.overflow, selector).toBe('hidden');
      expect(rule?.style.getPropertyValue('min-inline-size'), selector).toBe('0px');
      expect(rule?.style.flexGrow, selector).toBe('0');
      expect(rule?.style.getPropertyValue('white-space'), selector).toBe('nowrap');
    }
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
  it('has no entrance animation — it is drawn, not revealed', () => {
    /*
     * It carried a `translateX`, sliding in from the row's edge beside the verb.
     * That is right for something revealed on hover and meaningless for
     * something drawn at rest — and the `transform: none` that cancels it lives
     * on the hover rule, so a fact that no longer hovers sat 4px right of where
     * it belonged, permanently, with nothing to put it back. Twice, one scope
     * apart.
     */
    const shifted = rulesMentioning('sh-task-card__fact').filter(
      (rule) => rule.style.transform !== '' && rule.style.transform !== 'none',
    );
    expect(shifted.map((rule) => rule.selectorText)).toEqual([]);
  });

  it('is drawn at REST — nothing hides a fact unconditionally', () => {
    /*
     * The inversion this whole change turns on. A fact used to be hidden until
     * you pointed at the row, and the component said the cost out loud: "the
     * rail stops saying *this task's PR is red* at a glance."
     *
     * So the invariant is about the UNCONDITIONAL rules: a `visibility: hidden`
     * on the fact with no state in its selector takes every glyph off the rail.
     * Rules that hide it under `:hover` are the row's swap and are asserted
     * below.
     */
    const alwaysHidden = rulesMentioning('sh-task-card__fact').filter(
      (rule) =>
        rule.style.visibility === 'hidden' &&
        !rule.selectorText.includes(':hover') &&
        !rule.selectorText.includes(':focus-within'),
    );
    expect(alwaysHidden.map((rule) => rule.selectorText)).toEqual([]);
  });

  it('needs no swap, because nothing shares a cell any more', () => {
    /*
     * A row used to hide its glyph on hover so the verb could take the single
     * slot they shared. In flow they simply sit next to each other and both fit,
     * so hiding one would be taking a state off the rail for no reason.
     */
    const swap = rulesMentioning('sh-task-card__fact').filter(
      (rule) => rule.style.visibility === 'hidden',
    );
    expect(swap.map((rule) => rule.selectorText)).toEqual([]);
  });

  it('gives pending and done their own hues, so five states separate at rest', () => {
    // Never colour ALONE — `github` varies the glyph too — but a tone that was
    // shared is a distinction the eye cannot make. `running` used to be `sky`,
    // the same as `open`; `merged` used to be the quiet grey of a fact that is
    // not asking for anything.
    expect(ruleFor(".sh-task-card__fact[data-tone='pending']")?.style.color).toBe('var(--sh-honey)');
    expect(ruleFor(".sh-task-card__fact[data-tone='done']")?.style.color).toBe('var(--sh-plum)');
  });

  it('reserves ONE width, whether or not a row happens to have a fact', () => {
    /*
     * The half of the old rule that still stands. Reserving for the column is
     * honest — something is always in it — but reserving CONDITIONALLY is not:
     * a `data-has-fact` variant would make the title's left-to-right run depend
     * on whether a task's repo has a GitHub remote, so two rows in one list
     * would truncate at different places for a reason nothing on screen states.
     */
    expect(rulesMentioning('sh-task-card').some((rule) => rule.selectorText.includes('data-has-fact'))).toBe(false);
  });
});

/**
 * The incognito glyph, which sits in the meta line's reserved gutter.
 *
 * The whole claim of that placement is that the row beside it does not move: the
 * summary on an incognito row has to start exactly where the summary on an
 * ordinary row starts, or the mode has quietly reindented the rail. That is a
 * property of the RULE — jsdom lays nothing out — so it is asserted here rather
 * than in the component's suite, which cannot see geometry at all.
 */
describe('the incognito glyph', () => {
  const glyph = (): CSSStyleRule | undefined => ruleFor('.sh-task-card__incognito');

  it('takes back exactly the gutter it sits in', () => {
    expect(glyph()?.style.getPropertyValue('margin-inline-start')).toBe('calc(var(--sh-task-gutter) * -1)');
    expect(glyph()?.style.getPropertyValue('inline-size')).toBe('var(--sh-task-gutter)');
  });

  it('cancels the meta line’s gap as well, or the summary beside it shifts right', () => {
    /*
     * THE DEFECT THIS PINS, seen in the running app: giving the gutter back as a
     * negative start margin is only half of it. `.sh-task-card__meta` is a flex
     * line with `gap: --sh-space-md`, and that gap lands between this glyph and
     * the summary — so an incognito row's `idle` sat one `md` to the right of
     * every other row's, and the rail had two left edges.
     */
    expect(glyph()?.style.getPropertyValue('margin-inline-end')).toBe('calc(var(--sh-space-md) * -1)');
  });

  it('never grows the line it sits on', () => {
    // The meta line's contract is a fixed height and a fixed text edge. A glyph
    // that could stretch would make a task's height depend on its mode.
    // `none` as the sheet writes it, which is `0 0 auto` once parsed.
    expect(glyph()?.style.getPropertyValue('flex')).toBe('0 0 auto');
  });
});
