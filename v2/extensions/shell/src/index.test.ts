import { describe, expect, it, vi } from 'vitest';
import type { Shepherd, TreeItem } from '@shepherd/sdk';
import { activate } from './index.ts';
import { cwd } from 'node:process';
import { SHELL_COMMANDS, shellManifest } from './manifest.ts';

/**
 * The host, faked to the surface `activate` actually touches.
 *
 * `invoke` answers a `Result`, because that is what crosses the port: `ok` says
 * the call succeeded and nothing more, which is the property several of the cases
 * below exist to hold this code to.
 */

interface FakeRoot {
  root: string;
  group: string;
  label: string;
  focusedSession: string | null;
  panes: { pane: string; cwd: string | null; session: string | null }[];
}

const root = (
  id: string,
  label: string,
  cwd: string | null = '/Users/me/dev',
  session: string | null = null,
): FakeRoot => ({
  root: id,
  group: 'window-1',
  label,
  focusedSession: session,
  panes: [{ pane: `${id}:p1`, cwd, session }],
});

function host(roots: FakeRoot[]) {
  const handlers = new Map<string, (args: unknown) => unknown>();
  const busListeners = new Map<string, (payload: unknown) => void>();
  let provider: { children(parent: string | undefined): Promise<readonly TreeItem[]> } | null = null;
  let view: { head?: boolean; title?: string } | null = null;

  const invoke = vi.fn(async (command: string, args?: unknown) => {
    if (command === 'layout.listRoots') {
      const group = (args as { group?: string } | undefined)?.group;
      return { ok: true as const, value: roots.filter((one) => group === undefined || one.group === group) };
    }
    return { ok: true as const, value: {} };
  });

  const ctx = {
    subscriptions: [] as Disposable[],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  const api = {
    proposed: {
      commands: {
        invoke,
        register: (id: string, spec: { handler: (args: unknown) => unknown }) => {
          handlers.set(id, spec.handler);
          return { [Symbol.dispose]: () => handlers.delete(id) };
        },
      },
      events: {
        on: (topic: string, fn: (payload: unknown) => void) => {
          busListeners.set(topic, fn);
          return { [Symbol.dispose]: () => busListeners.delete(topic) };
        },
      },
      views: {
        registerViewType: (_type: string, declared: { data: NonNullable<typeof provider>; head?: boolean; title?: string }) => {
          provider = declared.data;
          view = declared;
          return { [Symbol.dispose]: () => {} };
        },
      },
    },
  };

  // A fake host is deliberately narrower than the real API; the cast is the fake
  // saying so, not a claim about the value's shape.
  activate(ctx as unknown as Parameters<typeof activate>[0], api as unknown as Shepherd);

  const settle = async (): Promise<void> => {
    // Two microtask drains: `activate` fires its first `refresh` without awaiting
    // it, and the read inside is itself a promise.
    await Promise.resolve();
    await Promise.resolve();
  };
  const rows = async (): Promise<readonly TreeItem[]> => {
    await settle();
    return provider?.children(undefined) ?? [];
  };
  /**
   * Make the extension read the layout AGAIN.
   *
   * A `mockResolvedValueOnce` armed after `activate` has already fired its own
   * first `refresh` is consumed by nothing — which is how three of the cases
   * below passed while asserting against an empty mirror they would have had
   * anyway. This is the announcement that forces the re-read.
   */
  const reread = async (): Promise<readonly TreeItem[]> => {
    busListeners.get('layout.rootsChanged')?.({});
    return rows();
  };
  return { rows, reread, handlers, busListeners, invoke, ctx, view: () => view };
}

describe('the region', () => {
  it('names itself through its VIEW, not through a row of its own', async () => {
    // The dock draws a tree's declared title as a SectionLabel. An extension
    // inventing a first row to name its own list would be a second answer to a
    // question the contribution already answers — and at the row's own size and
    // weight it read as a fourth sibling rather than as the thing the others
    // belong to.
    const { view, rows } = host([root('window-1', 'dev')]);
    expect(view()?.title).toBe('Scratchpad');
    expect(view()?.head).toBe(true);
    expect((await rows()).map((row) => row.label)).toEqual(['dev']);
  });

  it('sends one row per shell and nothing else', async () => {
    const { rows } = host([root('window-1', 'dev'), root('window-1/tab-1', 'zsh')]);
    const listed = await rows();
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => row.root !== undefined)).toBe(true);
  });

  it('sends no rows at all when the group is empty, and the heading still stands', async () => {
    // The heading is the view's, so an empty list still says what it is.
    const { rows } = host([]);
    expect(await rows()).toEqual([]);
  });
});

