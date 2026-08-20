import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { Modal, type ModalSize } from './modal.tsx';
import { Button } from './button.tsx';
import { Composer } from './composer.tsx';
import { Select } from './select.tsx';
import { rulesMentioning } from './css-rules.ts';
import './styles.css';

const SIZES: ModalSize[] = ['md', 'lg'];

const content = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('.sh-ui-modal');
  if (!found) throw new Error('no modal content in the document');
  return found;
};

const pressEscape = (): void => {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
};

describe('Modal', () => {
  it('renders nothing while closed', () => {
    mount(
      <Modal open={false} onOpenChange={() => {}} title="New task">
        <Button>Create</Button>
      </Modal>,
    );
    expect(document.querySelector('.sh-ui-modal')).toBeNull();
    expect(document.querySelector('.sh-ui-modal__scrim')).toBeNull();
  });

  it('renders the card and a scrim while open', () => {
    const dom = mount(
      <Modal open onOpenChange={() => {}} title="New task">
        <p>body</p>
      </Modal>,
    );
    expect(content().textContent).toContain('body');
    expect(document.querySelector('.sh-ui-modal__scrim')).not.toBeNull();
    dom.unmount();
  });

  it('renders each size with its class and its width token', () => {
    for (const size of SIZES) {
      const dom = mount(
        <Modal open onOpenChange={() => {}} title="t" size={size}>
          <p>body</p>
        </Modal>,
      );
      const el = content();
      expect(el.className, size).toContain(`sh-ui-modal--${size}`);
      expect(el.dataset.size, size).toBe(size);
      expect(getComputedStyle(el).width, size).toBe('var(--sh-ui-modal-width)');
      dom.unmount();
    }
  });

  it('carries the widths the spec approved — md 460, lg 620', () => {
    // The one pair of literals in this package, declared as component tokens so
    // there is exactly one place either number is written.
    for (const dom of [
      mount(
        <Modal open onOpenChange={() => {}} title="t" size="md">
          <p>b</p>
        </Modal>,
      ),
    ]) {
      expect(getComputedStyle(content()).getPropertyValue('--sh-ui-modal-width')).toBe('460px');
      dom.unmount();
    }
    const large = mount(
      <Modal open onOpenChange={() => {}} title="t" size="lg">
        <p>b</p>
      </Modal>,
    );
    expect(getComputedStyle(content()).getPropertyValue('--sh-ui-modal-width')).toBe('620px');
    large.unmount();
  });

  it('names itself for a screen reader without drawing a header', () => {
    // The composer proved a title bar over a form asking one question is a label
    // for nothing — but a dialog that has just taken the whole keyboard and
    // announces itself as "dialog" is worse. The name is there; the header is not.
    const dom = mount(
      <Modal open onOpenChange={() => {}} title="New task">
        <p>body</p>
      </Modal>,
    );
    const el = content();
    const title = el.querySelector('.sh-ui-sr-only');
    expect(title?.textContent).toBe('New task');
    expect(el.getAttribute('aria-labelledby')).toBe(title?.id);
    // Nothing visible above the body: no header element of its own.
    expect(el.querySelector('header')).toBeNull();
    dom.unmount();
  });

  it('closes on Escape', () => {
    const onOpenChange = vi.fn();
    const dom = mount(
      <Modal open onOpenChange={onOpenChange} title="t">
        <Button>Create</Button>
      </Modal>,
    );
    pressEscape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    dom.unmount();
  });

  it('traps focus: it takes focus on open and hides the rest of the page from AT', () => {
    const dom = mount(
      <>
        <button type="button" data-testid="outside">
          outside
        </button>
        <Modal open onOpenChange={() => {}} title="t">
          <Button data-testid="inside">Create</Button>
        </Modal>
      </>,
    );

    // Focus moved into the dialog. jsdom implements no Tab navigation, so the
    // cycle itself is not observable here — what IS observable is the two halves
    // of the trap that matter for a keyboard user landing in it: focus went in,
    // and everything outside is inert to assistive technology.
    const el = content();
    expect(el.contains(document.activeElement)).toBe(true);

    const outside = dom.container.querySelector('[data-testid="outside"]');
    const hiddenAncestor = outside?.closest('[aria-hidden="true"]');
    expect(hiddenAncestor).not.toBeNull();
    expect(hiddenAncestor?.contains(el)).toBe(false);

    dom.unmount();
  });

  /**
   * A composer's menus float free, and this is where that is decided.
   *
   * `overflow: auto` makes this element a scroll container, and a scroll container
   * clips every absolutely positioned descendant at its padding edge — so a
   * `Select`'s list, anchored to a control in the card's last row, is cut off at
   * the card's bottom no matter what the list does. Asserted on the RULE rather
   * than through layout, because jsdom does not clip anything and would report a
   * fixed version and a broken one identically.
   */
  it('does not clip a composer — a menu opened in the card floats over the app', () => {
    const declared = rulesMentioning('.sh-ui-modal')
      .filter((rule) => rule.selectorText.includes(':has(.sh-ui-composer)'))
      .map((rule) => rule.style.getPropertyValue('overflow'));
    expect(declared).toContain('visible');

    // …and the composer really is what the selector answers about, so the rule
    // cannot quietly stop matching.
    const dom = mount(
      <Modal open onOpenChange={() => {}} title="New task" size="lg">
        <Composer>
          <Select value="a" options={[{ value: 'a', label: 'A' }]} label="Model" onChange={() => {}} />
        </Composer>
      </Modal>,
    );
    expect(content().querySelector('.sh-ui-composer')).not.toBeNull();
    dom.unmount();
  });

  it('spreads unanticipated props onto the card', () => {
    const dom = mount(
      <Modal open onOpenChange={() => {}} title="t" data-testid="composer-modal">
        <p>b</p>
      </Modal>,
    );
    expect(content().getAttribute('data-testid')).toBe('composer-modal');
    dom.unmount();
  });
});
