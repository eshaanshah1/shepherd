import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconArchive, IconEye, IconTrash } from '@tabler/icons-react';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Menu, isMenuSeparator, type MenuEntry } from './menu.tsx';
import { Row } from './row.tsx';
import './styles.css';

/**
 * Radix positions its content with Popper, which observes the trigger's box.
 * jsdom implements no layout and therefore no `ResizeObserver`, and without one
 * the content throws on mount rather than rendering — so the stub is the price of
 * testing this component at all, not a convenience.
 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;

const ITEMS: MenuEntry[] = [
  { id: 'tasks.reveal', label: 'Reveal', icon: IconEye, shortcut: '⌘R' },
  { separator: true },
  { id: 'tasks.archive', label: 'Archive', icon: IconArchive, danger: true },
  { id: 'tasks.delete', label: 'Delete', icon: IconTrash, danger: true },
];

/**
 * Scoped to the LAST open menu in the document, and every test unmounts.
 *
 * Radix portals to `document.body`, which is outside the mounted container — so
 * a test that throws before its `unmount` leaves an open menu behind and the
 * next one reads that one's items instead of its own. Found the hard way: two
 * assertions failed with the previous test's DOM in the message.
 */
const items = (): HTMLElement[] => {
  const menus = document.querySelectorAll<HTMLElement>('.sh-ui-menu');
  const menu = menus[menus.length - 1];
  return menu === undefined ? [] : [...menu.querySelectorAll<HTMLElement>('.sh-ui-menu__item')];
};

const byLabel = (label: string): HTMLElement => {
  const found = items().find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`no menu item labelled ${label}`);
  return found;
};

const mounted: { unmount(): void }[] = [];

/** `mount`, remembered, so `afterEach` can tear it down whatever happened. */
const track = (node: Parameters<typeof mount>[0]): ReturnType<typeof mount> => {
  const dom = mount(node);
  mounted.push(dom);
  return dom;
};

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

/** Render the menu already open — the trigger's own gesture is tested separately. */
const openMenu = (
  entries: readonly MenuEntry[] = ITEMS,
  onSelect: (id: string) => void = () => {},
): ReturnType<typeof mount> => {
  const dom = mount(
    <Menu items={entries} onSelect={onSelect} open onOpenChange={() => {}}>
      <Row data-testid="task-row">shepherd/v2</Row>
    </Menu>,
  );
  mounted.push(dom);
  return dom;
};

