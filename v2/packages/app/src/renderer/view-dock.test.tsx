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
  readonly type: string;
  readonly command: string;
  readonly args: unknown;
}

function bridge(
  views: readonly ViewContributionDTO[],
  calls: Call[] = [],
  rows: readonly TreeItem[] = [],
): ViewsApi {
  return {
    list: () => Promise.resolve({ ok: true, value: views }),
    children: () => Promise.resolve({ ok: true, value: rows }),
    activate: () => Promise.resolve({ ok: true, value: undefined }),
    invoke: (type, command, args) => {
      calls.push({ type, command, args });
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

    expect(calls).toEqual([{ type: 'diagnostics.card', command: 'diagnostics.bump', args: undefined }]);
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
