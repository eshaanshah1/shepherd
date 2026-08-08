import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { BRAILLE_FRAMES } from './spinner.ts';
import { StatusDot, statusWords, type StatusRole } from './status-dot.tsx';
import './styles.css';

const ROLES: StatusRole[] = ['working', 'attention', 'success', 'danger', 'idle'];

const dot = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-status-dot');
  if (!found) throw new Error('no status dot rendered');
  return found;
};

describe('StatusDot', () => {
  it('renders every role with its attribute', () => {
    for (const role of ROLES) {
      const dom = mount(<StatusDot role={role} />);
      expect(dot(dom.container).dataset.status, role).toBe(role);
    }
  });

  /**
   * The pairing. Two states will eventually share a hue — five states over four
   * accents already do — and a status encoded only in colour cannot be read out,
   * searched, or asserted on.
   */
  it('always carries its word as sr-only text and as a native title', () => {
    for (const role of ROLES) {
      const dom = mount(<StatusDot role={role} />);
      const el = dot(dom.container);
      expect(el.querySelector('.sh-ui-sr-only')?.textContent, role).toBe(statusWords[role]);
      expect(el.getAttribute('title'), role).toBe(statusWords[role]);
    }
  });

  it('lets a consumer say the reason instead of the bare word', () => {
    const dom = mount(<StatusDot role="attention" label="Blocked — plan approval" />);
    const el = dot(dom.container);
    expect(el.querySelector('.sh-ui-sr-only')?.textContent).toBe('Blocked — plan approval');
    expect(el.getAttribute('title')).toBe('Blocked — plan approval');
  });

  it('takes a role and never a colour', () => {
    // Enforced by the type, and pinned here so the intent survives a refactor:
    // the five words are the whole public vocabulary, and there is no `tint`,
    // no `color` and no palette name among them. The shipped `.sh-dot` accepts
    // `working`, `cobalt` AND `accent` as three spellings of one state, which is
    // what happens once a call site can name a colour.
    expect(Object.keys(statusWords).sort()).toEqual([...ROLES].sort());
    const painted = rulesMentioning('sh-ui-status-dot').filter(
      (rule) => rule.style.getPropertyValue('background') !== '',
    );
    for (const rule of painted) {
      expect(rule.style.getPropertyValue('background'), rule.selectorText).toMatch(/^var\(--sh-/);
    }
  });

  it('is a fixed box with the mark drawn inside it', () => {
    // The ELEMENT is the slot, so nothing around it moves when the mark changes;
    // it is also the box the sheep will occupy when rule 8's indicator lands.
    const rule = rulesMentioning('sh-ui-status-dot').find(
      (candidate) => candidate.selectorText === '.sh-ui-status-dot',
    );
    expect(rule?.style.width).toBe('var(--sh-font-size-medium)');
    expect(rule?.style.height).toBe('var(--sh-font-size-medium)');
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLSpanElement | null = null;
    const dom = mount(
      <StatusDot
        role="working"
        data-testid="agent-state"
        ref={(element) => {
          node = element;
        }}
      />,
    );
    expect(dot(dom.container).getAttribute('data-testid')).toBe('agent-state');
    expect(node).toBe(dot(dom.container));
  });

  it('shows the app’s working indicator instead of the mark while busy', () => {
    // Rule 7's braille sequence — the SAME one `Button`'s busy uses, in the same
    // fixed slot, so the app has one way of looking busy rather than two. Not a
    // pulse on the dot: rule 7 bans that in the same breath as it names this.
    const dom = mount(<StatusDot role="success" busy />);
    const spinner = dot(dom.container).querySelector('.sh-ui-status-dot__spinner');
    expect(spinner).not.toBeNull();
    expect(BRAILLE_FRAMES).toContain(spinner?.textContent);
    // Decorative: the word is the readable content, and a screen reader
    // announcing a braille cell would read the animation aloud.
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(dot(dom.container).dataset.busy).toBe('true');
  });

  it('keeps saying what the thing IS while it is busy', () => {
    // `busy` is orthogonal to `role`: a task being archived is still `success`,
    // and the row it sits in must not change colour for the duration.
    const dom = mount(<StatusDot role="success" busy />);
    expect(dot(dom.container).dataset.status).toBe('success');
  });
});
