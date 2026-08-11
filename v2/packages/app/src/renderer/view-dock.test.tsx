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

  it('highlights the row whose ROOT the window is on, from the same value the stage draws from', async () => {
    // The dock keeps no selection of its own. A row names the layout root it
    // stands for and the shell compares that against the active root — the very
    // value `app.tsx` uses to decide which root to show. One value, so the
    // highlight and the visible pane cannot disagree.
    const rows: readonly TreeItem[] = [
      { id: 'task-1', label: 'One', root: 'task:task-1' },
      { id: 'task-2', label: 'Two', root: 'task:task-2' },
    ];
    const view = mount(<ViewDock views={bridge(TREE, [], rows)} activeRoot="task:task-2" />);
    await settle();
    expect(all(view.container, 'view-row').map((row) => row.dataset.selected)).toEqual([
      undefined,
      'true',
    ]);

    // The window moves and the highlight moves with it — no click involved,
    // which is the case a click-written selection got wrong.
    view.rerender(<ViewDock views={bridge(TREE, [], rows)} activeRoot="task:task-1" />);
    await settle();
    expect(all(view.container, 'view-row').map((row) => row.dataset.selected)).toEqual([
      'true',
      undefined,
    ]);

    // A click runs the row's command and nothing else: the highlight follows
    // the window, and the window has not moved yet.
    act(() => all(view.container, 'view-row')[1]?.click());
    await settle();
    expect(all(view.container, 'view-row').map((row) => row.dataset.selected)).toEqual([
      'true',
      undefined,
    ]);
    view.unmount();
  });

  it('highlights nothing when the window is on a root no row names', async () => {
    // The home root, and the moments after a task is archived. A row left lit
    // for a task no longer on screen is the stale highlight this replaces.
    const rows: readonly TreeItem[] = [{ id: 'task-1', label: 'One', root: 'task:task-1' }];
    const view = mount(<ViewDock views={bridge(TREE, [], rows)} activeRoot="window-1" />);
    await settle();
    expect(one(view.container, 'view-row').dataset.selected).toBeUndefined();
    view.unmount();
  });

  it('highlights no row that names no root, even when the window is on none either', async () => {
    // A row with no root is a row the highlight is not about. Comparing two
    // absent values would light every such row the moment the shell could not
    // name its active root.
    const rows: readonly TreeItem[] = [{ id: 'plain', label: 'Plain' }];
    const view = mount(<ViewDock views={bridge(TREE, [], rows)} activeRoot={null} />);
    await settle();
    expect(one(view.container, 'view-row').dataset.selected).toBeUndefined();
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

/**
 * The foot: the group a contribution puts LAST, and where the dock puts it.
 *
 * Two rules, and both were reported from the running app rather than reasoned
 * about here. A heading that is the first row used to be dropped as "a label
 * for nothing", which made the sidebar change shape the moment the last live
 * task ended — DONE vanished and the finished tasks jumped to the top. And the
 * foot is capped, so finished work cannot push live work off the screen.
 */
describe('the dock-s foot group', () => {
  const TREE: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
  ];

  const done = (n: number): readonly TreeItem[] => [
    { id: 'group:done', label: 'DONE', section: true },
    ...Array.from({ length: n }, (_, i) => ({ id: `t${String(i)}`, label: `Task ${String(i)}` })),
  ];

  it('draws a heading that is the first row, rather than dropping it', async () => {
    const view = mount(<ViewDock views={bridge(TREE, [], done(2))} />);
    await settle();
    expect(all(view.container, 'view-group').map((el) => el.textContent)).toEqual(['DONE']);
    view.unmount();
  });

  it('keeps a first-row heading pinned to the foot, not floated to the top', async () => {
    // The two halves of the same report: with nothing above it there was no
    // last section to split on, so every row landed in the top list.
    const view = mount(<ViewDock views={bridge(TREE, [], done(2))} />);
    await settle();
    const foot = view.container.querySelector('.sh-rows-foot');
    expect(foot).not.toBeNull();
    expect(foot?.contains(one(view.container, 'view-group'))).toBe(true);
    expect(all(view.container, 'view-row').every((row) => foot?.contains(row) === true)).toBe(true);
    view.unmount();
  });

  it('scrolls the finished rows and leaves the heading outside the scroller', async () => {
    // A DONE that scrolls away leaves a list of finished tasks with nothing
    // saying what they are — so the cap is on the rows, not on the group.
    const view = mount(<ViewDock views={bridge(TREE, [], done(9))} />);
    await settle();
    const scroller = view.container.querySelector('.sh-rows-foot-scroll');
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(one(view.container, 'view-group'))).toBe(false);
    expect(scroller?.querySelectorAll('[data-testid="view-row"]')).toHaveLength(9);
    view.unmount();
  });
});

