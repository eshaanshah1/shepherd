import { describe, expect, it } from 'vitest';
import { CommandRegistry, emptyGrants } from '@shepherd/core';
import { LayoutStore, registerLayoutCommands } from '@shepherd/core/layout';
import { nullLogger, rootId, systemClock, type RootID, type SessionID } from '@shepherd/sdk';
import { COMMANDS } from '../shared/index.ts';
import { menuDispatcher } from './menu-dispatch.ts';

/**
 * A menu click, all the way to the tree.
 *
 * Driven through a REAL `CommandRegistry` and a REAL `LayoutStore`, because the
 * claim P4a makes is not "the dispatcher calls invoke" — it is that clicking ⌘D
 * and typing `shepherd pane split` reach the same handler and produce the same
 * tree. A fake registry would assert the first and say nothing about the second.
 */

const ROOT = rootId('window-1');

function harness() {
  const killed: SessionID[] = [];
  const closedRoots: RootID[] = [];
  const failures: Array<{ command: string; message: string }> = [];

  const registry = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
  const store = new LayoutStore({
    logger: nullLogger,
    clock: systemClock,
    sessions: { kill: (id) => void killed.push(id), isLive: () => true },
  });
  registerLayoutCommands({
    store,
    registry,
    homeRoot: ROOT,
    // One root here, and it is the one the menu means — which is the whole
    // claim: a menu item names no root and still reaches the right one.
    activeRoot: () => ROOT,
    onSwitchRoot: () => undefined,
    onLastPaneClosed: (root) => void closedRoots.push(root),
  });
  store.open(ROOT);

  const dispatch = menuDispatcher(registry, (command, message) =>
    failures.push({ command, message }),
  );
  // `invoke` is async, so a click has to be awaited before the tree is read.
  const click = async (id: Parameters<typeof dispatch>[0]): Promise<void> => {
    dispatch(id);
    await Promise.resolve();
    await Promise.resolve();
  };

  return { registry, store, dispatch, click, killed, closedRoots, failures };
}

describe('menuDispatcher', () => {
  it('⌘D splits the focused pane side by side, in the store main owns', async () => {
    const h = harness();
    expect(h.store.panes(ROOT)).toHaveLength(1);

    await h.click(COMMANDS.splitRight);

    expect(h.store.panes(ROOT)).toHaveLength(2);
    const tree = h.store.tree(ROOT);
    expect(tree?.kind).toBe('split');
    if (tree?.kind === 'split') expect(tree.axis).toBe('row');
    expect(h.failures).toEqual([]);
  });

  it('⌘⇧D stacks them — the other half of the invertible pair', async () => {
    const h = harness();
    await h.click(COMMANDS.splitDown);
    const tree = h.store.tree(ROOT);
    expect(tree?.kind === 'split' && tree.axis).toBe('column');
  });

  it('⌘W closes the focused pane and only the LAST one reaches the window', async () => {
    const h = harness();
    await h.click(COMMANDS.splitRight);
    expect(h.store.panes(ROOT)).toHaveLength(2);

    await h.click(COMMANDS.closePane);
    expect(h.store.panes(ROOT)).toHaveLength(1);
    // The classic Electron bug this guards: a split vanishing because one pane
    // was closed.
    expect(h.closedRoots).toEqual([]);

    await h.click(COMMANDS.closePane);
    expect(h.closedRoots).toEqual([ROOT]);
  });

  it('⌘⌥← moves focus using the viewport the renderer pushed', async () => {
    const h = harness();
    await h.click(COMMANDS.splitRight);
    const [left, right] = h.store.panes(ROOT);
    expect(h.store.focused(ROOT)).toBe(right);

    // Without this the rect is 0×0, every frame is degenerate, and `neighbor`
    // answers null for every direction — the exact failure a missing viewport
    // push produces, so it is worth seeing both sides of.
    h.dispatch(COMMANDS.focusLeft);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.store.focused(ROOT)).toBe(right);
    expect(h.failures).toEqual([]); // an edge is not an error

    h.store.setViewport(ROOT, { x: 0, y: 0, width: 1000, height: 600 });
    await h.click(COMMANDS.focusLeft);
    expect(h.store.focused(ROOT)).toBe(left);
  });

  it('reports a failure instead of a menu item that silently did nothing', async () => {
    const h = harness();
    // A registry with the layout commands removed is the realistic shape of this:
    // a menu whose kernel half failed to register.
    const bare = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
    const failures: Array<{ command: string; message: string }> = [];
    const dispatch = menuDispatcher(bare, (command, message) =>
      failures.push({ command, message }),
    );

    dispatch(COMMANDS.splitRight);
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.command).toBe(COMMANDS.splitRight);
    expect(failures[0]?.message).toContain('layout.split');
    // …and the negative control: the wired one reports nothing.
    await h.click(COMMANDS.splitRight);
    expect(h.failures).toEqual([]);
  });

  it('never throws at the click, whatever the command does', async () => {
    // AppKit calls this from a menu handler. A throw here is an unhandled
    // rejection in main, and the app's own menu is the last place that is
    // acceptable — the registry is the thing that turns failure into a value.
    const bare = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
    bare.register('layout.split', {
      schema: { describe: 'any', parse: (value) => ({ ok: true, value }) },
      handler: () => {
        throw new Error('boom');
      },
    });
    const failures: string[] = [];
    const dispatch = menuDispatcher(bare, (_command, message) => failures.push(message));

    expect(() => dispatch(COMMANDS.splitRight)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures[0]).toContain('boom');
  });
});