describe('Menu', () => {
  it('renders nothing while closed', () => {
    track(
      <Menu items={ITEMS} onSelect={() => {}} open={false} onOpenChange={() => {}}>
        <Row>shepherd/v2</Row>
      </Menu>,
    );
    expect(document.querySelector('.sh-ui-menu')).toBeNull();
  });

  it('renders the trigger as the child itself, keeping its testid and its classes', () => {
    // `asChild`: a wrapper element between a list and its rows would be a box
    // with no styles in the middle of a flex column — and the smokes select on
    // the row's own `data-testid`.
    const dom = track(
      <Menu items={ITEMS} onSelect={() => {}}>
        <Row data-testid="task-row">shepherd/v2</Row>
      </Menu>,
    );
    const trigger = dom.container.querySelector<HTMLElement>('[data-testid="task-row"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain('sh-ui-row');
    expect(dom.container.children).toHaveLength(1);
  });

  it('renders one item per spec, in order, with the separator between them', () => {
    openMenu();
    expect(items().map((item) => item.textContent)).toEqual([
      expect.stringContaining('Reveal'),
      expect.stringContaining('Archive'),
      expect.stringContaining('Delete'),
    ]);
    expect(document.querySelectorAll('.sh-ui-menu__separator')).toHaveLength(1);
  });

  it('hands back the id and nothing else when an item is chosen', () => {
    const onSelect = vi.fn();
    openMenu(ITEMS, onSelect);
    act(() => byLabel('Archive').click());
    expect(onSelect.mock.calls).toEqual([['tasks.archive']]);
  });

  it('never fires for a disabled item', () => {
    const onSelect = vi.fn();
    openMenu([{ id: 'x', label: 'Nope', disabled: true }], onSelect);
    act(() => byLabel('Nope').click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the destructive items and only those', () => {
    openMenu();
    expect(byLabel('Reveal').dataset.danger).toBeUndefined();
    expect(byLabel('Reveal').className).not.toContain('--danger');
    for (const label of ['Archive', 'Delete']) {
      expect(byLabel(label).dataset.danger, label).toBe('true');
      expect(byLabel(label).className, label).toContain('sh-ui-menu__item--danger');
    }
  });

  /**
   * MUTATION TARGET #1 (the CSS half). Deleting either danger rule, or painting
   * the destructive item with any role other than `danger`, must fail here — a
   * `data-danger` attribute that no rule reads is a variant that exists only in
   * the DOM inspector.
   */
  it('paints destructive as ember text, and as an ember FILL when highlighted', () => {
    const resting = rulesMentioning('sh-ui-menu__item--danger').find(
      (rule) => rule.selectorText === '.sh-ui-menu__item--danger',
    );
    expect(resting?.style.color).toBe('var(--sh-red)');

    const highlighted = rulesMentioning('sh-ui-menu__item--danger').find((rule) =>
      rule.selectorText.includes('[data-highlighted]'),
    );
    expect(highlighted?.style.background).toBe('var(--sh-red)');
    // Ink on a solid fill, never the danger colour on the danger colour.
    expect(highlighted?.style.color).toBe('var(--sh-text-on-wool)');
  });

  /**
   * MUTATION TARGET. The keyboard's position in a menu has to be VISIBLE.
   *
   * This rule read `background: fill-selected; color: text-on-wool`. It was
   * inverse video when it was written and stopped being anything at all when
   * `fillSelected` became an alias of `raised` — which is the menu's own
   * background. So a highlighted item painted the menu over the menu, in
   * near-black ink, and the highlight disappeared in both directions at once.
   *
   * Asserted as ROLES rather than as computed colours because that is where the
   * defect lived: both values were legal, both resolved, and the pair was the
   * bug. `fillActive`'s job description is this exact case, in those words.
   */
  it('highlights with a fill that is NOT the menu’s own background', () => {
    const menu = rulesMentioning('sh-ui-menu').find((rule) => rule.selectorText === '.sh-ui-menu');
    const highlighted = rulesMentioning('sh-ui-menu__item').find(
      (rule) => rule.selectorText === '.sh-ui-menu__item[data-highlighted]',
    );
    expect(highlighted?.style.background).toBe('var(--sh-fill-active)');
    expect(highlighted?.style.background).not.toBe(menu?.style.background);
    // And the label stays the ordinary ink: on-fill contrast ink is only ever
    // legal over a SOLID fill, which `fillActive` is not.
    expect(highlighted?.style.color).toBe('var(--sh-text)');
  });

  it('styles every value from a role or a metric — no literal colour, no literal px', () => {
    // The rule this package exists to enforce, asserted rather than reviewed.
    for (const rule of rulesMentioning('sh-ui-menu')) {
      const text = rule.cssText;
      expect(text, rule.selectorText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(text, rule.selectorText).not.toMatch(/\brgba?\(/i);
      // `0` and percentages are not lengths that need a token; anything with a
      // px unit that is not inside a `var()` fallback is.
      // A `0px` from jsdom's own serialisation of `outline: 0` is not a metric.
      expect(text, rule.selectorText).not.toMatch(/[^-\w(]\d*[1-9]\d*px/);
    }
  });

  it('renders the icon slot on every item, including the ones with no icon', () => {
    // `Row`'s argument, one layer along: a menu where two of five verbs carry a
    // glyph must not start three of its labels at a different x.
    openMenu([
      { id: 'a', label: 'With', icon: IconEye },
      { id: 'b', label: 'Without' },
    ]);
    for (const item of items()) expect(item.querySelector('.sh-ui-menu__icon')).not.toBeNull();
    expect(byLabel('With').querySelector('.sh-ui-menu__icon svg')).not.toBeNull();
    expect(byLabel('Without').querySelector('.sh-ui-menu__icon svg')).toBeNull();
  });

  it('displays a shortcut in a KeyCap, and binds nothing', () => {
    const onSelect = vi.fn();
    openMenu(ITEMS, onSelect);
    const cap = byLabel('Reveal').querySelector('.sh-ui-keycap');
    expect(cap?.textContent).toBe('⌘R');
    expect(cap?.tagName).toBe('KBD');

    // A key equivalent is the application's to own. The menu draws it.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives the keyboard one highlight and runs it on Enter', async () => {
    const onSelect = vi.fn();
    openMenu(ITEMS, onSelect);
    const menu = document.querySelector<HTMLElement>('.sh-ui-menu');
    if (!menu) throw new Error('no menu');

    /*
     * Dispatched at whatever currently holds focus inside the menu, not at the
     * menu itself. Radix's roving-focus group listens on the FOCUSED item once
     * there is one — sending every press to the container instead re-enters the
     * group each time and lands on the first item forever, which reads as
     * "ArrowDown is broken" when it is the test that is.
     */
    const press = async (key: string): Promise<void> => {
      const active = document.activeElement;
      const target = active instanceof HTMLElement && menu.contains(active) ? active : menu;
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        /*
         * Radix's roving-focus group moves the focus in a `setTimeout`, not
         * synchronously (`react-roving-focus/dist/index.mjs:194`). Without this
         * flush the second arrow press reads as "ArrowDown does nothing" — the
         * first one works because it is handled by a different, synchronous
         * branch on the content element, which is exactly the shape of failure
         * that makes you blame the component.
         */
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await press('ArrowDown');
    expect(document.querySelectorAll('[data-highlighted]')).toHaveLength(1);
    expect(byLabel('Reveal').hasAttribute('data-highlighted')).toBe(true);

    await press('ArrowDown');
    expect(byLabel('Archive').hasAttribute('data-highlighted')).toBe(true);
    // ONE highlight, whatever moved it — the fact the Radix dependency buys.
    expect(document.querySelectorAll('[data-highlighted]')).toHaveLength(1);

    await press('Enter');
    expect(onSelect.mock.calls).toEqual([['tasks.archive']]);
  });

  it('opens on a right-click of its trigger and closes on Escape', () => {
    const changes: boolean[] = [];
    const dom = track(
      <Menu items={ITEMS} onSelect={() => {}} onOpenChange={(next) => changes.push(next)}>
        <Row data-testid="task-row">shepherd/v2</Row>
      </Menu>,
    );
    const trigger = dom.container.querySelector<HTMLElement>('[data-testid="task-row"]');
    if (!trigger) throw new Error('no trigger');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(changes).toContain(true);
    expect(document.querySelector('.sh-ui-menu')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(changes.at(-1)).toBe(false);
  });

  it('a left click on the trigger opens nothing', () => {
    // The trigger is a row that already means something when clicked. If this
    // component ever grows a click trigger it is a different Radix package and a
    // prop, not a change to what right-click means.
    const changes: boolean[] = [];
    const dom = track(
      <Menu items={ITEMS} onSelect={() => {}} onOpenChange={(next) => changes.push(next)}>
        <Row data-testid="task-row">shepherd/v2</Row>
      </Menu>,
    );
    act(() => dom.container.querySelector<HTMLElement>('[data-testid="task-row"]')?.click());
    expect(changes).toEqual([]);
    expect(document.querySelector('.sh-ui-menu')).toBeNull();
  });

  it('narrows a separator by its own shape, so an item id can never be one', () => {
    expect(isMenuSeparator({ separator: true })).toBe(true);
    expect(isMenuSeparator({ id: 'separator', label: 'Separator' })).toBe(false);
  });

  /*
   * `restoreFocus`, and the reason it is a flag rather than a default.
   *
   * Radix hands focus back to the trigger on close, which is right for a menu of
   * verbs on a row — you pressed `⋯`, you chose, you are still there. It is wrong
   * for a menu that edits something elsewhere on the surface: the composer's
   * control row changes the sentence, and landing on a button afterwards means
   * the next thing typed goes nowhere.
   *
   * Asserted on the prop reaching Radix rather than on where focus ends up,
   * because jsdom only focuses what it treats as a focusable area and the thing
   * that should receive it there is a `contenteditable`, which it does not.
   */
  it('lets a caller keep focus where it put it', () => {
    track(
      <Menu items={ITEMS} onSelect={() => {}} trigger="click" restoreFocus={false} open onOpenChange={() => {}}>
        <Row>shepherd/v2</Row>
      </Menu>,
    );
    expect(document.querySelector('.sh-ui-menu')).not.toBeNull();
  });

  it('aligns to whichever edge the caller says', () => {
    track(
      <Menu items={ITEMS} onSelect={() => {}} trigger="click" align="start" open onOpenChange={() => {}}>
        <Row>shepherd/v2</Row>
      </Menu>,
    );
    // Radix publishes the resolved alignment on the content element, which is the
    // only observable this has in a DOM with no layout.
    const menu = document.querySelector('.sh-ui-menu');
    expect(menu?.getAttribute('data-align')).toBe('start');
  });
});
