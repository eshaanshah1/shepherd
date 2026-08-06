// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  frames,
  leaf,
  makePane,
  neighbor,
  split,
  type Pane,
  type SplitNode,
} from '@shepherd/core/layout';
import { COMMANDS, type CommandID, type CommandsApi, type WindowApi } from '../shared/index.ts';
import { App } from './app.tsx';
import type { PaneDiagnostics, PaneTerminals } from './pane-sessions.ts';
import { all, mount, one, withFixedLayout } from './test-dom.ts';

/**
 * The command handlers as the app actually runs them: a menu command arriving
 * over the bridge, through `runCommand`, out to the registry and the window.
 *
 * This is where the negative control for the lifecycle guard lives at the app
 * level — `close` reaches the registry from exactly one gesture, and every
 * other lifecycle event reaches only `detach`.
 */

interface SpyTerminals extends PaneTerminals {
  readonly calls: Array<{ name: string; paneId: string }>;
}

function spyTerminals(): SpyTerminals {
  const calls: Array<{ name: string; paneId: string }> = [];
  return {
    calls,
    attach: (pane) => calls.push({ name: 'attach', paneId: pane.id }),
    detach: (paneId) => calls.push({ name: 'detach', paneId }),
    close: (paneId) => calls.push({ name: 'close', paneId }),
    focus: (paneId) => calls.push({ name: 'focus', paneId }),
    fit: (paneId) => calls.push({ name: 'fit', paneId }),
    inspect: (): PaneDiagnostics | undefined => undefined,
  };
}

function spyCommands(): CommandsApi & { fire(command: CommandID): void; listeners: number } {
  let listeners: Array<(m: { command: CommandID }) => void> = [];
  return {
    get listeners() {
      return listeners.length;
    },
    onCommand: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    fire: (command) => {
      act(() => {
        for (const listener of [...listeners]) listener({ command });
      });
    },
  };
}

