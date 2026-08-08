// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { ViewDock } from './view-dock.tsx';
import { EXTENSION_UI, resolveExtensionUi } from './extension-ui.ts';
import { all, mount, one } from './test-dom.ts';

/**
 * The dock, and the two kinds it draws.
 *
 * What these assert is the boundary, not the pixels: that the dock asks a TREE
 * for rows and never asks a COMPONENT for any, that a component is resolved by
 * NAME against the build's own table (so a page cannot be handed code the build
 * never saw), and that the `invoke` a component receives is bound to its view
 * type — the page names no caller, ever (ADR 0031 D14, ADR 0033).
 */

interface Call {
  /**
   * WHICH bridge method carried it, and this field is not decoration.
   *
   * Both `activate` and `invoke` take a view type and a command id, so a fake
   * that recorded only those two could not tell them apart — and a row action
   * routed through `invoke` would pass every assertion here while being a
   * different call. Found by mutation: swapping the seam left the suite green.
   * Main attributes both to the contributing extension today, so what this pins
   * is the seam rather than a live defect.
   */
  readonly via: 'activate' | 'invoke';
  readonly type: string;
  readonly command: string;
  readonly args: unknown;
}

/**
 * Radix's context menu positions with Popper, which observes its trigger.
 * jsdom implements no layout and therefore no `ResizeObserver`, and without one
 * the menu throws on open rather than rendering.
 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;

function bridge(
  views: readonly ViewContributionDTO[],
  calls: Call[] = [],
  rows: readonly TreeItem[] = [],
): ViewsApi {
  return {
    list: () => Promise.resolve({ ok: true, value: views }),
    children: () => Promise.resolve({ ok: true, value: rows }),
    activate: (type, command) => {
      calls.push({ via: 'activate', type, command: command.id, args: command.args });
      return Promise.resolve({ ok: true, value: undefined });
    },
    invoke: (type, command, args) => {
      calls.push({ via: 'invoke', type, command, args });
      return Promise.resolve({ ok: true, value: { slug: 'a-task' } });
    },
    onChanged: () => () => {},
  };
}

/** `list()` resolves on a microtask, so the first paint is one flush behind. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ViewDock', () => {
  it('draws a contributed component by resolving its NAME, not by being told about it', async () => {
    const view = mount(
      <ViewDock
        views={bridge([
          { extension: 'shepherd.tasks', type: 'tasks.composer', kind: 'component', component: 'tasks.composer' },
        ])}
      />,
    );
    await settle();

    expect(all(view.container, 'task-composer')).toHaveLength(1);
    // Nothing in the dock named a task: the section is keyed by the view type
    // the extension chose, and the form inside it came from the table.
    expect(one(view.container, 'view-dock').querySelector('[data-view-kind="component"]')).not.toBeNull();
    view.unmount();
  });

  it('draws an honest empty slot for a name this build has no UI for', async () => {
    // The correct failure. An extension may ASK for a module; it cannot supply
    // one, so a name outside the table must read as "there is no UI here"
    // rather than as an empty view that looks like it loaded.
    const view = mount(
      <ViewDock
        views={bridge([
          { extension: 'evil.ext', type: 'evil.view', kind: 'component', component: 'evil.module' },
        ])}
      />,
    );
    await settle();

    expect(one(view.container, 'view-missing').textContent).toContain('evil.module');
    view.unmount();
  });

  it('hands a component an invoke bound to its own view type, with no caller in it', async () => {
    const calls: Call[] = [];
    const view = mount(
      <ViewDock
        views={bridge(
          [
            {
              extension: 'shepherd.diagnostics',
              type: 'diagnostics.card',
              kind: 'component',
              component: 'diagnostics.card',
            },
          ],
          calls,
        )}
      />,
    );
    await settle();

    act(() => {
      one(view.container, 'diagnostics-ping').click();
    });
    await settle();

    expect(calls).toEqual([
      { via: 'invoke', type: 'diagnostics.card', command: 'diagnostics.bump', args: undefined },
    ]);
    // The answer reaches the component as a value — the whole reason
    // `views.invoke` exists beside `views.activate`.
    expect(one(view.container, 'diagnostics-answer').textContent).toContain('a-task');
    view.unmount();
  });

  it('asks a tree for its rows and a component for none', async () => {
    const asked: string[] = [];
    const views: readonly ViewContributionDTO[] = [
      { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
      { extension: 'shepherd.tasks', type: 'tasks.composer', kind: 'component', component: 'tasks.composer' },
    ];
    const api: ViewsApi = {
      list: () => Promise.resolve({ ok: true, value: views }),
      children: (type) => {
        asked.push(type);
        return Promise.resolve({ ok: true, value: [{ id: 'r1', label: 'a task' }] });
      },
      activate: () => Promise.resolve({ ok: true, value: undefined }),
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      onChanged: () => () => {},
    };

    const view = mount(<ViewDock views={api} />);
    await settle();

    expect(asked).toEqual(['tasks.tree']);
    expect(all(view.container, 'view-row')).toHaveLength(1);
    view.unmount();
  });
});

describe('the extension UI table', () => {
  it('resolves only names it holds', () => {
    expect(resolveExtensionUi('tasks.composer')).toBe(EXTENSION_UI['tasks.composer']);
    expect(resolveExtensionUi('anything.else')).toBeUndefined();
    expect(resolveExtensionUi(undefined)).toBeUndefined();
  });
});

/**
 * A row's CONTEXT MENU — the actions an extension declares on it.
 *
 * The shell cannot know a task's verbs; a dock that hardcoded Reveal / Archive /
 * Delete would be a dock that knows what a task is, which is the special case
 * ADR 0031 exists to prevent. So the entries are data on the row, and what these
 * assert is that they reach the registry through the SAME seam a row click uses
 * — `views.activate`, which main attributes to the contributing extension.
 */
