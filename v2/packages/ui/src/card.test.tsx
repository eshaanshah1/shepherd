import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Card } from './card.tsx';
import { SectionLabel } from './section-label.tsx';
import './styles.css';

const card = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-card');
  if (!found) throw new Error('no card rendered');
  return found;
};

describe('Card', () => {
  it('renders its children in a body', () => {
    const dom = mount(<Card>contributed view</Card>);
    expect(card(dom.container).querySelector('.sh-ui-card__body')?.textContent).toBe(
      'contributed view',
    );
  });

  it('renders a header only when it is given one', () => {
    // The one place a conditional child is right: the alternative is an empty
    // bordered strip at the top of every card that has nothing to say.
    const bare = mount(<Card>body</Card>);
    expect(bare.container.querySelector('.sh-ui-card__header')).toBeNull();

    const headed = mount(<Card header={<SectionLabel count={2}>Needs you</SectionLabel>}>body</Card>);
    const header = headed.container.querySelector('.sh-ui-card__header');
    expect(header?.querySelector('.sh-ui-section-label')).not.toBeNull();
  });

  it('takes a header SLOT rather than a title string', () => {
    // What heads a docked view is frequently a label, a count and a control. A
    // `title: string` would need a second prop for each, and the fourth caller
    // would render its own header and stop using this one.
    const dom = mount(
      <Card
        header={
          <>
            <SectionLabel>Tasks</SectionLabel>
            <button type="button">+</button>
          </>
        }
      >
        body
      </Card>,
    );
    const header = dom.container.querySelector('.sh-ui-card__header');
    expect(header?.querySelector('button')).not.toBeNull();
  });

  it('is a real border, and the header rule is an inset band', () => {
    // A card has four edges and nothing to align with, so a border is right. A
    // BAND draws one edge over content that must line up with things outside it,
    // so it uses an inset shadow — a border there would eat a pixel of the
    // content box and drop everything in it half a pixel out of centre.
    const box = rulesMentioning('sh-ui-card').find(
      (rule) => rule.selectorText === '.sh-ui-card',
    );
    expect(box?.style.getPropertyValue('border')).toContain('var(--sh-line)');
    expect(box?.style.getPropertyValue('border-radius')).toBe('var(--sh-radius-md)');

    const header = rulesMentioning('sh-ui-card__header')[0];
    expect(header?.style.getPropertyValue('box-shadow')).toContain('inset');
    expect(header?.style.getPropertyValue('border-bottom')).toBe('');
  });

  it('gives the body no padding, so a list of Rows stays full-bleed', () => {
    const body = rulesMentioning('sh-ui-card__body')[0];
    expect(body?.style.getPropertyValue('padding')).toBe('');
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLElement | null = null;
    const dom = mount(
      <Card
        data-testid="diagnostics"
        ref={(element) => {
          node = element;
        }}
      >
        body
      </Card>,
    );
    expect(card(dom.container).getAttribute('data-testid')).toBe('diagnostics');
    expect(node).toBe(card(dom.container));
  });
});