describe('a shell row', () => {
  it('switches to its root when clicked', async () => {
    const { rows } = host([root('window-1', 'dev'), root('window-1/tab-1', 'zsh')]);
    const listed = await rows();
    expect(listed[1]?.command).toEqual({ id: 'layout.switchRoot', args: { root: 'window-1/tab-1' } });
    expect(listed[1]?.root).toBe('window-1/tab-1');
  });

  it('is not a root with no panes', async () => {
    // The home root is in this group and is minted empty at launch — and it is
    // the one root `closeRoot` refuses. Listed, it drew a permanent row standing
    // for nothing that could not be closed.
    const { rows } = host([{ ...root('window-1', ''), panes: [] }, root('window-1/tab-1', 'zsh')]);
    expect((await rows()).map((row) => row.label)).toEqual(['zsh']);
  });

  it('takes its label from listRoots unchanged, whatever the program called itself', async () => {
    // `listRoots` is the single authority and `displayTitle` never answers blank:
    // it falls through to core's own default. A fresh shell therefore reads
    // `term` until its program titles itself, exactly as any new tab does.
    const { rows } = host([root('window-1/tab-1', 'term'), root('window-1/tab-2', '~/dev/relay')]);
    expect((await rows()).map((row) => row.label)).toEqual(['term', '~/dev/relay']);
  });

  it('only names the group it was asked for', async () => {
    const { invoke, rows } = host([root('window-1', 'dev')]);
    await rows();
    expect(invoke).toHaveBeenCalledWith('layout.listRoots', { group: 'window-1' });
  });
});

describe('reading the layout defensively', () => {
  it('draws the head row and no shells when the answer is not an array', async () => {
    // `ok` says the call succeeded, not that the value has a shape, and a cast is
    // not a check. A provider answering the wrong shape must not take the rail
    // down.
    // Started from a NON-EMPTY mirror on purpose. Without the guard, iterating a
    // non-iterable throws inside a `void refresh()` and leaves the previous rows
    // standing — which, from an empty mirror, is indistinguishable from having
    // handled it. This is the shape that can tell the two apart.
    const { reread, invoke } = host([root('window-1', 'dev')]);
    invoke.mockResolvedValueOnce({ ok: true, value: { roots: 'lots' } } as never);
    expect(await reread()).toEqual([]);
  });

  it('skips a root missing its own id', async () => {
    const { reread, invoke } = host([]);
    invoke.mockResolvedValueOnce({
      ok: true,
      value: [{ group: 'window-1', label: 'zsh' }, root('window-1', 'dev')],
    } as never);
    const listed = await reread();
    expect(listed.map((row) => row.label)).toEqual(['dev']);
  });

  it('draws the head row when the call itself fails', async () => {
    const { reread, invoke } = host([root('window-1', 'dev')]);
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'denied', message: 'no' } } as never);
    // Started from a non-empty mirror, so "one row" is the failure being handled
    // rather than the state it was already in.
    expect(await reread()).toEqual([]);
  });
});

describe('the overflow', () => {
  const four = (): FakeRoot[] => [
    root('window-1', 'a'),
    root('window-1/tab-1', 'b'),
    root('window-1/tab-2', 'c'),
    root('window-1/tab-3', 'd'),
  ];

  it('caps at three rows and offers the count as a clickable row', async () => {
    const { rows } = host(four());
    const listed = await rows();
    expect(listed).toHaveLength(3);
    expect(listed[2]?.label).toBe('… +2');
    expect(listed[2]?.command).toEqual({ id: SHELL_COMMANDS.expand });
  });

  it('draws the overflow row as a control on the list rather than an entry in it', async () => {
    const { rows } = host(four());
    const listed = await rows();
    expect(listed[2]?.quiet).toBe(true);
  });

  it('shows all of them once expanded, and offers the way back', async () => {
    const { rows, handlers } = host(four());
    await rows();
    await handlers.get(SHELL_COMMANDS.expand)?.({});
    const listed = await rows();
    expect(listed).toHaveLength(5);
    expect(listed.at(-1)?.label).toBe('… less');
  });

  it('toggles, so the expansion is not one-way', async () => {
    const { rows, handlers } = host(four());
    await handlers.get(SHELL_COMMANDS.expand)?.({});
    await handlers.get(SHELL_COMMANDS.expand)?.({});
    expect(await rows()).toHaveLength(3);
  });
});

describe('a shell running an agent', () => {
  it('reaches the head row as a tint once the bus says so', async () => {
    const { rows, busListeners } = host([root('window-1', 'dev', '/Users/me/dev', 'sess-1')]);
    await rows();
    busListeners.get('agents.stateChanged')?.({ session: 'sess-1', to: 'blocked' });
    const listed = await rows();
    expect(listed[0]?.tint).toBe('blocked');
  });

  it('drops a malformed announcement rather than keying the mirror on undefined', async () => {
    // A mirror keyed on `undefined` could never be cleared: no later change can
    // name that key.
    const { rows, busListeners } = host([root('window-1', 'dev', '/Users/me/dev', 'sess-1')]);
    busListeners.get('agents.stateChanged')?.({ to: 'blocked' });
    busListeners.get('agents.stateChanged')?.(null);
    const listed = await rows();
    expect(listed[0]?.tint).toBeUndefined();
  });

  it('re-reads the layout when the roots change', async () => {
    const { rows, busListeners, invoke } = host([root('window-1', 'dev')]);
    await rows();
    const before = invoke.mock.calls.length;
    busListeners.get('layout.rootsChanged')?.({});
    await Promise.resolve();
    expect(invoke.mock.calls.length).toBeGreaterThan(before);
  });
});