describe('a contributed row-s actions', () => {
  const TREE: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
  ];

  const withActions: readonly TreeItem[] = [
    {
      id: 'task-1',
      label: 'Ship the login fix',
      command: { id: 'tasks.reveal', args: { task: 'task-1' } },
      actions: [
        { id: 'tasks.reveal', label: 'Reveal', icon: 'eye', args: { task: 'task-1' } },
        { separator: true },
        { id: 'tasks.archive', label: 'Archive', icon: 'archive', danger: true, args: { task: 'task-1' } },
        { id: 'tasks.delete', label: 'Delete', icon: 'trash', danger: true, args: { task: 'task-1' } },
      ],
    },
  ];

  const openMenuOnFirstRow = (container: HTMLElement): void => {
    act(() =>
      void one(container, 'view-row').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      ),
    );
  };

  const entries = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.sh-ui-menu__item'),
  ];

  const entry = (label: string): HTMLElement => {
    const found = entries().find((item) => item.textContent?.includes(label));
    if (!found) throw new Error(`no menu entry labelled ${label}`);
    return found;
  };

  it('draws no menu at all for a row that declares none', async () => {
    // An empty menu box opening over the sidebar is worse than nothing
    // happening, so a row with no actions is not wrapped.
    const view = mount(<ViewDock views={bridge(TREE, [], [{ id: 'a', label: 'plain' }])} />);
    await settle();
    openMenuOnFirstRow(view.container);
    expect(document.querySelector('.sh-ui-menu')).toBeNull();
    view.unmount();
  });

  it('draws the declared entries, in order, with the separator', async () => {
    const view = mount(<ViewDock views={bridge(TREE, [], withActions)} />);
    await settle();
    openMenuOnFirstRow(view.container);
    expect(entries().map((item) => item.textContent)).toEqual([
      expect.stringContaining('Reveal'),
      expect.stringContaining('Archive'),
      expect.stringContaining('Delete'),
    ]);
    expect(document.querySelectorAll('.sh-ui-menu__separator')).toHaveLength(1);
    view.unmount();
  });

  it('marks the destructive entries as the extension declared them', async () => {
    const view = mount(<ViewDock views={bridge(TREE, [], withActions)} />);
    await settle();
    openMenuOnFirstRow(view.container);
    expect(entry('Reveal').dataset.danger).toBeUndefined();
    expect(entry('Archive').dataset.danger).toBe('true');
    expect(entry('Delete').dataset.danger).toBe('true');
    view.unmount();
  });

  /**
   * MUTATION TARGET. Routing an action through `views.invoke` or (worse)
   * `commands.invoke` would still run the command and still pass every other
   * test here — and it would run it as the PAGE or as the USER. The assertion
   * that catches it is that it goes through `activate` with the view type, which
   * is the only path main attributes to the contributing extension.
   */
  it('runs a chosen action through views.activate, carrying its args', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(TREE, calls, withActions)} />);
    await settle();
    openMenuOnFirstRow(view.container);
    act(() => entry('Delete').click());
    await settle();

    expect(calls).toEqual([
      { via: 'activate', type: 'tasks.tree', command: 'tasks.delete', args: { task: 'task-1' } },
    ]);
    // The page names no caller. Anywhere.
    expect(JSON.stringify(calls)).not.toContain('user');
    view.unmount();
  });

  it('resolves a glyph NAME against the shell-s own set, and skips an unknown one', async () => {
    // An extension may ask for a glyph; it cannot supply one. A typo renders no
    // icon rather than a placeholder that would be louder than the verb.
    const view = mount(
      <ViewDock
        views={bridge(TREE, [], [
          {
            id: 'r',
            label: 'row',
            actions: [
              { id: 'a.known', label: 'Known', icon: 'trash' },
              { id: 'a.unknown', label: 'Unknown', icon: 'not-a-real-glyph' },
            ],
          },
        ])}
      />,
    );
    await settle();
    openMenuOnFirstRow(view.container);
    expect(entry('Known').querySelector('.sh-ui-menu__icon svg')).not.toBeNull();
    expect(entry('Unknown').querySelector('.sh-ui-menu__icon svg')).toBeNull();
    // The slot is still there on both, so the labels line up.
    expect(entry('Unknown').querySelector('.sh-ui-menu__icon')).not.toBeNull();
    view.unmount();
  });

  it('leaves a plain click doing what it always did', async () => {
    // Adding a menu must not change what the row itself means.
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(TREE, calls, withActions)} />);
    await settle();
    act(() => one(view.container, 'view-row').click());
    await settle();
    expect(calls).toEqual([
      { via: 'activate', type: 'tasks.tree', command: 'tasks.reveal', args: { task: 'task-1' } },
    ]);
    view.unmount();
  });
});
