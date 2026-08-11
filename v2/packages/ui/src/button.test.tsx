import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { Button, type ButtonSize, type ButtonVariant } from './button.tsx';
import { BRAILLE_FRAMES } from './spinner.ts';
import './styles.css';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];

const button = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-button');
  if (!found) throw new Error('no button rendered');
  return found;
};

/**
 * A click the DOM cannot refuse.
 *
 * `HTMLElement.click()` is not good enough here: jsdom implements the spec's
 * "if the element is actually disabled, return", so a test using it would pass
 * against a component with no guard at all — it would be testing jsdom. A
 * dispatched event reaches React's listener the way a programmatic caller, a
 * synthesised click and a stray drag-release do, and the guard in button.tsx is
 * then the only thing that can stop it.
 */
const clickHard = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

describe('Button', () => {
  it('renders every variant with its class', () => {
    for (const variant of VARIANTS) {
      const dom = mount(<Button variant={variant}>Go</Button>);
      expect(button(dom.container).className, variant).toContain(`sh-ui-button--${variant}`);
      expect(button(dom.container).dataset.variant, variant).toBe(variant);
    }
  });

  it('renders every size with its class', () => {
    for (const size of SIZES) {
      const dom = mount(<Button size={size}>Go</Button>);
      expect(button(dom.container).className, size).toContain(`sh-ui-button--${size}`);
      expect(button(dom.container).dataset.size, size).toBe(size);
    }
  });

  it('defaults to default/md', () => {
    const dom = mount(<Button>Go</Button>);
    const el = button(dom.container);
    expect(el.className).toContain('sh-ui-button--secondary');
    expect(el.className).toContain('sh-ui-button--md');
  });

  it('takes each size from the control scale and nothing else', () => {
    // The relation, not the number: a button's height is the shared control
    // token, which is also what a Row's height derives from — `control.md` and
    // `row` are one ratio in metrics.ts precisely so the two cannot drift.
    for (const size of SIZES) {
      const dom = mount(<Button size={size}>Go</Button>);
      expect(getComputedStyle(button(dom.container)).height, size).toBe(`var(--sh-control-${size})`);
    }
  });

  it('fires its click handler when it is live', () => {
    const onClick = vi.fn();
    const dom = mount(<Button onClick={onClick}>Go</Button>);
    clickHard(button(dom.container));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is inert when disabled: the click handler does not fire', () => {
    const onClick = vi.fn();
    const dom = mount(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    const el = button(dom.container);
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(el.getAttribute('aria-disabled')).toBe('true');
    clickHard(el);
    expect(onClick).not.toHaveBeenCalled();
  });

  /**
   * THE mutation target for the disabled guard, and the reason it is this case
   * rather than the plain one above.
   *
   * A disabled `<button>` is stopped THREE times over: jsdom's `click()` refuses
   * to activate it, React's own event system filters mouse events on disabled
   * form controls before a handler runs, and only then does our guard get a say.
   * A test that used a real button would therefore pass with the guard deleted —
   * measured, not assumed: removing it left every other button test green.
   *
   * `asChild` is where the guard is the only thing there is. An anchor has no
   * `disabled` attribute for React to filter on, so a disabled Button rendered as
   * a link is inert because `handleClick` says so and for no other reason.
   */
  it('is inert when disabled even as somebody else-s element, where nothing native helps', () => {
    const onClick = vi.fn();
    const dom = mount(
      <Button asChild disabled onClick={onClick}>
        <a href="https://example.invalid">Open</a>
      </Button>,
    );
    const anchor = dom.container.querySelector('a');
    if (!anchor) throw new Error('no anchor');
    expect(anchor.hasAttribute('disabled')).toBe(false);
    expect(anchor.getAttribute('aria-disabled')).toBe('true');
    clickHard(anchor);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is inert while busy, so the click that started the work cannot start it twice', () => {
    const onClick = vi.fn();
    const dom = mount(
      <Button busy onClick={onClick}>
        Go
      </Button>,
    );
    clickHard(button(dom.container));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('swaps the label for a braille frame without removing it from the layout', () => {
    const dom = mount(<Button busy>Create task</Button>);
    const el = button(dom.container);
    expect(el.dataset.busy).toBe('true');
    expect(el.getAttribute('aria-busy')).toBe('true');

    // The width pin: the label is STILL in the tree, hidden — a removed label is
    // a button that narrows to the spinner and reflows the row it sits in.
    const label = el.querySelector('.sh-ui-button__label');
    expect(label?.textContent).toBe('Create task');

    const spinner = el.querySelector('.sh-ui-button__spinner');
    expect(spinner).not.toBeNull();
    expect(BRAILLE_FRAMES).toContain(spinner?.textContent);
    // Decorative: the state is announced by aria-busy, not by reading a glyph.
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides the busy label by visibility, never by display', () => {
    // `display: none` would take the label out of the layout, which is exactly
    // the reflow the busy state exists to avoid. The rule, asserted directly.
    const dom = mount(<Button busy>Create task</Button>);
    const label = dom.container.querySelector<HTMLElement>('.sh-ui-button__label');
    if (!label) throw new Error('no label');
    expect(getComputedStyle(label).visibility).toBe('hidden');
    expect(getComputedStyle(label).display).not.toBe('none');
  });

  it('draws no spinner when it is not busy', () => {
    const dom = mount(<Button>Go</Button>);
    expect(dom.container.querySelector('.sh-ui-button__spinner')).toBeNull();
  });

  it('becomes the caller-s element with asChild, keeping its classes', () => {
    const dom = mount(
      <Button asChild variant="ghost" size="sm">
        <a href="https://example.invalid">Open</a>
      </Button>,
    );
    const anchor = dom.container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.className).toContain('sh-ui-button');
    expect(anchor?.className).toContain('sh-ui-button--ghost');
    expect(anchor?.className).toContain('sh-ui-button--sm');
    // No `disabled` attribute exists on an anchor, which is why the inert state
    // is carried by aria-disabled and by the click guard rather than by it.
    expect(anchor?.hasAttribute('disabled')).toBe(false);
  });

  it('spreads unanticipated props onto the root', () => {
    const dom = mount(
      <Button data-testid="create" aria-keyshortcuts="Meta+T">
        Go
      </Button>,
    );
    const el = button(dom.container);
    expect(el.getAttribute('data-testid')).toBe('create');
    expect(el.getAttribute('aria-keyshortcuts')).toBe('Meta+T');
  });

  it('keeps a caller class alongside its own', () => {
    const dom = mount(<Button className="sh-plate-key">Go</Button>);
    expect(button(dom.container).className).toContain('sh-plate-key');
    expect(button(dom.container).className).toContain('sh-ui-button');
  });

  it('forwards a ref to the element it rendered', () => {
    let node: HTMLButtonElement | null = null;
    mount(
      <Button
        ref={(element) => {
          node = element;
        }}
      >
        Go
      </Button>,
    );
    expect((node as HTMLButtonElement | null)?.tagName).toBe('BUTTON');
  });
});
