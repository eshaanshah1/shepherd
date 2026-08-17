import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
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
    // …and it is still the fixed 12px box, which is the whole reason to reuse it:
    // the label's x position must not depend on whether its row has a status.
    expect(bare?.style.getPropertyValue('inline-size')).toBe('12px');
    expect(bare?.style.getPropertyValue('block-size')).toBe('12px');
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
