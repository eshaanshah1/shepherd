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
    expect(views.list()).toEqual([{ extension: 'shepherd.tasks', type: 'tasks.tree', kind: 'tree' }]);
  });

  it('carries the KIND and the UI module name, because the renderer draws from them', () => {
    // A component view is a name the renderer resolves (ADR 0033). If the kind
    // did not survive registration, the dock would ask the child for a
    // component's "rows" and draw an empty tree where a form should be.
    const views = registry();
    views.register('shepherd.tasks', 'tasks.composer', 'component', 'tasks.composer');
    expect(views.list()).toEqual([
      { extension: 'shepherd.tasks', type: 'tasks.composer', kind: 'component', component: 'tasks.composer' },
    ]);
  });

  it('never asks the child for a component view’s children', async () => {
    // There is no provider to ask — the component lives in the page. Waking the
    // extension for a question it cannot answer is how a "why is this extension
    // being polled" mystery starts.
    const reads: string[] = [];
    const views = new ViewRegistry({
      read: (extension, type) => {
        reads.push(`${extension}:${type}`);
        return Promise.resolve([]);
      },
      invoke: () => Promise.resolve(undefined),
      publish: () => {},
    });
    views.register('shepherd.tasks', 'tasks.composer', 'component', 'tasks.composer');
    expect(await views.children('tasks.composer', undefined)).toEqual([]);
    expect(reads).toEqual([]);
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

    it('attributes a COMPONENT’s invoke the same way, and hands back the answer', async () => {
      // The second caller of the attribution rule (ADR 0033). It has to be the
      // same path: a form that ran its command a second way is where
      // `{kind:'user'}` would quietly come back, and this one carries a return
      // value, which is the reason it exists at all.
      const seen: unknown[] = [];
      const views = new ViewRegistry({
        read: async () => [],
        invoke: (command, args, caller) => {
          seen.push({ command, args, caller });
          return Promise.resolve({ ok: true, value: { slug: 'a-task' } });
        },
        publish: () => undefined,
      });
      views.register('shepherd.tasks', 'tasks.composer', 'component', 'tasks.composer');
      const answer = await views.invoke('tasks.composer', 'tasks.create', { title: 'a task' });

      expect(seen).toEqual([
        {
          command: 'tasks.create',
          args: { title: 'a task' },
          caller: { kind: 'extension', id: 'shepherd.tasks' },
        },
      ]);
      expect(answer).toEqual({ ok: true, value: { slug: 'a-task' } });
    });

    it('runs nothing for a component view nobody owns, and says so with undefined', async () => {
      const seen: string[] = [];
      const views = new ViewRegistry({
        read: async () => [],
        invoke: (command) => {
          seen.push(command);
          return Promise.resolve();
        },
        publish: () => undefined,
      });
      expect(await views.invoke('ghost.composer', 'tasks.create')).toBeUndefined();
      expect(seen).toEqual([]);
    });
  });
});
