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

  it('draws the separator rather than making the caller type it', () => {
    // The caller supplies two values; the stylesheet supplies the `·`. A heading
    // with no count then has no orphaned dot, and nobody has to remember which
    // side it goes on.
    const rule = rulesMentioning('sh-ui-section-label__count').find((candidate) =>
      candidate.selectorText.includes('::before'),
    );
    expect(rule).toBeDefined();
    expect(rule?.style.content).toBe('"· "');
  });

  it('is the instrument voice: uppercase micro type with the WIDE tracking', () => {
    // Rule 5 survived the reference comparison deliberately — both reference apps
    // went sentence-case for their headings and both are duller for it.
    const rule = rulesMentioning('sh-ui-section-label').find(
      (candidate) => candidate.selectorText === '.sh-ui-section-label',
    );
    expect(rule?.style.getPropertyValue('text-transform')).toBe('uppercase');
    expect(rule?.style.getPropertyValue('font-size')).toBe('var(--sh-micro-font-size)');
    expect(rule?.style.getPropertyValue('letter-spacing')).toBe('var(--sh-micro-tracking-wide)');
    expect(rule?.style.getPropertyValue('height')).toBe('var(--sh-row-height)');
  });

  it('carries a trailing rule by default and can be told not to', () => {
    const ruled = mount(<SectionLabel>Tasks</SectionLabel>);
    expect(label(ruled.container).dataset.rule).toBe('true');

    const plain = mount(<SectionLabel rule={false}>Tasks</SectionLabel>);
    expect(label(plain.container).dataset.rule).toBe('false');
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
