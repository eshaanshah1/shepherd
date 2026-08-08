import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { KeyCap } from './keycap.tsx';
import './styles.css';

const cap = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-keycap');
  if (!found) throw new Error('no keycap rendered');
  return found;
};

describe('KeyCap', () => {
  it('renders a kbd carrying whatever it was handed', () => {
    // No symbol table and no `keys={['cmd','t']}`: a modifier glyph is platform
    // vocabulary the caller already knows, and a table here would be a second
    // place `⌘` is spelled.
    const dom = mount(<KeyCap>⌘T</KeyCap>);
    expect(cap(dom.container).tagName).toBe('KBD');
    expect(cap(dom.container).textContent).toBe('⌘T');
  });

  it('is a hairline box with no fill', () => {
    // Rule 5: flat, bordered, honest. A filled keycap beside a filled button
    // puts two things at the same volume, one of which cannot be pressed.
    const rule = rulesMentioning('sh-ui-keycap')[0];
    expect(rule?.style.getPropertyValue('border')).toContain('var(--sh-line)');
    expect(rule?.style.getPropertyValue('background')).toBe('transparent');
    expect(rule?.style.getPropertyValue('border-radius')).toBe('var(--sh-radius-sm)');
  });

  it('is display only — it never presents as pressable', () => {
    // v2's sidebar footer legend is why: a keycap reading `⌘T NEW TASK` sat at
    // the bottom of the list as the only way to add one, which teaches a shortcut
    // instead of being a button. It was replaced with a real IconButton.
    const rule = rulesMentioning('sh-ui-keycap')[0];
    expect(rule?.style.cursor).toBe('default');
    expect(rule?.style.getPropertyValue('user-select')).toBe('none');
  });

  it('is machine vocabulary, so it is set in mono', () => {
    const rule = rulesMentioning('sh-ui-keycap')[0];
    expect(rule?.style.getPropertyValue('font-family')).toBe('var(--sh-font-mono)');
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLElement | null = null;
    const dom = mount(
      <KeyCap
        data-testid="shortcut"
        ref={(element) => {
          node = element;
        }}
      >
        ⎋
      </KeyCap>,
    );
    expect(cap(dom.container).getAttribute('data-testid')).toBe('shortcut');
    expect(node).toBe(cap(dom.container));
  });
});
