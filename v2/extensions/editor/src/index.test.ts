import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate } from './index.ts';
import { EDITOR_COMMANDS, EDITOR_VIEWS } from './manifest.ts';

/**
 * A host stub: the API surfaces `activate` touches, and a registry the test
 * reads back. Enough to assert the command contract without a kernel.
 */
function host(options: { invoke?: (id: string, args?: unknown) => Promise<unknown> } = {}) {
  const registered = new Map<string, { handler: (args: never) => unknown }>();
  const views: { type: string; contribution: Record<string, unknown> }[] = [];
  const invoked: { id: string; args: unknown }[] = [];

  const api = {
    proposed: {
      commands: {
        register: (id: string, spec: { handler: (args: never) => unknown }) => {
          registered.set(id, spec);
          return { dispose: () => {} };
        },
        invoke: async (id: string, args?: unknown) => {
          invoked.push({ id, args });
          const answer = await options.invoke?.(id, args);
          return { ok: true as const, value: answer };
        },
      },
      views: {
        registerViewType: (type: string, contribution: Record<string, unknown>) => {
          views.push({ type, contribution });
          return { dispose: () => {} };
        },
      },
      process: {
        gitRead: vi.fn(async () => ({ ok: false as const, code: 128, stdout: '', stderr: '' })),
      },
      extensions: { get: () => undefined },
    },
  };
  const ctx = {
    subscriptions: [] as { dispose: () => void }[],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  activate(ctx as any, api as any);
  return { registered, views, invoked };
}

function call(
  registered: Map<string, { handler: (args: never) => unknown }>,
  id: string,
  args: unknown,
): unknown {
  const spec = registered.get(id);
  if (spec === undefined) throw new Error(`${id} was never registered`);
  return spec.handler(args as never);
}

describe('activate', () => {
  it('registers the workspace view as a PANE', () => {
    const { views } = host();
    const view = views.find((entry) => entry.type === EDITOR_VIEWS.workspace);
    expect(view).toBeDefined();
    // A place you keep open and come back to after a relaunch (ADR 0044) — not
    // a dock section and not an overlay.
    expect(view?.contribution.surface).toBe('pane');
    // The renderer resolves the TYPE against the registration, then this name
    // against its static table. Two hops, one name.
    expect(view?.contribution.component).toBe(EDITOR_VIEWS.workspace);
  });

  it('registers every command the manifest contributes', () => {
    const { registered } = host();
    for (const id of Object.values(EDITOR_COMMANDS)) {
      expect(registered.has(id)).toBe(true);
    }
  });
});

describe('editor.read and editor.write', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'editor-index-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a file through the two commands', async () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const { registered } = host();

    const read = (await call(registered, EDITOR_COMMANDS.read, { root, path: 'a.ts' })) as {
      text: string;
      stamp: { mtimeMs: number; size: number };
    };
    expect(read.text).toBe('one\n');

    const wrote = await call(registered, EDITOR_COMMANDS.write, {
      root,
      path: 'a.ts',
      text: 'two\n',
      stamp: read.stamp,
    });
    expect(wrote).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('reports a stale save as a refusal, not a throw', async () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const { registered } = host();
    const read = (await call(registered, EDITOR_COMMANDS.read, { root, path: 'a.ts' })) as {
      stamp: { mtimeMs: number; size: number };
    };
    writeFileSync(join(root, 'a.ts'), 'AGENT WROTE THIS\n');

    const wrote = await call(registered, EDITOR_COMMANDS.write, {
      root,
      path: 'a.ts',
      text: 'two\n',
      stamp: read.stamp,
    });
    // `stale` reaches the pane as a reason, because the pane has something
    // specific to do about it. An error would flatten it to "could not save".
    expect(wrote).toEqual({ ok: false, reason: 'stale' });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('AGENT WROTE THIS\n');
  });

  it('refuses a path outside the root', async () => {
    const { registered } = host();
    expect(await call(registered, EDITOR_COMMANDS.read, { root, path: '../escape.ts' })).toEqual({
      ok: false,
      reason: 'outside the root',
    });
  });
});

describe('editor.tree', () => {
  it('puts the scratchpad s notes above the files, as a Notes root', async () => {
    // A scratchpad is a document that has not chosen a path yet, so the one
    // tree listing what you can edit lists those too.
    const { registered } = host({
      invoke: async (id) =>
        id === 'scratch.list' ? { docs: [{ id: 'scr_a', title: 'Deploy checks' }] } : undefined,
    });
    const answer = (await call(registered, EDITOR_COMMANDS.tree, { root: '/repo' })) as {
      paths: readonly string[];
      notes: readonly { id: string }[];
    };
    expect(answer.paths[0]).toContain('Notes/Deploy checks');
    expect(answer.notes).toEqual([{ id: 'scr_a', title: 'Deploy checks' }]);
  });

  it('has no Notes root when scratch answers nothing', async () => {
    // A build without the scratch extension is a real state, not a failure.
    const { registered } = host();
    const answer = (await call(registered, EDITOR_COMMANDS.tree, { root: '/repo' })) as {
      paths: readonly string[];
      notes: readonly unknown[];
    };
    expect(answer.paths.some((path) => path.startsWith('Notes/'))).toBe(false);
    expect(answer.notes).toEqual([]);
  });
});

