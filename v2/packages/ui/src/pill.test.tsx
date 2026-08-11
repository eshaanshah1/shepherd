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

  it('has no box — no hairline, no fill, no padding to hold one out', () => {
    // A hairline, a tint and an accent label at once is four signals on a token
    // whose whole job is to sit inside a sentence, and together they made a run
    // of prose look like it had a form control dropped into it.
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.style.border, rule.selectorText).toBe('');
      expect(rule.style.borderRadius, rule.selectorText).toBe('');
      expect(rule.style.background, rule.selectorText).toBe('');
      expect(rule.style.backgroundColor, rule.selectorText).toBe('');
    }
    // Serialized, so `0` comes back as `0px`.
    expect(base().style.padding).toBe('0px');
  });

  it('reads as prose — the sentence’s ink and the sentence’s size', () => {
    expect(base().style.color).toBe('var(--sh-text)');
    // Not the `small` step. A token a size down from its sentence reads as a
    // chip parked in the text rather than as a word of it.
    expect(base().style.fontSize).toBe('inherit');
  });

  it('puts the one signal on the glyph, in the ROLE', () => {
    // Named rather than hued: an extension that re-declares `--sh-accent` gets
    // its own pill for free, and cobalt stays a fact about the token layer.
    const glyph = rulesMentioning('sh-ui-pill').find(
      (candidate) => candidate.selectorText === '.sh-ui-pill .sh-icon',
    );
    expect(glyph?.style.color).toBe('var(--sh-accent)');
  });

  it('gives the label the accent back when there is no glyph to carry it', () => {
    // The icon is optional in the type, and without this a pill with no icon is
    // literally indistinguishable from the text around it.
    const fallback = rulesMentioning('sh-ui-pill').find((candidate) =>
      candidate.selectorText.includes(':not(:has(.sh-icon))'),
    );
    expect(fallback?.style.color).toBe('var(--sh-accent)');
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