/**
 * The gate that was missing, and its absence is why ⌘0 did nothing.
 *
 * `manifest.test.ts` asserts the manifest contributes exactly the commands in
 * `SHELL_COMMANDS` — which compares the declaration to itself and passes however
 * many of them are actually registered. A manifest may not promise a verb nothing
 * answers: the palette lists it, a keybinding reaches for it, and the failure is
 * `unknown-command` at the moment somebody presses the key.
 */
describe('every verb the manifest declares', () => {
  it('is registered by activate', () => {
    const { handlers } = host([]);
    const declared = (shellManifest.contributes?.commands ?? []).map((command) => command.id);
    expect([...handlers.keys()].sort()).toEqual([...declared].sort());
  });
});

/**
 * Promote — an accelerator, not a migration.
 *
 * These use REAL paths, because the walk that finds the repo reads the real
 * filesystem: a fake would only prove the fake works. `repo.test.ts` covers the
 * walk itself against an injected tree; this covers the wiring.
 */
describe('shell.promote', () => {
  /**
   * Vitest runs in `extensions/shell`, which is INSIDE the repo and is not one
   * itself — so these cases exercise the climb rather than a lucky exact hit. The
   * expected repo is asserted structurally rather than recomputed here: deriving
   * it the same way the code does would be the test agreeing with itself, which
   * is how the first version of this passed while expecting `shell`.
   */
  const here = cwd();
  const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

  it('offers the repo the shell is sitting in, named for the repo and not the cwd', async () => {
    const { rows } = host([root('window-1/tab-1', 'term', here)]);
    const [only] = await rows();
    const [action] = only?.actions ?? [];
    expect(action).toMatchObject({ id: SHELL_COMMANDS.promote, args: { root: 'window-1/tab-1' } });
    // The cwd's own basename is `shell`; the repo above it is not.
    expect(action).not.toMatchObject({ label: `Start a task in ${basename(here)}` });
    expect(action && 'label' in action ? action.label : '').toMatch(/^Start a task in \S+$/);
  });

  it('offers nothing on a shell with no repo above it', async () => {
    // The first shell anyone opens is in $HOME, which is not a repo. An action
    // that created a task rooted nowhere would fail one process away, naming a
    // path nobody typed.
    const { rows } = host([root('window-1/tab-1', 'term', '/')]);
    expect((await rows())[0]?.actions).toBeUndefined();
  });

  it('creates a task with BOTH path and name, which is what repoArg requires', async () => {
    const { handlers, invoke } = host([root('window-1/tab-1', 'term', here)]);
    await handlers.get(SHELL_COMMANDS.promote)?.({ root: 'window-1/tab-1' });
    const call = invoke.mock.calls.find(([command]) => command === 'tasks.create');
    expect(call).toBeDefined();
    const repos = (call?.[1] as { repos: { path: string; name: string }[] }).repos;
    expect(repos).toHaveLength(1);
    const [repo] = repos;
    // `repoArg` requires both fields; `name` is the REPO's basename, and the repo
    // is an ancestor of the shell's cwd rather than the cwd itself.
    expect(repo?.name).toBe(basename(repo?.path ?? ''));
    expect(here.startsWith(repo?.path ?? 'x')).toBe(true);
    expect(repo?.path).not.toBe(here);
  });

  it('refuses a root it does not know rather than guessing one', async () => {
    const { handlers } = host([root('window-1/tab-1', 'term', here)]);
    await expect(handlers.get(SHELL_COMMANDS.promote)?.({ root: 'window-9' })).rejects.toThrow(/window-9/);
  });

  it('does not close or move the shell', async () => {
    // A root is fixed to its group at mint, and a task's agent runs in a fresh
    // worktree anyway — so the shell's cwd would be the wrong directory inside
    // the task. This saves typing a path into the composer, and nothing more.
    const { handlers, invoke } = host([root('window-1/tab-1', 'term', here)]);
    await handlers.get(SHELL_COMMANDS.promote)?.({ root: 'window-1/tab-1' });
    const touched = invoke.mock.calls.map(([command]) => command);
    expect(touched).not.toContain('layout.close');
    expect(touched).not.toContain('layout.closeRoot');
    expect(touched).not.toContain('layout.switchRoot');
  });
});