describe('editor.open', () => {
  const TASKS = [{ id: 't1', root: '/tasks/wheat', group: 'task:t1' }];

  const rootsAnswer = (over: Record<string, unknown> = {}) => [
    {
      root: 'task:t1',
      group: 'task:t1',
      active: true,
      focusedPane: 'p1',
      panes: [{ pane: 'p1', cwd: '/repo' }],
      tree: null,
      ...over,
    },
  ];

  it('opens NO TAB for the task you are in — its files are its Files face', async () => {
    /*
     * It used to open one, in the task's own pane group, beside the agents of
     * the very task whose Files face draws the same tree and the same editor.
     * Two places for one idea, and you had to know which held which.
     *
     * It still RESOLVES the task root — that is the answer to "which directory"
     * and the face needs it — and it still names where the surface is, because a
     * verb that stops working without saying what replaced it is a verb people
     * go looking for a bug in.
     */
    const { registered, invoked } = host({
      invoke: async (id) =>
        id === 'layout.listRoots' ? rootsAnswer() : id === 'tasks.list' ? TASKS : undefined,
    });
    const answer = await call(registered, EDITOR_COMMANDS.open, {});
    expect(answer).toMatchObject({ ok: true, root: '/tasks/wheat', opened: false, face: 'files' });
    expect(invoked.find((entry) => entry.id === 'layout.newTab')).toBeUndefined();
  });

  it('still opens a tab for a PATH, which is a subject of its own', async () => {
    /*
     * The non-task case, and the reason the pane survives: a scratchpad, the
     * `Notes` root (ADR 0049), a directory belonging to no task. Every one of
     * them arrives as `path`, which is why the refusal above is written against
     * the ARGUMENT — the same directory asked for and defaulted to are two
     * different requests.
     */
    const { registered, invoked } = host({
      invoke: async (id) =>
        id === 'layout.listRoots' ? rootsAnswer() : id === 'tasks.list' ? TASKS : undefined,
    });
    const answer = await call(registered, EDITOR_COMMANDS.open, { path: '/notes' });
    expect(answer).toMatchObject({ ok: true, root: '/notes', opened: true });

    const tab = invoked.find((entry) => entry.id === 'layout.newTab');
    expect(tab?.args).toMatchObject({
      view: { type: EDITOR_VIEWS.workspace, state: { root: '/notes' } },
      // Without a title the tab reads `term`: a view pane runs no program.
      title: 'editor',
    });
  });

  it('falls back to the pane s cwd for a tab that belongs to no task', async () => {
    // A loose shell has no task root, and its cwd is the only thing that says
    // where you are.
    const { registered } = host({
      invoke: async (id) =>
        id === 'layout.listRoots'
          ? rootsAnswer({ group: 'window-1' })
          : id === 'tasks.list'
            ? TASKS
            : undefined,
    });
    expect(await call(registered, EDITOR_COMMANDS.open, {})).toMatchObject({ root: '/repo' });
  });

  it('prefers an explicit path over where you are', async () => {
    const { registered, invoked } = host({
      invoke: async (id) =>
        id === 'layout.listRoots' ? rootsAnswer() : id === 'tasks.list' ? TASKS : undefined,
    });
    await call(registered, EDITOR_COMMANDS.open, { path: '/elsewhere' });
    expect(invoked.find((entry) => entry.id === 'layout.newTab')?.args).toMatchObject({
      view: { state: { root: '/elsewhere' } },
    });
  });

  it('switches to the tab already on that directory instead of opening a second', async () => {
    const tree = {
      kind: 'leaf',
      pane: { view: { type: EDITOR_VIEWS.workspace, state: { root: '/repo' } } },
    };
    const { registered, invoked } = host({
      invoke: async (id) => (id === 'layout.listRoots' ? rootsAnswer({ tree }) : undefined),
    });
    const answer = await call(registered, EDITOR_COMMANDS.open, {});
    expect(answer).toMatchObject({ ok: true, opened: false });
    expect(invoked.some((entry) => entry.id === 'layout.switchRoot')).toBe(true);
    expect(invoked.some((entry) => entry.id === 'layout.newTab')).toBe(false);
  });

  it('refuses, with a reason naming the fix, when nothing says where to open', async () => {
    // A tab holding only view panes has no cwd, and guessing one would open the
    // tree on a directory nobody named.
    const { registered } = host({
      invoke: async (id) =>
        id === 'layout.listRoots' ? rootsAnswer({ panes: [{ pane: 'p1' }] }) : undefined,
    });
    const answer = (await call(registered, EDITOR_COMMANDS.open, {})) as { reason: string };
    expect(answer).toMatchObject({ ok: false });
    expect(answer.reason).toContain('pass a path');
  });
});
