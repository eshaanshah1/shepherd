// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { ViewDock, markState } from './view-dock.tsx';
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
  readonly via: 'activate' | 'invoke' | 'present';
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
    present: (type, presents) => {
      calls.push({ via: 'present', type, command: presents.id, args: presents.args });
      return Promise.resolve({ ok: true, value: { shown: true } });
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
      present: () => Promise.resolve({ ok: true, value: { shown: false } }),
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

  it('draws a row’s primary action, named, and nothing for a row without one', async () => {
    // `Row` has had a hover slot since it shipped (its rule 4); what was missing
    // was any way for a CONTRIBUTED row to declare into it.
    const rows: readonly TreeItem[] = [
      {
        id: 't1',
        label: 'One',
        primaryAction: { id: 'tasks.archive', label: 'Ship', icon: 'ship', args: { task: 't1' } },
      },
      { id: 't2', label: 'Two' },
    ];
    const view = mount(<ViewDock views={bridge(TREE, [], rows)} />);
    await settle();
    const buttons = all(view.container, 'row-primary-action');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Ship');
    view.unmount();
  });

  it('runs a primary action as the extension, and NOT the row underneath it', async () => {
    // D14, and the containment rule: the click is the user's, the command id is
    // the extension's — and a control inside a clickable row must not fire both.
    const calls: Call[] = [];
    const rows: readonly TreeItem[] = [
      {
        id: 't1',
        label: 'One',
        command: { id: 'tasks.reveal', args: { task: 't1' } },
        primaryAction: { id: 'tasks.archive', label: 'Ship', args: { task: 't1' } },
      },
    ];
    const view = mount(<ViewDock views={bridge(TREE, calls, rows)} />);
    await settle();
    act(() => one(view.container, 'row-primary-action').click());
    await settle();
    expect(calls).toEqual([
      { via: 'activate', type: 'tasks.tree', command: 'tasks.archive', args: { task: 't1' } },
    ]);
    view.unmount();
  });

  /**
   * A verb a row asked us to CONFIRM.
   *
   * The shell asks and the extension writes the question, which is ADR 0031's
   * rule arriving at one more door: only the extension can tell whether THIS
   * invocation is the risky one — `tasks` marks Ship only when an agent is
   * mid-turn — and only the shell has a surface to ask on.
   */
  describe('a verb that asks to be confirmed', () => {
    const guarded: readonly TreeItem[] = [
      {
        id: 't1',
        label: 'One',
        command: { id: 'tasks.reveal', args: { task: 't1' } },
        primaryAction: {
          id: 'tasks.archive',
          label: 'Ship',
          args: { task: 't1' },
          confirm: 'This stops its agent mid-turn.',
        },
      },
    ];

    it('runs nothing until the question is answered', async () => {
      const calls: Call[] = [];
      const view = mount(<ViewDock views={bridge(TREE, calls, guarded)} />);
      await settle();
      act(() => one(view.container, 'row-primary-action').click());
      await settle();

      expect(calls).toEqual([]);
      expect(document.body.textContent).toContain('This stops its agent mid-turn.');
      view.unmount();
    });

    it('runs it once confirmed, attributed exactly as an unguarded verb is', async () => {
      const calls: Call[] = [];
      const view = mount(<ViewDock views={bridge(TREE, calls, guarded)} />);
      await settle();
      act(() => one(view.container, 'row-primary-action').click());
      await settle();

      const confirmButton = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Ship',
      );
      act(() => confirmButton?.click());
      await settle();

      expect(calls).toEqual([
        { via: 'activate', type: 'tasks.tree', command: 'tasks.archive', args: { task: 't1' } },
      ]);
      view.unmount();
    });

    it('runs nothing when cancelled', async () => {
      const calls: Call[] = [];
      const view = mount(<ViewDock views={bridge(TREE, calls, guarded)} />);
      await settle();
      act(() => one(view.container, 'row-primary-action').click());
      await settle();

      const cancel = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel',
      );
      act(() => cancel?.click());
      await settle();

      expect(calls).toEqual([]);
      view.unmount();
    });

    it('asks nothing for a verb that declared no confirm', async () => {
      // The default has to stay instant: shipping is the gesture made most, and a
      // dialog on all of it is one nobody reads by the third time.
      const calls: Call[] = [];
      const plain: readonly TreeItem[] = [
        { id: 't1', label: 'One', primaryAction: { id: 'tasks.archive', label: 'Ship', args: { task: 't1' } } },
      ];
      const view = mount(<ViewDock views={bridge(TREE, calls, plain)} />);
      await settle();
      act(() => one(view.container, 'row-primary-action').click());
      await settle();

      expect(calls).toHaveLength(1);
      view.unmount();
    });
  });

  it('draws NO mark for a row that declares no tint', async () => {
    /*
     * A row with no state has none to draw. This defaulted to the resting ring,
     * which put "nothing is happening here" on things that are not tasks — the
     * `Show all 27` control under the Shipped divider drew a shipped CHECK, and
     * the diagnostics demo's `click me` row drew a ring.
     */
    const rows: readonly TreeItem[] = [
      { id: 'control', label: 'Show all 27', command: { id: 'tasks.expandTabs' } },
      { id: 'task', label: 'A task', tint: 'idle' },
    ];
    const view = mount(<ViewDock views={bridge(TREE, [], rows)} />);
    await settle();

    const drawn = all(view.container, 'view-row').map(
      (row) => row.querySelector('.sh-ui-mark') !== null,
    );
    expect(drawn).toEqual([false, true]);
    view.unmount();
  });

  it('keeps a row selected while the window is on ANOTHER TAB of its group', async () => {
    // A task's row names its anchor root; its second tab is a different root in
    // the same group. Comparing root ids alone would blank the highlight the
    // moment you switched tabs — you are still looking at that task.
    const rows: readonly TreeItem[] = [
      { id: 'task-1', label: 'One', root: 'task:task-1' },
      { id: 'task-2', label: 'Two', root: 'task:task-2' },
    ];
    const groupOfRoot = (root: string) => root.split('/')[0] ?? root;
    const view = mount(
      <ViewDock views={bridge(TREE, [], rows)} activeRoot="task:task-1/tab-2" groupOfRoot={groupOfRoot} />,
    );
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
 * The foot: the row a contribution DECLARES as the foot, and everything under it.
 *
 * The rule it replaces guessed — everything after the last heading — and the
 * guess was reported from the running app: `tasks` ends on a `Resting` heading
 * with a plain count row beneath it, so its LIVE resting tasks were the thing
 * pinned to the bottom of the window while `In flight` floated above the gap.
 * A position an extension states cannot be wrong about which group is finished.
 *
 * The cap is the second rule, and it is unchanged: finished work cannot push
 * live work off the screen.
 */
describe('a contribution-s tint word, resolved to a mark', () => {
  it('knows the word tasks actually writes for finished work', () => {
    /*
     * `archived`, not `done`. `displayState` returns the LIFECYCLE value for a
     * finished task and `done` is written by nothing — so this table missed, the
     * row fell to the default, and every task in the Shipped drawer drew a
     * hollow RING: the drawer of finished work said nothing in it had finished.
     */
    expect(markState('archived')).toBe('shipped');
    expect(markState('done')).toBe('shipped');
  });

  it('still answers resting for a word it does not know', () => {
    // A tint the shell has never seen is not an emergency, and a ring is the
    // mark that claims nothing.
    expect(markState('whatever-the-next-extension-says')).toBe('resting');
    expect(markState(undefined)).toBe('resting');
  });
});

describe('the dock-s foot group', () => {
  const TREE: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
  ];

  /** A live section, then the declared foot row and the finished tasks under it. */
  /*
   * The task rows carry a `tint`, because a real one always does — a row with no
   * tint declares no state and the shell now draws no mark for it. Without one
   * here, "an ordinary row still has a mark" below would be asserting against an
   * under-specified fixture rather than against the treatment.
   */
  const shipped = (n: number): readonly TreeItem[] => [
    { id: 'group:resting', label: 'Resting', section: true },
    { id: 'live', label: 'Still going', tint: 'idle' },
    { id: 'tasks.shipped', label: 'Shipped this week', description: String(n), foot: true },
    ...Array.from({ length: n }, (_, i) => ({ id: `t${String(i)}`, label: `Task ${String(i)}`, tint: 'archived' })),
  ];

  it('draws a heading that is the first row, rather than dropping it', async () => {
    const view = mount(
      <ViewDock views={bridge(TREE, [], [{ id: 'group:done', label: 'DONE', section: true }, { id: 't0', label: 'Task 0' }])} />,
    );
    await settle();
    expect(all(view.container, 'view-group').map((el) => el.textContent)).toEqual(['DONE']);
    view.unmount();
  });

  it('pins the declared foot row and what follows it, and NOTHING above it', async () => {
    const view = mount(<ViewDock views={bridge(TREE, [], shipped(2))} />);
    await settle();
    const foot = view.container.querySelector('.sh-rows-foot');
    expect(foot).not.toBeNull();
    // `textContent` carries the state mark's accessible word too (§3 — every
    // mark says its state), so this reads the label rather than the whole row.
    const inFoot = all(view.container, 'view-row')
      .filter((row) => foot?.contains(row) === true)
      .map((row) => row.querySelector('.sh-ui-row__label')?.textContent);
    expect(inFoot).toEqual(['Shipped this week', 'Task 0', 'Task 1']);
    // The live half stays where the list put it — this is the whole report.
    expect(foot?.contains(one(view.container, 'view-group'))).toBe(false);
    view.unmount();
  });

  it('leaves a tree that declares no foot entirely in the top list', async () => {
    // A last heading is not a claim about being finished, so it pins nothing.
    const view = mount(
      <ViewDock views={bridge(TREE, [], [{ id: 'group:resting', label: 'Resting', section: true }, { id: 'live', label: 'Still going' }])} />,
    );
    await settle();
    expect(view.container.querySelector('.sh-rows-foot')).toBeNull();
    view.unmount();
  });

  /**
   * The foot is a DRAWER HANDLE, and the count is what it says.
   *
   * Both halves shipped wrong together: the row drew a state mark (a check, in
   * the 12px slot, on a thing that is not a task) and its `description` reached
   * the DOM as a `title` attribute — so the count the extension calls "the
   * content" was invisible, and the row read as a sixth task in the list.
   */
  it('draws the foot-s count and a chevron rather than a state mark', async () => {
    const view = mount(<ViewDock views={bridge(TREE, [], shipped(2))} />);
    await settle();
    const foot = view.container.querySelector('[data-row-id="tasks.shipped"]');
    expect(foot?.querySelector('.sh-ui-row__meta')?.textContent).toBe('2');
    // No mark in the leading slot — `StateMark` is the only thing that draws
    // `.sh-ui-mark`, so asking for one asks whether that slot holds a STATE.
    expect(foot?.querySelector('.sh-ui-mark')).toBeNull();
    // …and an ordinary row still has one, which is what makes the foot's
    // absence a treatment rather than a regression.
    expect(
      view.container.querySelector('[data-row-id="t0"] .sh-ui-mark'),
    ).not.toBeNull();
    view.unmount();
  });

  it('reports whether the drawer is open, and only when it opens something', async () => {
    const shut = mount(<ViewDock views={bridge(TREE, [], shipped(2))} />);
    await settle();
    // No `collapsed` on the row: a foot that opens nothing is an ordinary row,
    // and promising an expansion nothing performs is the affordance lie.
    const plain = shut.container.querySelector('[data-row-id="tasks.shipped"]');
    expect(plain).not.toBeNull();
    expect(plain?.getAttribute('aria-expanded')).toBeNull();
    // No chevron either — but the count and the quiet treatment stay, because
    // those are what being the FOOT means and neither depends on opening.
    expect(plain?.querySelector('.sh-ui-row__leading svg')).toBeNull();
    expect(plain?.querySelector('.sh-ui-row__meta')?.textContent).toBe('2');
    shut.unmount();

    const rows = shipped(2).map((row) =>
      row.id === 'tasks.shipped' ? { ...row, collapsed: false } : row,
    );
    const open = mount(<ViewDock views={bridge(TREE, [], rows)} />);
    await settle();
    const drawer = open.container.querySelector('[data-row-id="tasks.shipped"]');
    expect(drawer?.getAttribute('aria-expanded')).toBe('true');
    expect(drawer?.querySelector('.sh-ui-row__leading svg')).not.toBeNull();
    open.unmount();
  });

  it('scrolls the finished rows and leaves the foot row outside the scroller', async () => {
    // A "Shipped this week" that scrolls away leaves a list of finished tasks
    // with nothing saying what they are — so the cap is on the rows under it.
    const view = mount(<ViewDock views={bridge(TREE, [], shipped(9))} />);
    await settle();
    const scroller = view.container.querySelector('.sh-rows-foot-scroll');
    expect(scroller).not.toBeNull();
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
    {
      id: 'task-9',
      label: 'A task over there',
      command: { id: 'tasks.reveal', args: { task: 'task-9' } },
      presents: { id: 'tasks.presentation', args: { task: 'task-9' } },
    },
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
   *
   * And it is the row's `presents` verb, through `present` — **never its
   * `command`, through `activate`.** A task's `command` is `tasks.reveal`, which
   * opens a pane and switches the window on whichever machine runs it: sent
   * across the net it moves the OTHER Mac's screen and leaves this one showing
   * nothing. `presents` answers what the row stands for and performs nothing, so
   * this Mac can open a viewer of that session itself.
   */
  it('asks a remote row what it stands for, and never runs its gesture', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(REMOTE, calls, rows)} />);
    await settle();

    one(view.container, 'view-row').click();
    await settle();

    expect(calls[0]?.via).toBe('present');
    expect(calls[0]?.type).toBe('mac-b∷tasks.tree');
    expect(calls[0]?.command).toBe('tasks.presentation');
    // The negative control, and the whole point: `tasks.reveal` was NOT sent.
    expect(calls.map((call) => call.command)).not.toContain('tasks.reveal');
    view.unmount();
  });

  /**
   * A row that cannot say what it stands for is left alone.
   *
   * Falling back to `command` would be the defect above, reached by a different
   * door — and it would fire on exactly the rows nobody thought about.
   */
  it('does nothing at all for a remote row with no presents verb', async () => {
    const calls: Call[] = [];
    const bare: readonly TreeItem[] = [
      { id: 'task-9', label: 'A task over there', command: { id: 'tasks.reveal' } },
    ];
    const view = mount(<ViewDock views={bridge(REMOTE, calls, bare)} />);
    await settle();

    one(view.container, 'view-row').click();
    await settle();

    expect(calls).toEqual([]);
    view.unmount();
  });

  /** A LOCAL row still runs its own gesture — the control for the two above. */
  it('runs a local row’s command exactly as before', async () => {
    const calls: Call[] = [];
    const local: ViewContributionDTO[] = [
      { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
    ];
    const view = mount(<ViewDock views={bridge(local, calls, rows)} />);
    await settle();

    one(view.container, 'view-row').click();
    await settle();

    expect(calls[0]?.via).toBe('activate');
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
      present: () => Promise.resolve({ ok: true, value: { shown: false } }),
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

/**
 * A list that grows, rather than one that is swapped.
 *
 * Every contributed tree is re-read whole — `views.children` answers rows and the
 * dock never patches them — so without a mark on the new ones a task appearing is
 * one paint with N rows and the next with N+1. React keeps the surviving rows'
 * DOM because they are keyed; all that is missing is knowing which are new.
 */
describe('rows arriving', () => {
  const LOCAL: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
  ];

  function growing(rows: { current: readonly TreeItem[] }): ViewsApi {
    let notify: (type: string) => void = () => {};
    return {
      list: () => Promise.resolve({ ok: true, value: LOCAL }),
      children: () => Promise.resolve({ ok: true, value: rows.current }),
      activate: () => Promise.resolve({ ok: true, value: undefined }),
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      present: () => Promise.resolve({ ok: true, value: { shown: false } }),
      onChanged: (listener) => {
        notify = listener;
        // The dock re-reads on a nudge; handing the trigger back is how the test
        // makes the SECOND read happen the way the app does.
        (globalThis as { __nudge?: () => void }).__nudge = () => notify('tasks.tree');
        return () => {};
      },
    };
  }

  const entering = (container: HTMLElement): string[] =>
    all(container, 'view-row')
      .filter((el) => el.className.includes('sh-ui-row--entering'))
      .map((el) => el.getAttribute('data-row-id') ?? '');

  it('marks only the row that is new, and nothing on the first list', async () => {
    const rows = { current: [{ id: 'a', label: 'One' }] as readonly TreeItem[] };
    const view = mount(<ViewDock views={growing(rows)} />);
    await settle();

    // Nothing flies in on the first paint: everything is new then, and a sidebar
    // that animates on every launch is a sidebar you wait for.
    expect(entering(view.container)).toEqual([]);

    rows.current = [
      { id: 'a', label: 'One' },
      { id: 'b', label: 'Two' },
    ];
    (globalThis as { __nudge?: () => void }).__nudge?.();
    await settle();

    // The new row only. A list that marked every row on every re-read would be
    // the wholesale swap again, with an animation on top.
    expect(entering(view.container)).toEqual(['b']);
    view.unmount();
  });
});

/**
 * The search field the dock draws — and the half it deliberately does NOT do.
 *
 * It holds the text and sends it. It does not filter: the rows it has are the rows
 * the extension chose to send, so a page-side filter could not reach a shipped task
 * past `tasks`' cap and could not open a match to its tabs. Those assertions live in
 * the extension's own suite; these pin the seam.
 */
describe('the dock-s search field', () => {
  const SEARCHABLE: ViewContributionDTO[] = [
    {
      extension: 'shepherd.tasks',
      type: 'tasks.tree',
      kind: 'tree',
      search: { command: 'tasks.filter', placeholder: 'Search' },
    },
  ];
  const PLAIN: ViewContributionDTO[] = [
    { extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' },
  ];

  /** The debounce, plus a beat. */
  async function typed(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  }

  /**
   * Type into a CONTROLLED input.
   *
   * Assigning `.value` and firing `input` does not reach React — it tracks the
   * value itself and sees no change — so the write goes through the prototype's
   * own setter. Same helper `settings-screen` and `command-palette` already use.
   */
  function typeInto(field: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const fieldOf = (view: { container: HTMLElement }): HTMLInputElement | null =>
    view.container.querySelector('[data-testid="dock-search"]');

  it('draws a field only for a view that asked for one', async () => {
    const withField = mount(<ViewDock views={bridge(SEARCHABLE, [], [])} />);
    await settle();
    expect(fieldOf(withField)).not.toBeNull();
    withField.unmount();

    const without = mount(<ViewDock views={bridge(PLAIN, [], [])} />);
    await settle();
    expect(fieldOf(without)).toBeNull();
    without.unmount();
  });

  it('uses the placeholder the view declared, since the shell has no word for it', async () => {
    const view = mount(<ViewDock views={bridge(SEARCHABLE, [], [])} />);
    await settle();
    expect(fieldOf(view)?.getAttribute('placeholder')).toBe('Search');
    view.unmount();
  });

  it('sends what was typed to the declared command, as the extension', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(SEARCHABLE, calls, [])} />);
    await settle();

    typeInto(fieldOf(view) as HTMLInputElement, 'login');
    await typed();

    expect(calls).toContainEqual({
      via: 'activate',
      type: 'tasks.tree',
      command: 'tasks.filter',
      args: { query: 'login' },
    });
    view.unmount();
  });

  it('debounces, so a typed word is not one re-read per character', async () => {
    // Every change ends in a full tree re-read across the port.
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(SEARCHABLE, calls, [])} />);
    await settle();

    const field = fieldOf(view) as HTMLInputElement;
    for (const text of ['l', 'lo', 'log', 'logi', 'login']) typeInto(field, text);
    await typed();

    const queries = calls.filter((call) => call.command === 'tasks.filter').map((call) => call.args);
    expect(queries).toContainEqual({ query: 'login' });
    expect(queries.length).toBeLessThan(5);
    view.unmount();
  });

  it('clears on Escape, because a field you cannot empty leaves the rail filtered', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(SEARCHABLE, calls, [])} />);
    await settle();

    const field = fieldOf(view) as HTMLInputElement;
    typeInto(field, 'login');
    await typed();
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await typed();

    expect(calls.filter((call) => call.command === 'tasks.filter').at(-1)?.args).toEqual({ query: '' });
    view.unmount();
  });

  it('clears the query when it goes away, so nothing stays filtered by a field nobody can see', async () => {
    const calls: Call[] = [];
    const view = mount(<ViewDock views={bridge(SEARCHABLE, calls, [])} />);
    await settle();

    typeInto(fieldOf(view) as HTMLInputElement, 'login');
    await typed();
    view.unmount();
    await settle();

    const last = calls.filter((call) => call.command === 'tasks.filter').at(-1);
    expect(last?.args).toEqual({ query: '' });
  });
});
