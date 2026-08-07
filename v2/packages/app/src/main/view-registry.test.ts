import { describe, expect, it } from 'vitest';
import { ViewRegistry } from './view-registry.ts';

/**
 * What main knows about a contributed view — and the one thing it must refuse.
 */

const registry = (): ViewRegistry =>
  new ViewRegistry({
    read: async (extension, type) => [{ id: `${extension}:${type}`, label: 'row' }],
    invoke: () => Promise.resolve(),
    publish: () => undefined,
  });

describe('ViewRegistry', () => {
  it('records a contribution against the extension that made it', () => {
    const views = registry();
    views.register('shepherd.tasks', 'tasks.tree');
    expect(views.list()).toEqual([{ extension: 'shepherd.tasks', type: 'tasks.tree' }]);
  });

  it('forgets everything an extension contributed when it goes', () => {
    // An extension host restart leaves rows on screen that nothing can refresh —
    // the same "confident lie" the agent relay clears its indicators for.
    const views = registry();
    views.register('shepherd.tasks', 'tasks.tree');
    views.forget('shepherd.tasks');
    expect(views.list()).toEqual([]);
  });

  it('reads a tree through the owner that registered it', async () => {
    const views = registry();
    views.register('shepherd.tasks', 'tasks.tree');
    expect(await views.children('tasks.tree', undefined)).toEqual([
      { id: 'shepherd.tasks:tasks.tree', label: 'row' },
    ]);
  });

  it('returns nothing for a view type nobody registered', async () => {
    expect(await registry().children('ghost.tree', undefined)).toEqual([]);
  });

  describe('D14 — a row click may not launder a command through the user', () => {
    it('invokes a row command as the CONTRIBUTING EXTENSION, never as the user', async () => {
      // `authorize` returns an unconditional ALLOW for `{kind:'user'}`, so
      // attributing a click that way would let any extension that can contribute
      // a tree run any command with full trust — including ones its own grant
      // denies. The user clicked a ROW; they did not choose the command id, and
      // they cannot see it.
      const seen: { command: string; caller: unknown }[] = [];
      const views = new ViewRegistry({
        read: async () => [],
        invoke: (command, args, caller) => {
          seen.push({ command, caller });
          return Promise.resolve();
        },
        publish: () => undefined,
      });
      views.register('shepherd.tasks', 'tasks.tree');

      await views.activate('tasks.tree', { id: 'layout.close', args: { pane: 'p1' } });

      expect(seen).toEqual([
        { command: 'layout.close', caller: { kind: 'extension', id: 'shepherd.tasks' } },
      ]);
      expect(JSON.stringify(seen)).not.toContain('"user"');
    });

    it('refuses a click on a view type nobody owns, rather than guessing a caller', async () => {
      const seen: string[] = [];
      const views = new ViewRegistry({
        read: async () => [],
        invoke: (command) => {
          seen.push(command);
          return Promise.resolve();
        },
        publish: () => undefined,
      });
      await views.activate('ghost.tree', { id: 'layout.close' });
      expect(seen).toEqual([]);
    });
  });
});