/**
 * A remote view has to SAY it is remote.
 *
 * Everything else about it is identical to a local one — the same rows, the
 * same verbs, the same state dot — which is the design working. It is also the
 * hazard: archiving a task on the wrong Mac looks exactly like archiving it on
 * this one, and nothing about the gesture would tell you.
 */
describe('views from another member', () => {
  const REMOTE: ViewContributionDTO[] = [
    {
      extension: 'shepherd.tasks',
      type: 'mac-b∷tasks.tree',
      kind: 'tree',
      remote: { memberId: 'mac-b', name: 'Mac B' },
    },
  ];

  const rows: readonly TreeItem[] = [
    { id: 'task-9', label: 'A task over there', command: { id: 'tasks.reveal', args: { task: 'task-9' } } },
  ];

  it('names the machine its rows live on', async () => {
    const view = mount(<ViewDock views={bridge(REMOTE, [], rows)} />);
    await settle();

    // On the ROW, not over a section: there is one list, and each row says
    // where it lives.
    expect(one(view.container, 'view-row-host').textContent).toBe('Mac B');
    expect(one(view.container, 'view-row').getAttribute('data-host')).toBe('mac-b');
    view.unmount();
  });

  it('says nothing about a view that lives on this Mac', async () => {
    const local: ViewContributionDTO[] = [
      { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
    ];
    const view = mount(<ViewDock views={bridge(local, [], rows)} />);
    await settle();

    expect(all(view.container, 'view-row-host')).toHaveLength(0);
    view.unmount();
  });

  /**
   * The verb goes back with the QUALIFIED type, which is how main knows which
   * member to send it to. A dock that stripped it would run a remote row's verb
   * on this machine — the exact confusion the label exists to prevent, one layer
   * down where no label can help.
   */
  it('sends a row verb back tagged with the member it came from', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(REMOTE, calls, rows)} />);
    await settle();

    one(view.container, 'view-row').click();
    await settle();

    expect(calls[0]?.type).toBe('mac-b∷tasks.tree');
    expect(calls[0]?.command).toBe('tasks.reveal');
    view.unmount();
  });
});

/**
 * The whole point of a net, seen in the sidebar: one body of work.
 *
 * Two Macs contribute the same list; a reader should see one list with each row
 * labelled, not two lists to reconcile — and a task that finished over there
 * belongs in the same DONE as one that finished here.
 */
describe('one list across members', () => {
  const BOTH: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
    {
      extension: 'shepherd.tasks',
      type: 'mac-b∷tasks.tree',
      kind: 'tree',
      remote: { memberId: 'mac-b', name: 'Mac B' },
    },
  ];

  function bridgeFor(rowsByType: Record<string, readonly TreeItem[]>): ViewsApi {
    return {
      list: () => Promise.resolve({ ok: true, value: BOTH }),
      children: (type: string) => Promise.resolve({ ok: true, value: rowsByType[type] ?? [] }),
      activate: () => Promise.resolve({ ok: true, value: undefined }),
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      onChanged: () => () => {},
    };
  }

  it('draws one section, with both machines’ rows under one DONE', async () => {
    const view = mount(
      <ViewDock
        views={bridgeFor({
          'tasks.tree': [
            { id: 'here-1', label: 'Local task' },
            { id: 'd', label: 'DONE', section: true },
            { id: 'here-2', label: 'Local finished' },
          ],
          'mac-b∷tasks.tree': [
            { id: 'there-1', label: 'Remote task' },
            { id: 'd', label: 'DONE', section: true },
            { id: 'there-2', label: 'Remote finished' },
          ],
        })}
      />,
    );
    await settle();

    // One heading, not one per machine.
    expect(all(view.container, 'view-group')).toHaveLength(1);
    // Live work from both, then finished work from both — one list, in one order.
    const drawn = all(view.container, 'view-row');
    expect(drawn.map((row) => row.getAttribute('data-row-id'))).toEqual([
      'here-1',
      'there-1',
      'here-2',
      'there-2',
    ]);
    // …and only the rows that live elsewhere say so.
    expect(drawn.map((row) => row.getAttribute('data-host'))).toEqual([null, 'mac-b', null, 'mac-b']);
    view.unmount();
  });
});
