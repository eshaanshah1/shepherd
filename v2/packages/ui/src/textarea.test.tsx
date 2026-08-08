import { describe, expect, it } from 'vitest';
import { lines, metrics } from '@shepherd/design-tokens';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { TextArea } from './textarea.tsx';
import type { FieldSize, FieldVariant } from './field.tsx';
import './styles.css';

const VARIANTS: FieldVariant[] = ['bordered', 'bare'];
const SIZES: FieldSize[] = ['sm', 'md'];

const control = (container: HTMLElement): HTMLTextAreaElement => {
  const found = container.querySelector<HTMLTextAreaElement>('.sh-ui-textarea');
  if (!found) throw new Error('no textarea rendered');
  return found;
};

describe('TextArea', () => {
  it('renders every variant with its class', () => {
    for (const variant of VARIANTS) {
      const dom = mount(<TextArea variant={variant} />);
      expect(control(dom.container).className, variant).toContain(
        `sh-ui-field__control--${variant}`,
      );
    }
  });

  it('renders every size with its class', () => {
    for (const size of SIZES) {
      const dom = mount(<TextArea size={size} />);
      expect(control(dom.container).className, size).toContain(`sh-ui-field__control--${size}`);
    }
  });

  it('shares the field-s control classes rather than restating them', () => {
    // A textarea IS a field with more lines. The shipped shell's two input
    // treatments disagree about padding, radius, background, focus and
    // placeholder colour — five decisions somebody made twice.
    const dom = mount(<TextArea />);
    expect(control(dom.container).className).toContain('sh-ui-field__control');
    expect(control(dom.container).className).toContain('sh-ui-textarea');
  });

  it('measures autoGrow in LINES, never in px', () => {
    // Synara's trick, and the reason `lines()` exists: "two lines" is a real
    // height that survives the type scale moving. The shipped composer's `72px`
    // is a guess that was right exactly once — and against its own 24px line box
    // it is already three lines rather than the two its comment claims.
    const dom = mount(<TextArea autoGrow minLines={2} maxLines={8} />);
    const el = control(dom.container);
    expect(el.dataset.autoGrow).toBe('true');
    expect(el.style.getPropertyValue('--sh-ui-textarea-min')).toBe(lines(2));
    expect(el.style.getPropertyValue('--sh-ui-textarea-max')).toBe(lines(8));
    expect(lines(2)).toBe('calc(2 * var(--sh-line-height))');
    // It is a real height at the shipped scale, and it is not 72.
    expect(2 * metrics.lineHeight).not.toBe(72);
  });

  it('does not grow unless asked', () => {
    const dom = mount(<TextArea />);
    expect(control(dom.container).dataset.autoGrow).toBeUndefined();
  });

  it('never draws a resize grabber', () => {
    // It draws diagonal hairlines in the corner of a field that is otherwise
    // borderless — so on the `bare` variant the one visible mark on a writing
    // surface becomes a drag handle.
    const rule = rulesMentioning('sh-ui-textarea').find(
      (candidate) => candidate.selectorText === '.sh-ui-textarea',
    );
    expect(rule?.style.resize).toBe('none');
  });

  it('carries the invalid treatment and the message slot Field has', () => {
    const dom = mount(<TextArea invalid message="Say what this work is." />);
    const el = control(dom.container);
    expect(el.closest('.sh-ui-field')?.getAttribute('data-invalid')).toBe('true');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.getAttribute('aria-describedby')).toBe(
      dom.container.querySelector('.sh-ui-field__message')?.id,
    );
  });

  it('lets a caller style override the bounds it set', () => {
    // `style` is spread AFTER the bounds, so a caller's inline height wins — the
    // component supplies a default, not a lock.
    const dom = mount(<TextArea autoGrow style={{ maxHeight: '10px' }} />);
    expect(control(dom.container).style.maxHeight).toBe('10px');
  });

  it('spreads unanticipated props onto the control and forwards a ref', () => {
    let node: HTMLTextAreaElement | null = null;
    const dom = mount(
      <TextArea
        data-testid="brief"
        ref={(element) => {
          node = element;
        }}
      />,
    );
    expect(control(dom.container).getAttribute('data-testid')).toBe('brief');
    expect(node).toBe(control(dom.container));
  });
});
