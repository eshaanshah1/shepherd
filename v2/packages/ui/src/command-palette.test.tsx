import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { CommandPalette, type PaletteCommand } from './command-palette.tsx';
import './styles.css';

const COMMANDS: PaletteCommand[] = [
  { id: 'layout.zoom', title: 'Toggle Zoom', shortcut: '⌘⇧↩' },
  { id: 'layout.rename', title: 'Rename Pane' },
  { id: 'tasks.create', title: 'Tasks: New Task', shortcut: '⌘T' },
  { id: 'tasks.archive', title: 'Tasks: Archive' },
];

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

interface Harness {
  readonly input: HTMLInputElement;
  readonly rows: () => HTMLElement[];
  readonly labels: () => (string | null)[];
  readonly type: (value: string) => void;
  readonly press: (key: string, init?: KeyboardEventInit) => void;
  readonly active: () => string | undefined;
}

const open = (
  onRun: (id: string) => void = () => {},
  onOpenChange: (open: boolean) => void = () => {},
  commands: readonly PaletteCommand[] = COMMANDS,
): Harness => {
  const dom = mount(
    <CommandPalette open onOpenChange={onOpenChange} commands={commands} onRun={onRun} />,
  );
  mounted.push(dom);

  const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]');
  if (!input) throw new Error('no palette input');

  const rows = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-testid="palette-item"]'),
  ];

  return {
    input,
    rows,
    labels: () => rows().map((row) => row.textContent),
    type: (value) => {
      act(() => {
        // React's own setter, so the synthetic `change` carries the new value —
        // assigning `input.value` directly is invisible to React's state.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    press: (key, init) => {
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
        );
      });
    },
    active: () =>
      document.querySelector<HTMLElement>('[data-active="true"]')?.dataset.commandId ?? undefined,
  };
};

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    const dom = mount(
      <CommandPalette open={false} onOpenChange={() => {}} commands={COMMANDS} onRun={() => {}} />,
    );
    mounted.push(dom);
    expect(document.querySelector('[data-testid="palette-input"]')).toBeNull();
  });

  it('lists every command it is given, in order, when nothing is typed', () => {
    const palette = open();
    expect(palette.labels()).toEqual([
      'Toggle Zoom⌘⇧↩',
      'Rename Pane',
      'Tasks: New Task⌘T',
      'Tasks: Archive',
    ]);
  });

  it('is a Composer inside a Modal, and a result is a Row', () => {
    // The design-system claim made testable: `metrics.ts` names the palette as a
    // writing surface and `composer.tsx` names it as the Composer's second
    // instance. Both were written before this component existed.
    const palette = open();
    expect(document.querySelector('.sh-ui-modal .sh-ui-composer.sh-ui-palette')).not.toBeNull();
    expect(palette.rows()[0]?.className).toContain('sh-ui-row');
    // `bare` with no prop saying so: the Composer's scoped role re-declaration
    // is what removes the border, which is the token tier's whole mechanism.
    expect(palette.input.dataset.variant).toBe('bare');
  });

  it('filters as you type, and fuzzily', () => {
    const palette = open();
    palette.type('tn');
    expect(palette.labels()).toEqual(['Tasks: New Task⌘T']);
  });

  it('says so when nothing matches, rather than showing an empty box', () => {
    const palette = open();
    palette.type('qqqq');
    expect(palette.rows()).toHaveLength(0);
    expect(document.querySelector('.sh-ui-palette__empty')?.textContent).toBe('No matching command');
  });

  it('highlights the first match and moves with the arrows, wrapping at both ends', () => {
    const palette = open();
    expect(palette.active()).toBe('layout.zoom');

    palette.press('ArrowDown');
    expect(palette.active()).toBe('layout.rename');

    palette.press('ArrowUp');
    expect(palette.active()).toBe('layout.zoom');

    // Wraps. A list you can arrow off the end of makes the last item harder to
    // reach than the first, for no reason.
    palette.press('ArrowUp');
    expect(palette.active()).toBe('tasks.archive');
    palette.press('ArrowDown');
    expect(palette.active()).toBe('layout.zoom');

    palette.press('End');
    expect(palette.active()).toBe('tasks.archive');
    palette.press('Home');
    expect(palette.active()).toBe('layout.zoom');
  });

  it('keeps focus in the input, naming the active row rather than focusing it', () => {
    // Moving real focus to a row is what makes a palette lose its query on the
    // first arrow press.
    const palette = open();
    palette.press('ArrowDown');
    expect(document.activeElement).toBe(palette.input);
    expect(palette.input.getAttribute('aria-activedescendant')).toContain('layout.rename');
    expect(palette.rows()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(palette.rows()[0]?.getAttribute('aria-selected')).toBe('false');
  });

  it('runs the highlighted command on Enter and closes', () => {
    const run = vi.fn();
    const opened = vi.fn();
    const palette = open(run, opened);
    palette.press('ArrowDown');
    palette.press('Enter');
    expect(run.mock.calls).toEqual([['layout.rename']]);
    expect(opened).toHaveBeenCalledWith(false);
  });

  it('runs a clicked command and closes', () => {
    const run = vi.fn();
    const opened = vi.fn();
    const palette = open(run, opened);
    act(() => palette.rows()[2]?.click());
    expect(run.mock.calls).toEqual([['tasks.create']]);
    expect(opened).toHaveBeenCalledWith(false);
  });

  /**
   * MUTATION TARGET #1. Replacing the clamp with a reset-to-zero, or dropping it
   * entirely, must fail here. Reset sends you back to the top every time you
   * refine a query you were already navigating; unclamped, deleting a character
   * leaves the index past the end and Enter runs nothing at all — and BOTH pass
   * every other test in this file.
   */
  it('runs nothing when the query matches nothing, rather than whatever was first', () => {
    const run = vi.fn();
    const palette = open(run);
    palette.press('End');
    palette.type('qqqq');
    palette.press('Enter');
    expect(run).not.toHaveBeenCalled();

    // And the index is clamped back into the shorter list rather than stranded.
    palette.type('tasks');
    palette.press('Enter');
    expect(run.mock.calls).toEqual([['tasks.create']]);
  });

  it('leaves Escape to the Modal, so there is one opinion about dismissal', () => {
    const opened = vi.fn();
    const palette = open(() => {}, opened);
    palette.press('Escape');
    // Not swallowed here — Radix's dismissable layer listens on the document.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(opened).toHaveBeenCalledWith(false);
  });

  it('shows a shortcut in a KeyCap and binds nothing', () => {
    const run = vi.fn();
    const palette = open(run);
    expect(palette.rows()[0]?.querySelector('.sh-ui-keycap')?.textContent).toBe('⌘⇧↩');
    expect(palette.rows()[1]?.querySelector('.sh-ui-keycap')).toBeNull();
    palette.press('t', { metaKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('overrides its primitives at higher specificity, never by import order', () => {
    // `styles.css` forbids depending on the `@import` order, and alphabetically
    // this file's sheet lands BEFORE composer, field and row — all three of
    // which it sits inside. A single-class override here would silently lose.
    for (const selector of [
      '.sh-ui-composer.sh-ui-palette',
      '.sh-ui-palette__list .sh-ui-palette__item',
      '.sh-ui-palette .sh-ui-palette__input',
    ]) {
      const rule = rulesMentioning('sh-ui-palette').find((entry) => entry.selectorText === selector);
      expect(rule, selector).toBeDefined();
    }
  });

  it('takes every value from a role or a metric', () => {
    for (const rule of rulesMentioning('sh-ui-palette')) {
      expect(rule.cssText, rule.selectorText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(rule.cssText, rule.selectorText).not.toMatch(/\brgba?\(/i);
      expect(rule.cssText, rule.selectorText).not.toMatch(/[^-\w(]\d*[1-9]\d*px/);
    }
  });
});

describe('CommandPalette groups', () => {
  const GROUPED: PaletteCommand[] = [
    { id: 'a', title: 'Split right', group: 'Layout' },
    { id: 'b', title: 'Split down', group: 'Layout' },
    { id: 'c', title: 'Go to api', group: 'Jump to' },
    { id: 'd', title: 'Something else' },
  ];

  const heads = (): string[] =>
    [...document.querySelectorAll('.sh-ui-palette__group')].map((el) => el.textContent ?? '');

  it('draws a heading where the group CHANGES, and once each', () => {
    open(() => {}, () => {}, GROUPED);
    expect(heads()).toEqual(['Layout', 'Jump to']);
  });

  it('draws NO heading for an ungrouped command', () => {
    // Not an invented "Other": a heading above a list of one is furniture
    // pretending to be structure.
    open(() => {}, () => {}, [{ id: 'd', title: 'Something else' }]);
    expect(heads()).toEqual([]);
  });

  it('emits no heading for a group the QUERY filtered away', () => {
    // The headings are a property of the FILTERED list, not the original one —
    // otherwise a search leaves empty sections behind.
    const palette = open(() => {}, () => {}, GROUPED);
    palette.type('api');
    expect(heads()).toEqual(['Jump to']);
  });

  it('keeps ArrowDown stepping one ROW at a time, past the headings', () => {
    // The trap this whole shape exists to avoid: the keyboard index is a
    // position in `matches`, so a heading that counted as an item would make
    // ArrowDown skip a command every time it crossed a group boundary.
    const palette = open(() => {}, () => {}, GROUPED);
    expect(palette.active()).toBe('a');
    palette.press('ArrowDown');
    expect(palette.active()).toBe('b');
    // …and this press crosses INTO `Jump to` without losing a row to the heading.
    palette.press('ArrowDown');
    expect(palette.active()).toBe('c');
  });

  it('hides the headings from the listbox, which contains options only', () => {
    // A `role="listbox"` whose children include non-options is malformed, and a
    // screen reader offering "Layout" as something you can run is worse than not
    // hearing the structure at all.
    open(() => {}, () => {}, GROUPED);
    for (const head of document.querySelectorAll('.sh-ui-palette__group')) {
      expect(head.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('is the ONE place uppercase survives', () => {
    // §6 refuses uppercase micro-labels with tracking, and `SectionLabel` gave
    // its up for exactly that. This is the documented exception: a rail heading
    // is SCANNED (uppercase costs word shape, which is what scanning uses) and a
    // palette heading is peripheral furniture you are not reading while you type.
    const rule = rulesMentioning('sh-ui-palette__group')[0];
    expect(rule?.style.getPropertyValue('text-transform')).toBe('uppercase');
    expect(rule?.style.getPropertyValue('letter-spacing')).toBe('var(--sh-micro-tracking)');
    expect(rule?.style.getPropertyValue('font-size')).toBe('var(--sh-micro-font-size)');
  });
});
