import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IconPlus } from '@tabler/icons-react';
import { mount } from './test-dom.ts';
import { IconButton, type IconButtonSize } from './icon-button.tsx';
import { iconSizes } from './icon.tsx';
import './styles.css';

const SIZES: IconButtonSize[] = ['sm', 'md'];

const button = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-icon-button');
  if (!found) throw new Error('no icon button rendered');
  return found;
};

describe('IconButton', () => {
  it('renders every size with its class and its square width', () => {
    for (const size of SIZES) {
      const dom = mount(<IconButton icon={IconPlus} label="New task" size={size} />);
      const el = button(dom.container);
      expect(el.className, size).toContain(`sh-ui-icon-button--${size}`);
      expect(el.className, size).toContain(`sh-ui-button--${size}`);
      expect(getComputedStyle(el).width, size).toBe(`var(--sh-control-${size})`);
      expect(getComputedStyle(el).height, size).toBe(`var(--sh-control-${size})`);
    }
  });

  it('defaults to a ghost at md', () => {
    // Borderless at rest, because a bordered box beside a 12px section title is
    // louder than the list it adds to.
    const dom = mount(<IconButton icon={IconPlus} label="New task" />);
    const el = button(dom.container);
    expect(el.className).toContain('sh-ui-button--ghost');
    expect(el.className).toContain('sh-ui-icon-button--md');
  });

  it('takes the label as its accessible name AND as its native title', () => {
    const dom = mount(<IconButton icon={IconPlus} label="New task" />);
    expect(button(dom.container).getAttribute('aria-label')).toBe('New task');
    expect(button(dom.container).getAttribute('title')).toBe('New task');
  });

  it('keeps the glyph decorative, so the name is read once', () => {
    const dom = mount(<IconButton icon={IconPlus} label="New task" />);
    const svg = button(dom.container).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe(`${iconSizes.md}`);
  });

  it('inherits Button-s inert guard', () => {
    // Built ON Button rather than beside it, so there is one answer to what
    // disabled means — not a second implementation to keep in step.
    const onClick = vi.fn();
    const dom = mount(<IconButton icon={IconPlus} label="New task" disabled onClick={onClick} />);
    act(() => {
      button(dom.container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLButtonElement | null = null;
    const dom = mount(
      <IconButton
        icon={IconPlus}
        label="New task"
        data-testid="sidebar-add"
        ref={(element) => {
          node = element;
        }}
      />,
    );
    expect(button(dom.container).getAttribute('data-testid')).toBe('sidebar-add');
    expect(node).toBe(button(dom.container));
  });

  /**
   * The label is a TYPE error to omit, not a lint rule to install.
   *
   * `@ts-expect-error` fails the build when the line it guards compiles cleanly,
   * so this assertion is checked by `pnpm typecheck` rather than at runtime —
   * delete `label` from `IconButtonProps` and the typecheck gate fails here.
   * That is stronger than the lint rule the spec imagined and it needs nothing
   * installed: an icon-only control with no accessible name announces itself as
   * "button", and it is exactly the control nobody remembers to describe.
   */
  it('demands a label at the type level', () => {
    const missingLabel = (
      // @ts-expect-error `label` is required — an icon-only button must be named.
      <IconButton icon={IconPlus} />
    );
    expect(missingLabel).toBeTruthy();
  });
});