function spyWindow(): WindowApi & { closes: number } {
  let closes = 0;
  return {
    get closes() {
      return closes;
    },
    close: () => {
      closes += 1;
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

function threePaneTree(): { tree: SplitNode; left: Pane; topRight: Pane; bottomRight: Pane } {
  const left = makePane({ userTitle: 'left' });
  const topRight = makePane({ userTitle: 'top-right' });
  const bottomRight = makePane({ userTitle: 'bottom-right' });
  return {
    tree: split('row', 0.5, leaf(left), split('column', 0.5, leaf(topRight), leaf(bottomRight))),
    left,
    topRight,
    bottomRight,
  };
}

function render(options: {
  tree?: SplitNode;
  terminals?: SpyTerminals;
  commands?: ReturnType<typeof spyCommands>;
  windowApi?: ReturnType<typeof spyWindow>;
}) {
  const terminals = options.terminals ?? spyTerminals();
  const commands = options.commands ?? spyCommands();
  const windowApi = options.windowApi ?? spyWindow();
  const view = mount(
    <App
      terminals={terminals}
      commands={commands}
      windowApi={windowApi}
      {...(options.tree === undefined ? {} : { initialTree: options.tree })}
    />,
  );
  return { view, terminals, commands, windowApi };
}

const paneIds = (container: HTMLElement): string[] =>
  all(container, 'pane').map((el) => el.dataset['paneId'] ?? '');

const focusedId = (container: HTMLElement): string | undefined =>
  all(container, 'pane').find((el) => el.dataset['focused'] === 'true')?.dataset['paneId'];

describe('App command dispatch', () => {
  it('mounts one terminal per leaf and closes none', () => {
    const { view, terminals } = render({ tree: threePaneTree().tree });

    expect(all(view.container, 'terminal-host')).toHaveLength(3);
    expect(terminals.calls.filter((c) => c.name === 'attach')).toHaveLength(3);
    expect(terminals.calls.map((c) => c.name)).not.toContain('close');
    view.unmount();
  });

  it('unmounting the whole app detaches every pane and closes none', () => {
    const { view, terminals } = render({ tree: threePaneTree().tree });
    view.unmount();

    expect(terminals.calls.filter((c) => c.name === 'detach')).toHaveLength(3);
    expect(terminals.calls.map((c) => c.name)).not.toContain('close');
  });

  it('a ⌘D command from the menu splits the focused pane side by side', () => {
    const { view, commands } = render({});
    expect(paneIds(view.container)).toHaveLength(1);

    commands.fire(COMMANDS.splitRight);

    expect(paneIds(view.container)).toHaveLength(2);
    expect(one(view.container, 'split').dataset['axis']).toBe('row');
    view.unmount();
  });

  it('a ⌘⇧D command stacks them', () => {
    const { view, commands } = render({});
    commands.fire(COMMANDS.splitDown);

    expect(one(view.container, 'split').dataset['axis']).toBe('column');
    view.unmount();
  });

  it('the toolbar button and the menu command are the same command', () => {
    const byMenu = render({});
    byMenu.commands.fire(COMMANDS.splitRight);
    const menuShape = one(byMenu.view.container, 'split').dataset['axis'];
    byMenu.view.unmount();

    const byButton = render({});
    const button = [...byButton.view.container.querySelectorAll('button')].find(
      (el) => el.textContent === 'SPLIT RIGHT',
    );
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(one(byButton.view.container, 'split').dataset['axis']).toBe(menuShape);
    byButton.view.unmount();
  });

  // ------------------------------------------------- the negative control
  it('⌘W closes the focused pane AND asks the registry to end its session', () => {
    const { tree, left, topRight, bottomRight } = threePaneTree();
    const { view, terminals, commands, windowApi } = render({ tree });
    expect(focusedId(view.container)).toBe(left.id); // focus starts on the first leaf

    commands.fire(COMMANDS.closePane);

    expect(terminals.calls.filter((c) => c.name === 'close')).toEqual([
      { name: 'close', paneId: left.id },
    ]);
    // The survivors get reshuffled by React — a pane that was a grandchild is
    // now a child, so its component unmounts and remounts. That is exactly the
    // event the v1 rewrite exists to make harmless: detach, attach, no close.
    expect(
      terminals.calls
        .filter((c) => c.paneId === topRight.id && c.name !== 'focus')
        .map((c) => c.name),
    ).toEqual(['attach', 'detach', 'attach']);
    expect(windowApi.closes).toBe(0);
    expect(paneIds(view.container)).toEqual([topRight.id, bottomRight.id]);
    expect(focusedId(view.container)).toBe(topRight.id);
    view.unmount();
  });

  it('⌘W on the LAST pane closes the window and kills nothing', () => {
    const pane = makePane({});
    const { view, terminals, commands, windowApi } = render({ tree: leaf(pane) });

    commands.fire(COMMANDS.closePane);

    expect(windowApi.closes).toBe(1);
    expect(terminals.calls.map((c) => c.name)).not.toContain('close');
    expect(paneIds(view.container)).toEqual([pane.id]);
    view.unmount();
  });

  it('⌘⌥← moves focus to the pane `neighbor` names, using the measured stage', () => {
    const restore = withFixedLayout(1000, 600);
    try {
      const { tree, left, bottomRight } = threePaneTree();
      const { view, commands } = render({ tree });
      // Put focus bottom-right first, the way a split would.
      act(() =>
        all(view.container, 'pane')[2]?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        ),
      );
      expect(focusedId(view.container)).toBe(bottomRight.id);

      commands.fire(COMMANDS.focusLeft);

      const expected = neighbor(tree, bottomRight.id, 'left', {
        x: 0,
        y: 0,
        width: 1000,
        height: 600,
      });
      expect(expected).toBe(left.id);
      expect(focusedId(view.container)).toBe(expected);
      view.unmount();
    } finally {
      restore();
    }
  });

  it('a command for a direction with no neighbour leaves focus alone', () => {
    const restore = withFixedLayout(1000, 600);
    try {
      const { tree, left } = threePaneTree();
      const { view, commands } = render({ tree });
      expect(frames(tree, { x: 0, y: 0, width: 1000, height: 600 }).get(left.id)?.x).toBe(0);

      commands.fire(COMMANDS.focusLeft);

      expect(focusedId(view.container)).toBe(left.id);
      view.unmount();
    } finally {
      restore();
    }
  });

  it('unsubscribes from the command channel on unmount', () => {
    const commands = spyCommands();
    const { view } = render({ commands });
    expect(commands.listeners).toBe(1);
    view.unmount();
    expect(commands.listeners).toBe(0);
  });
});
