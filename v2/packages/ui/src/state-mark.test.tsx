import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { keyframesNamed, rulesMentioning } from './css-rules.ts';
import { StateMark, markSlot, markWords, type MarkState } from './state-mark.tsx';
import { SUITE_METER_MAX_CELLS, SuiteMeter } from './suite-meter.tsx';
// Loaded for the `markSlot` case below, which asserts what the stylesheet does NOT
// declare — a claim there is no way to make through the markup.
import './styles.css';

const STATES: MarkState[] = ['working', 'waiting', 'ready', 'resting', 'failed', 'shipped'];

const mark = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-mark');
  if (!found) throw new Error('no mark rendered');
  return found;
};

describe('StateMark', () => {
  it('publishes its state as data, so one CSS rule per shape can find it', () => {
    for (const state of STATES) {
      const dom = mount(<StateMark state={state} />);
      expect(mark(dom.container).dataset['state'], state).toBe(state);
    }
  });

  it('ALWAYS carries its word, in the DOM and as a tooltip', () => {
    // The property the whole language rests on: a fact encoded only in colour
    // cannot be read out, searched, or asserted on — and two states will
    // eventually share a hue. This is what survives that.
    for (const state of STATES) {
      const dom = mount(<StateMark state={state} />);
      expect(mark(dom.container).getAttribute('title'), state).toBe(markWords[state]);
      expect(dom.container.querySelector('.sh-ui-sr-only')?.textContent, state).toBe(markWords[state]);
    }
  });

  it('takes a reason in place of the bare word', () => {
    const dom = mount(<StateMark state="waiting" label="Waiting on you — approve Bash" />);
    expect(mark(dom.container).getAttribute('title')).toBe('Waiting on you — approve Bash');
    expect(dom.container.querySelector('.sh-ui-sr-only')?.textContent).toBe('Waiting on you — approve Bash');
  });

  it('has no colour prop, and the mark is never given one', () => {
    // `StatusDot`'s `data-tint` accepted `working`, `cobalt` AND `accent` as
    // three spellings of one thing. Once a call site can name a colour, every
    // call site names it differently and no rename is possible.
    const dom = mount(<StateMark state="failed" />);
    const el = mark(dom.container);
    expect(el.getAttribute('style')).toBeNull();
    expect(el.className).toBe('sh-ui-mark');
  });

  it('gives the three bars three HEIGHTS, so the still reads as a meter', () => {
    /*
     * Equal bars are the shape of a loading spinner — "wait, something is
     * happening somewhere". A skyline is a meter, which is what this is.
     *
     * The animation used to carry that idea alone, and the file said so: "three
     * bars all pulsing is a loading spinner; three bars with one moving is a
     * thing that is working." The silhouette carries it too now, so the mark
     * still reads as working in a screenshot and under `prefers-reduced-motion`.
     */
    const bar = (n: number): CSSStyleRule | undefined =>
      rulesMentioning('sh-ui-mark__bars').find(
        (rule) => rule.selectorText === `.sh-ui-mark__bars > i:nth-child(${n})`,
      );
    /*
     * A FRACTION of the tallest, because what animates is a scale rather than a
     * size — 0.67 is 6 of 9, 0.56 is 5 of 9, so the silhouette is the same
     * 6 / 9 / 5 it has always been.
     */
    const rest = [1, 2, 3].map((n) => bar(n)?.style.getPropertyValue('--sh-bar-rest'));
    expect(rest).toEqual(['0.67', '1', '0.56']);
    expect(new Set(rest).size, 'three bars, three heights').toBe(3);

    /*
     * And CENTRED, not on a baseline. `flex-end` is what an audio meter does,
     * and at 12px it puts all three bars' mass along the lower edge — so the
     * mark read bottom-heavy beside the 8px square and the 7px ring, which are
     * centred in the same slot.
     */
    const bars = rulesMentioning('sh-ui-mark__bars').find(
      (rule) => rule.selectorText === '.sh-ui-mark__bars',
    );
    expect(bars?.style.alignItems).toBe('center');
  });

  it('switches the off beat to a TOKEN, never to an opacity', () => {
    /*
     * It faded to `opacity: 0.18`, while `markWorkingOff` sat unused with its job
     * written out — "the working meter's third bar on its off beat". The role was
     * right and the stylesheet had drifted off it.
     *
     * An opacity over a surface produces a colour in no palette, and a DIFFERENT
     * one in light mode where the same 0.18 lands against paper rather than
     * near-black. The Shipped region's dimming carries the same argument.
     */
    /*
     * Through `keyframesNamed`, which exists because of this assertion: the
     * walk behind `rulesMentioning` treats a `@keyframes` block as a grouping
     * rule and recurses into it, and the percentage rules inside carry `keyText`
     * rather than `selectorText` — so they match neither branch and are dropped.
     * The declaration that matters lived where nothing could see it.
     */
    const frames = keyframesNamed('sh-mark-working');
    expect(frames.length).toBeGreaterThan(0);
    const declared = frames.flatMap((frame) => [...frame.style]);
    expect(declared).not.toContain('opacity');
    expect(declared).toContain('background');
    expect(frames.map((frame) => frame.style.background)).toContain('var(--sh-mark-working-off)');

    // …and it has not merely moved into a rule beside them.
    const styled = rulesMentioning('sh-ui-mark').flatMap((rule) => [...rule.style]);
    expect(styled).not.toContain('opacity');
  });

  it('waves — all three animate, a third of a cycle apart', () => {
    /*
     * It was one bar blinking in place. A wave is the skyline TRAVELLING: every
     * bar takes its neighbour's height each step, so the shape moves rather than
     * one corner of it flickering.
     *
     * The delays are NEGATIVE, so every bar is mid-phase on the first frame. A
     * positive stagger would start the mark flat and fill it in over a second —
     * the one moment a reader is most likely to be looking at it, spent watching
     * it assemble.
     */
    const animated = rulesMentioning('sh-ui-mark__bars').filter(
      (rule) => rule.style.animation !== '' || rule.style.animationDelay !== '',
    );
    const every = animated.find((rule) => rule.selectorText === '.sh-ui-mark__bars > i');
    expect(every?.style.animation, 'every bar animates, not just one').toContain('sh-mark-working');
    /*
     * EASED, not stepped. Stepping is what made the motion jitter, and it was
     * there to pay for animating `block-size` — a layout property. Scaling on the
     * compositor answers the cost instead, so the timing function is free to be
     * a curve. The two fixes are the same fix, not a trade.
     */
    expect(every?.style.animation).toContain('ease-in-out');
    expect(every?.style.animation).not.toContain('steps');
    expect(every?.style.animation, 'no layout property in the cycle').not.toContain('block-size');

    /*
     * **Right to left**, so the delays run 3 → 2 → 1. The direction matters at
     * this size: the mark sits at the LEFT edge of a row with the title to its
     * right, so a wave moving away from the text carries the eye off the row it
     * is meant to introduce. This one hands off.
     */
    const delays = [1, 2, 3].map(
      (n) =>
        rulesMentioning('sh-ui-mark__bars').find(
          (rule) => rule.selectorText === `.sh-ui-mark__bars > i:nth-child(${n})`,
        )?.style.animationDelay,
    );
    expect(delays).toEqual(['-0.7s', '-0.35s', '0s']);
  });

  it('leaves the skyline COMPLETE under reduced motion, not frozen mid-wave', () => {
    /*
     * A frozen partial mark reads as broken — the app looks like it stopped
     * mid-repaint. `animation: none` alone gets there because the heights and the
     * lit colour are declared on the elements as well as in the frames: the
     * static silhouette is not a leftover, it is the reduced-motion rendering.
     */
    const stopped = rulesMentioning('sh-ui-mark__bars').filter(
      (rule) => rule.style.animation === 'none',
    );
    /*
     * TWO rules stop it now, and they stop it the same way on purpose.
     *
     * The second is the `quiet-craft` skin, which refuses looping animation
     * outright — so the meter it draws has to be the complete silhouette rather
     * than a paused frame, which is the identical requirement this case was
     * written for. If either ever grows a `transform` or a `background` of its
     * own it has stopped reusing the resting rendering and started inventing a
     * second static form, which is what these selectors pin.
     */
    const selectors = stopped.map((rule) => rule.selectorText).sort();
    expect(selectors).toEqual([
      ".sh-ui-mark__bars > i",
      ":root[data-skin='quiet-craft'] .sh-ui-mark__bars > i",
    ]);
    for (const rule of stopped) {
      // Every bar, not the one that used to be the only animated one.
      expect(rule.selectorText).not.toContain('last-child');
      // Nothing but the animation is touched: the silhouette IS the resting state.
      expect(rule.style.transform, rule.selectorText).toBe('');
      expect(rule.style.background, rule.selectorText).toBe('');
    }
  });

  it('draws three bars for working, and NOTHING else does', () => {
    // Only the third bar animates, which is why they are three real elements
    // rather than one pseudo-element: a pseudo cannot be addressed on its own.
    const working = mount(<StateMark state="working" />);
    expect(working.container.querySelectorAll('.sh-ui-mark__bars > i')).toHaveLength(3);
    for (const state of STATES.filter((s) => s !== 'working')) {
      const dom = mount(<StateMark state={state} />);
      expect(dom.container.querySelector('.sh-ui-mark__bars'), state).toBeNull();
    }
  });

  it('hides the drawn mark from a screen reader and exposes only the word', () => {
    // A screen reader announcing three empty <i> elements reads the animation
    // aloud. The word below them is the readable content.
    const dom = mount(<StateMark state="working" />);
    expect(dom.container.querySelector('.sh-ui-mark__bars')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a caller class alongside its own', () => {
    const dom = mount(<StateMark state="resting" className="sh-row-glyph" />);
    expect(mark(dom.container).className).toContain('sh-ui-mark');
    expect(mark(dom.container).className).toContain('sh-row-glyph');
  });

  it('draws nothing at all without a state, so `markSlot` is an empty box', () => {
    /*
     * The escape hatch for a row whose state its REGION already declares — a
     * shipped task under a heading reading `Shipped`, where eight identical checks
     * spend the slot on nothing. It works because every shape in the stylesheet
     * hangs off `[data-state]`, and the test is here so that stays true: a shape
     * moved onto the bare `.sh-ui-mark` rule would put a mark back on every one of
     * those rows.
     */
    expect(markSlot).toBe('sh-ui-mark');
    const bare = rulesMentioning('sh-ui-mark').find((rule) => rule.selectorText === '.sh-ui-mark');
    for (const property of ['background', 'border', 'content', 'transform']) {
      expect(bare?.style.getPropertyValue(property), `.sh-ui-mark declares ${property}`).toBe('');
    }
    /*
     * …and it is still the fixed box, which is the whole reason to reuse it: a
     * label's x position must not depend on whether its row has a status.
     *
     * A TOKEN, not `12px`. The number was written out here and in `state-mark
     * .css`, and then a third time in `task-card.css` so a second line could
     * align under the title rather than under the mark — at which point one of
     * the three was going to go stale without anything failing.
     */
    expect(bare?.style.getPropertyValue('inline-size')).toBe('var(--sh-mark-slot)');
    expect(bare?.style.getPropertyValue('block-size')).toBe('var(--sh-mark-slot)');
  });
});

describe('SuiteMeter', () => {
  const cells = (container: HTMLElement): HTMLElement[] =>
    [...container.querySelectorAll<HTMLElement>('.sh-ui-suite__cells > i')];
  const passed = (container: HTMLElement): number =>
    cells(container).filter((cell) => cell.dataset['passed'] === 'true').length;

  it('draws one cell per test and fills the ones that passed', () => {
    const dom = mount(<SuiteMeter total={4} passed={3} />);
    expect(cells(dom.container)).toHaveLength(4);
    expect(passed(dom.container)).toBe(3);
  });

  it('renders NOTHING for a suite that does not exist', () => {
    // Not an empty span: that would leave its gap and margin in the layout, and a
    // card with a mysterious blank at the end of its diff line is worse than one
    // with no meter.
    for (const total of [0, -1, Number.NaN]) {
      expect(mount(<SuiteMeter total={total} passed={0} />).container.innerHTML).toBe('');
    }
  });

  it('carries the exact count as its word, however many cells it drew', () => {
    const dom = mount(<SuiteMeter total={4} passed={3} />);
    expect(dom.container.querySelector('.sh-ui-suite')?.getAttribute('title')).toBe('3 of 4 passed');
    expect(dom.container.querySelector('.sh-ui-sr-only')?.textContent).toBe('3 of 4 passed');
  });

  it('caps the cells and goes proportional, keeping the numbers in the word', () => {
    // Past the cap the SHAPE still answers "how much of it passed" and nothing on
    // screen claims to be a count. 400 cells would be a scrollbar.
    const dom = mount(<SuiteMeter total={400} passed={200} />);
    expect(cells(dom.container)).toHaveLength(SUITE_METER_MAX_CELLS);
    expect(passed(dom.container)).toBe(SUITE_METER_MAX_CELLS / 2);
    expect(dom.container.querySelector('.sh-ui-suite')?.getAttribute('title')).toBe('200 of 400 passed');
  });

  it('never renders an all-green suite one cell short of full', () => {
    // The one reading that would be actively wrong — hence `round`, not `floor`.
    for (const total of [40, 97, 400, 1000]) {
      const dom = mount(<SuiteMeter total={total} passed={total} />);
      expect(passed(dom.container), `${total}`).toBe(cells(dom.container).length);
    }
  });

  it('never renders a zero-pass suite with a filled cell', () => {
    for (const total of [40, 97, 400]) {
      expect(passed(mount(<SuiteMeter total={total} passed={0} />).container), `${total}`).toBe(0);
    }
  });

  it('clamps a count that makes no sense rather than drawing it', () => {
    expect(passed(mount(<SuiteMeter total={4} passed={9} />).container)).toBe(4);
    expect(passed(mount(<SuiteMeter total={4} passed={-3} />).container)).toBe(0);
  });

  it('draws no failure — that is the task’s mark, not a red cell', () => {
    // The same fact in two places with two shapes is how a reader learns to
    // distrust both.
    const dom = mount(<SuiteMeter total={4} passed={1} />);
    const values = cells(dom.container).map((cell) => cell.dataset['passed']);
    expect(new Set(values)).toEqual(new Set(['true', undefined]));
  });
});
