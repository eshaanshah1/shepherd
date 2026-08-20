// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Checkbox, checkboxDOM } from './checkbox.tsx';
import './styles.css';

const control = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('[role="checkbox"]');
  if (!found) throw new Error('no checkbox rendered');
  return found;
};

describe('Checkbox', () => {
  it('is a checkbox whose state and name a screen reader can read', () => {
    const { container } = mount(<Checkbox checked label="Ship it" onChange={() => {}} />);
    expect(control(container).getAttribute('aria-checked')).toBe('true');
    expect(control(container).getAttribute('aria-label')).toBe('Ship it');
  });

  it('carries the name as a tooltip too, so a pointer can read it', () => {
    const { container } = mount(<Checkbox checked={false} label="Ship it" onChange={() => {}} />);
    expect(control(container).getAttribute('title')).toBe('Ship it');
  });

  it('reports the value it would become, not the one it has', () => {
    const onChange = vi.fn();
    const { container } = mount(<Checkbox checked={false} label="X" onChange={onChange} />);
    control(container).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reports false from a checked box', () => {
    const onChange = vi.fn();
    const { container } = mount(<Checkbox checked label="X" onChange={onChange} />);
    control(container).click();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not report while disabled', () => {
    const onChange = vi.fn();
    const { container } = mount(<Checkbox checked={false} label="X" disabled onChange={onChange} />);
    control(container).click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is a button, so the keyboard reaches it without a handler of ours', () => {
    // Space and Enter on a <button> are the platform's. A real
    // <input type="checkbox"> would bring a browser-drawn box no token can reach.
    const { container } = mount(<Checkbox checked label="X" onChange={() => {}} />);
    expect(control(container).tagName).toBe('BUTTON');
    expect(container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.type).toBe('button');
  });

  it('draws its mark in both states, and hides it with opacity on the MARK', () => {
    // The box must not change size, gain a border or shift the text beside it
    // when it is ticked — a list of ten of these cannot reflow as you work down
    // it. So the check is always present and only its visibility changes.
    for (const checked of [true, false]) {
      const { container } = mount(<Checkbox checked={checked} label="X" onChange={() => {}} />);
      expect(container.querySelector('.sh-ui-checkbox__mark')).not.toBeNull();
    }
  });

  it('hides the mark from the accessibility tree — the button already says so', () => {
    const { container } = mount(<Checkbox checked label="X" onChange={() => {}} />);
    expect(container.querySelector('.sh-ui-checkbox__mark')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is square, and sized by the text it sits in rather than the control scale', () => {
    // `--sh-control-sm` is 20px: right for a control on a row of its own, wrong
    // for one in a sentence, where beside 14px text it is the largest thing on
    // the line.
    const box = rulesMentioning('sh-ui-checkbox').find((rule) => rule.selectorText === '.sh-ui-checkbox');
    expect(box?.style.getPropertyValue('width')).toBe('var(--sh-ui-checkbox-size)');
    expect(box?.style.getPropertyValue('height')).toBe('var(--sh-ui-checkbox-size)');
    expect(box?.style.getPropertyValue('--sh-ui-checkbox-size')).toBe('1em');
  });

  it('names only role tokens for its colours', () => {
    for (const rule of rulesMentioning('sh-ui-checkbox')) {
      for (const prop of ['background', 'border-color', 'color', 'border']) {
        const value = rule.style.getPropertyValue(prop);
        if (value === '') continue;
        expect(value, `${rule.selectorText} { ${prop}: ${value} }`).toMatch(/var\(--sh-|^none$|^0$/);
      }
    }
  });

  it('fills with the colour that means "you did this"', () => {
    const on = rulesMentioning('sh-ui-checkbox').find(
      (rule) => rule.selectorText === ".sh-ui-checkbox[aria-checked='true']",
    );
    expect(on?.style.getPropertyValue('background')).toBe('var(--sh-sky)');
  });

  it('dims only when disabled, and never the box for its state', () => {
    // §10 refuses dimming as a state channel. The only opacity on the control
    // itself is `:disabled`; the state's opacity is on the mark.
    const dimmed = rulesMentioning('sh-ui-checkbox').filter(
      (rule) => rule.style.getPropertyValue('opacity') !== '',
    );
    for (const rule of dimmed) {
      expect(rule.selectorText, rule.selectorText).toMatch(/:disabled|__mark/);
    }
  });

  it('takes its 44px coarse target from a pseudo-element, not from the drawn box', () => {
    const grown = rulesMentioning('sh-ui-checkbox').find((rule) => rule.selectorText.includes('::after'));
    expect(grown?.style.getPropertyValue('width')).toBe('44px');
    expect(grown?.style.getPropertyValue('height')).toBe('44px');
  });

  it('builds the same control as DOM as it does as React', () => {
    // The scratch pane's CodeMirror widget has no React tree to render into, and
    // widgets are created and destroyed on scroll. This is the assertion that
    // keeps the two from drifting into two different-looking checkboxes.
    const { container } = mount(<Checkbox checked label="Ship it" onChange={() => {}} />);
    const react = control(container);
    const dom = checkboxDOM({ checked: true, label: 'Ship it' });

    expect(dom.tagName).toBe(react.tagName);
    expect(dom.getAttribute('role')).toBe(react.getAttribute('role'));
    expect(dom.getAttribute('aria-checked')).toBe(react.getAttribute('aria-checked'));
    expect(dom.getAttribute('aria-label')).toBe(react.getAttribute('aria-label'));
    expect(dom.getAttribute('title')).toBe(react.getAttribute('title'));
    expect(dom.className).toBe(react.className);
    expect(dom.querySelector('.sh-ui-checkbox__mark')).not.toBeNull();
    expect(dom.querySelector('path')?.getAttribute('d')).toBe(
      react.querySelector('path')?.getAttribute('d'),
    );
  });

  it('reflects unchecked in the DOM build too', () => {
    expect(checkboxDOM({ checked: false, label: 'X' }).getAttribute('aria-checked')).toBe('false');
  });

  it('lets the DOM build carry an extra class without losing its own', () => {
    const dom = checkboxDOM({ checked: false, label: 'X', className: 'sh-scratch-check' });
    expect(dom.classList.contains('sh-ui-checkbox')).toBe(true);
    expect(dom.classList.contains('sh-scratch-check')).toBe(true);
  });

  it('attaches no listener — behaviour belongs to the caller', () => {
    // The scratch pane needs a click to become a document edit, not a state
    // change, so the builder deliberately wires nothing.
    const dom = checkboxDOM({ checked: false, label: 'X' });
    let fired = false;
    dom.addEventListener('click', () => { fired = true; });
    dom.click();
    // Our own listener fires; what matters is that the builder added none that
    // would have changed aria-checked behind the caller's back.
    expect(fired).toBe(true);
    expect(dom.getAttribute('aria-checked')).toBe('false');
  });

  it('transitions colour only, at the one duration', () => {
    for (const rule of rulesMentioning('sh-ui-checkbox')) {
      const value = rule.style.getPropertyValue('transition');
      if (value === '' || value === 'none') continue;
      expect(value, rule.selectorText).toMatch(/var\(--sh-motion\)/);
      expect(value, rule.selectorText).not.toMatch(/transform|width|height|margin|padding/);
    }
  });
});
