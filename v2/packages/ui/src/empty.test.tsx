import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Empty } from './empty.tsx';
import { KeyCap } from './keycap.tsx';
import './styles.css';

const empty = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-empty');
  if (!found) throw new Error('nothing rendered');
  return found;
};

describe('Empty', () => {
  it('renders the sentence, the illustration and the hint', () => {
    const dom = mount(
      <Empty
        illustration={<svg data-testid="ewe" />}
        hint={
          <>
            <KeyCap>⌘T</KeyCap> COMPOSE A TASK
          </>
        }
      >
        The flock is quiet.
      </Empty>,
    );
    const el = empty(dom.container);
    expect(el.querySelector('.sh-ui-empty__say')?.textContent).toBe('The flock is quiet.');
    expect(el.querySelector('.sh-ui-empty__art [data-testid="ewe"]')).not.toBeNull();
    expect(el.querySelector('.sh-ui-empty__hint .sh-ui-keycap')?.textContent).toBe('⌘T');
    dom.unmount();
  });

  it('draws no illustration box and no hint when neither is given', () => {
    // A slot rendered empty here would be vertical space announcing an absence,
    // which is the opposite of `Row`'s fixed-slot rule — nothing lines up
    // against anything in a centred column of one.
    const dom = mount(<Empty>Nothing here.</Empty>);
    const el = empty(dom.container);
    expect(el.querySelector('.sh-ui-empty__art')).toBeNull();
    expect(el.querySelector('.sh-ui-empty__hint')).toBeNull();
    expect(el.querySelector('.sh-ui-empty__say')).not.toBeNull();
    dom.unmount();
  });

  it('hides the illustration from assistive technology', () => {
    // It is decoration for a sentence that already says the thing. Announced, it
    // is a second, wordless copy of the same message.
    const dom = mount(<Empty illustration={<svg />}>Nothing here.</Empty>);
    expect(empty(dom.container).querySelector('.sh-ui-empty__art')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    dom.unmount();
  });

  /**
   * MUTATION TARGET #2. Changing the sentence's family to sans — the obvious
   * "tidy-up", since every other primitive in this package is sans — must fail
   * here by name. Rule 6 is that serif appears exactly where the app speaks in
   * sentences, and this is the clearest instance of that in the product.
   */
  it('sets the sentence in SANS — the language has two faces, split by job', () => {
    // Flock kept a third face for "where the app speaks in sentences". §2 has
    // two: what the app SAYS is sans, what the machine produced is mono. An
    // empty state is the app talking, so it carries by size and weight rather
    // than by changing voice — a different typeface claims "this is a different
    // kind of thing", and it is not.
    const say = rulesMentioning('sh-ui-empty__say')[0];
    expect(say?.style.fontFamily).toBe('var(--sh-font-sans)');
    expect(say?.style.getPropertyValue('font-weight')).toBe('500');

    // And the hint is a LEGEND, not a second sentence — a step smaller and a
    // step darker. It was uppercase micro type at tracking, which §6 refuses;
    // a legend that shouts under a quiet sentence is what that refusal is about.
    const hint = rulesMentioning('sh-ui-empty__hint')[0];
    expect(hint?.style.fontFamily).toBe('var(--sh-font-sans)');
    expect(hint?.style.getPropertyValue('text-transform')).toBe('none');
    expect(hint?.style.getPropertyValue('letter-spacing')).toBe('0px');
  });

  it('carries the ONE way out of the emptiness, apart from the legend', () => {
    // §7: if you added a way in, add the way out and the way to see it. On an
    // empty stage the way in IS the way out — and Flock's version had only a
    // pressable keycap, which teaches a shortcut instead of offering a control.
    const dom = mount(
      <Empty action={<button type="button">New task</button>} hint="Press ⌘T">
        The flock is quiet.
      </Empty>,
    );
    expect(dom.container.querySelector('.sh-ui-empty__act button')?.textContent).toBe('New task');
    expect(dom.container.querySelector('.sh-ui-empty__hint')?.textContent).toBe('Press ⌘T');
  });

  it('paints no surface of its own', () => {
    // An empty state is a hole. A card drawn in the hole is a box announcing
    // that there is no content, which is louder than the content would be.
    const root = rulesMentioning('sh-ui-empty').find((rule) => rule.selectorText === '.sh-ui-empty');
    expect(root?.style.background).toBe('transparent');
    expect(root?.style.border).toBe('');
  });

  it('takes every value from a role or a metric', () => {
    for (const rule of rulesMentioning('sh-ui-empty')) {
      expect(rule.cssText, rule.selectorText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(rule.cssText, rule.selectorText).not.toMatch(/\brgba?\(/i);
      expect(rule.cssText, rule.selectorText).not.toMatch(/[^-\w(]\d*[1-9]\d*px/);
    }
  });

  it('spreads unanticipated props onto the root and forwards a ref', () => {
    let node: HTMLDivElement | null = null;
    const dom = mount(
      <Empty
        data-testid="empty-state"
        ref={(element) => {
          node = element;
        }}
      >
        Nothing here.
      </Empty>,
    );
    const el = empty(dom.container);
    expect(el.getAttribute('data-testid')).toBe('empty-state');
    expect(node).toBe(el);
    dom.unmount();
  });
});
