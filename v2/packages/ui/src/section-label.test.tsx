import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { SectionLabel } from './section-label.tsx';
import './styles.css';

const label = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-section-label');
  if (!found) throw new Error('no section label rendered');
  return found;
};

describe('SectionLabel', () => {
  it('renders its text', () => {
    const dom = mount(<SectionLabel>Needs you</SectionLabel>);
    expect(label(dom.container).querySelector('.sh-ui-section-label__text')?.textContent).toBe(
      'Needs you',
    );
  });

  it('renders a count when given one, including zero', () => {
    const two = mount(<SectionLabel count={2}>Needs you</SectionLabel>);
    expect(two.container.querySelector('.sh-ui-section-label__count')?.textContent).toBe('2');

    const none = mount(<SectionLabel count={0}>Needs you</SectionLabel>);
    expect(none.container.querySelector('.sh-ui-section-label__count')?.textContent).toBe('0');

    const absent = mount(<SectionLabel>Needs you</SectionLabel>);
    expect(absent.container.querySelector('.sh-ui-section-label__count')).toBeNull();
  });

  it('takes a count a contribution wrote, not only a number', () => {
    // The shell port's finding. A sidebar heading is a contributed row, and what
    // a contribution supplies is `TreeItem.description` — a string it chose.
    // Typed `number`, the shell would have to parse an extension's text to hand
    // it over, and the first unparseable one reaches the screen as `NaN`.
    const dom = mount(<SectionLabel count="3 archived">Shelved</SectionLabel>);
    expect(dom.container.querySelector('.sh-ui-section-label__count')?.textContent).toBe(
      '3 archived',
    );
  });

  it('puts the count past the RULE, so a column of headings aligns its numbers', () => {
    // The `· ` separator this used to draw is gone with the layout: the count now
    // sits at the far end past a full-width rule, which is what lets the eye run
    // down a column of headings and read the numbers as a column.
    const count = rulesMentioning('sh-ui-section-label__count').find(
      (candidate) => candidate.selectorText === '.sh-ui-section-label__count',
    );
    const rule = rulesMentioning('sh-ui-section-label').find((candidate) =>
      candidate.selectorText.includes('::after'),
    );
    // `order` rather than markup order, because the rule is a pseudo-element and
    // is therefore always last in the box.
    expect(rule?.style.getPropertyValue('order')).toBe('1');
    expect(count?.style.getPropertyValue('order')).toBe('2');
    // Tabular, or the headings shuffle as work moves between sections.
    expect(count?.style.getPropertyValue('font-variant-numeric')).toBe('tabular-nums');
  });

  it('is SENTENCE case with no tracking — §6 refuses the alternative', () => {
    // Flock read this as an instrument voice: uppercase micro type at wide
    // tracking. §6 lists "uppercase micro-labels with tracking" among what this
    // language refuses, and the argument is that a section heading is the one
    // string on the surface a reader SCANS rather than reads — uppercase costs
    // word shape, which is the thing scanning uses. Weight carries it instead.
    const rule = rulesMentioning('sh-ui-section-label').find(
      (candidate) => candidate.selectorText === '.sh-ui-section-label',
    );
    expect(rule?.style.getPropertyValue('text-transform')).toBe('none');
    expect(rule?.style.getPropertyValue('letter-spacing')).toBe('0px');
    expect(rule?.style.getPropertyValue('font-weight')).toBe('600');
    expect(rule?.style.getPropertyValue('font-size')).toBe('var(--sh-font-size-small)');
    // A control's height, not a row's: the row grew to 34 with the task card, and
    // a heading that grew with it would put more space above each group than
    // between the cards inside it.
    expect(rule?.style.getPropertyValue('height')).toBe('var(--sh-control-md)');
  });

  it('carries a trailing rule by default and can be told not to', () => {
    const ruled = mount(<SectionLabel>Tasks</SectionLabel>);
    expect(label(ruled.container).dataset.rule).toBe('true');

    const plain = mount(<SectionLabel rule={false}>Tasks</SectionLabel>);
    expect(label(plain.container).dataset.rule).toBe('false');
  });

  it('draws a nested heading one step down the ramp and NOTHING else differently', () => {
    /*
     * A day label inside `Shipped` is the same KIND of thing at a smaller scope, so
     * it is the same component at the same height and weight — one step quieter, and
     * the rule dropped by the caller. A nested heading that changed size or weight
     * would be a second component impersonating this one, and the hierarchy would
     * then be carried by two facts that can disagree.
     */
    const nested = rulesMentioning('sh-ui-section-label').find(
      (candidate) => candidate.selectorText === '.sh-ui-section-label[data-nested]',
    );
    expect(nested?.style.color).toBe('var(--sh-text-ghost)');
    for (const property of ['height', 'font-size', 'font-weight', 'text-transform', 'letter-spacing', 'padding']) {
      expect(nested?.style.getPropertyValue(property), `nested declares ${property}`).toBe('');
    }
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLDivElement | null = null;
    const dom = mount(
      <SectionLabel
        data-testid="group"
        ref={(element) => {
          node = element;
        }}
      >
        Tasks
      </SectionLabel>,
    );
    expect(label(dom.container).getAttribute('data-testid')).toBe('group');
    expect(node).toBe(label(dom.container));
  });
});
