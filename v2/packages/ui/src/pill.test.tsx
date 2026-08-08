import { IconPhoto } from '@tabler/icons-react';
import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Pill } from './pill.tsx';
import './styles.css';

const pill = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-pill');
  if (!found) throw new Error('no pill rendered');
  return found;
};

const base = (): CSSStyleRule => {
  const rule = rulesMentioning('sh-ui-pill').find((candidate) => candidate.selectorText === '.sh-ui-pill');
  if (!rule) throw new Error('no .sh-ui-pill rule');
  return rule;
};

describe('Pill', () => {
  it('renders its label, with the icon decorative beside it', () => {
    const dom = mount(<Pill icon={IconPhoto}>Image</Pill>);
    expect(pill(dom.container).textContent).toBe('Image');
    const glyph = pill(dom.container).querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is a label on its own when handed no icon', () => {
    const dom = mount(<Pill>Image</Pill>);
    expect(pill(dom.container).querySelector('svg')).toBeNull();
    expect(pill(dom.container).textContent).toBe('Image');
  });

  /**
   * The invariant the component exists for. An inline-flex box contributes its
   * whole MARGIN box to the line, so a pill taller than the line box — or one
   * with a vertical margin — opens every line that contains one.
   */
  it('cannot open the line box it sits in', () => {
    expect(base().style.display).toBe('inline-flex');
    expect(base().style.verticalAlign).toBe('middle');
    expect(base().style.height).toBe('var(--sh-ui-pill-height)');
    expect(base().style.getPropertyValue('--sh-ui-pill-height')).toContain('var(--sh-line-height)');
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.style.margin, rule.selectorText).toBe('');
      expect(rule.style.marginTop, rule.selectorText).toBe('');
      expect(rule.style.marginBottom, rule.selectorText).toBe('');
    }
  });

  it('is a rounded rectangle, not a capsule', () => {
    // Half its height was the first version and it read as an oval, which is
    // not the reference: soft corners on a rectangular box. It is a step on the
    // radius scale like everything else in the kit.
    expect(base().style.borderRadius).toBe('var(--sh-radius-md)');
  });

  it('draws in accent — hairline, label and the tint under them', () => {
    // The ROLE, never the hue: an extension that re-declares `--sh-accent` gets
    // its own pill for free, and cobalt stays a fact about the token layer.
    expect(base().style.color).toBe('var(--sh-accent)');
    expect(base().style.border).toBe('var(--sh-hairline) solid var(--sh-accent)');
    // A tint of the same accent rather than a solid block — on a tint the role
    // colour carries the signal, which is what makes the label legible on it.
    expect(base().style.background).toContain('var(--sh-accent)');
    expect(base().style.background).toContain('transparent');
  });

  it('paints in roles only', () => {
    for (const rule of rulesMentioning('sh-ui-pill')) {
      for (const property of ['background', 'color', 'border']) {
        const value = rule.style.getPropertyValue(property);
        if (value !== '') expect(value, `${rule.selectorText} ${property}`).toContain('var(--sh-');
      }
    }
  });

  it('is display only — no pointer, and no click to type', () => {
    // KeyCap's rule: a pressable thing in a run of text is a link, and a link
    // that looks like a control teaches the wrong gesture.
    expect(base().style.cursor).toBe('default');
    expect(base().style.userSelect).toBe('none');
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLSpanElement | null = null;
    const dom = mount(
      <Pill
        data-testid="attachment"
        ref={(element) => {
          node = element;
        }}
      >
        Image
      </Pill>,
    );
    expect(pill(dom.container).getAttribute('data-testid')).toBe('attachment');
    expect(node).toBe(pill(dom.container));
  });
});
