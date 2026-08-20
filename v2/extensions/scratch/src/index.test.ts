import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '@shepherd/sdk';
import { activate } from './index.ts';
import { SCRATCH_COMMANDS, SCRATCH_KEY, SCRATCH_VIEWS } from './manifest.ts';

/**
 * Captures what `activate` registered, so each assertion is about ONE
 * registration rather than about a whole activation.
 */
function harness(startMs = 1000) {
  const commands = new Map<string, { handler: (args: never) => unknown }>();
  const views: { type: string; declaration: Record<string, unknown> }[] = [];
  const invoked: { command: string; args: unknown }[] = [];
  const execs: string[][] = [];
  const rows = new Map<string, unknown>();
  const clock = manualClock(startMs);

  const ctx = {
    id: 'shepherd.scratch',
    subscriptions: [] as { dispose(): void }[],
    clock,
    homeDir: '/Users/nobody',
    userName: 'nobody',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    storage: {
      get: (key: string) => rows.get(key),
      set: (key: string, value: unknown) => void rows.set(key, value),
      delete: (key: string) => void rows.delete(key),
      keys: () => [...rows.keys()].sort(),
    },
  };

  const api = {
    proposed: {
      commands: {
        register: (id: string, spec: { handler: (args: never) => unknown }) => {
          commands.set(id, spec);
          return { dispose: () => commands.delete(id) };
        },
        invoke: async (command: string, args: unknown) => {
          invoked.push({ command, args });
          return { ok: true as const, value: { root: 'r1', pane: 'p1' } };
        },
      },
      views: {
        registerViewType: (type: string, declaration: Record<string, unknown>) => {
          views.push({ type, declaration });
          return { dispose: () => {} };
        },
      },
      process: {
        exec: async (cmd: readonly string[]) => {
          execs.push([...cmd]);
          return { ok: true as const, stdout: '', stderr: '' };
        },
      },
    },
  };

  return { ctx, api, commands, views, invoked, execs, rows, clock };
}

const run = async (h: ReturnType<typeof harness>, id: string, args: unknown = {}): Promise<unknown> =>
  h.commands.get(id)?.handler(args as never);

describe('scratch activate', () => {
  it('registers its pane view with the accelerator and the command the key runs', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const view = h.views.find((entry) => entry.type === SCRATCH_VIEWS.pad);
    expect(view).toBeDefined();
    expect(view?.declaration).toMatchObject({
      kind: 'component',
      component: SCRATCH_VIEWS.pad,
      surface: 'pane',
      key: SCRATCH_KEY,
      command: SCRATCH_COMMANDS.create,
    });
  });

  it('create mints an id and opens a tab carrying it', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const result = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };

    expect(result.id).toMatch(/^scr_/);
    const opened = h.invoked.find((entry) => entry.command === 'layout.newTab');
    expect(opened?.args).toMatchObject({
      view: { type: SCRATCH_VIEWS.pad, state: { id: result.id } },
      title: 'scratch',
    });
  });

  it('create mints a DIFFERENT id every time, even inside one millisecond', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const first = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    const second = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    expect(first.id).not.toBe(second.id);
  });

  it('write then read round-trips through the store', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const { id } = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    await run(h, SCRATCH_COMMANDS.write, { id, text: '- [ ] ship it' });
    expect(await run(h, SCRATCH_COMMANDS.read, { id })).toMatchObject({ text: '- [ ] ship it' });
  });

  it('read answers a reason rather than throwing for an unknown id', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    expect(await run(h, SCRATCH_COMMANDS.read, { id: 'scr_nope' })).toMatchObject({ ok: false });
  });

  it('open refuses a file:// URL and never reaches exec', async () => {
    // The URL comes from the user's own typing, so the question is not where
    // the click goes but what open(1) is being asked to launch.
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    expect(await run(h, SCRATCH_COMMANDS.open, { url: 'file:///etc/passwd' })).toMatchObject({ ok: false });
    expect(h.execs).toHaveLength(0);
  });

  it('open runs open(1) with an ARGV ARRAY for an https URL', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    await run(h, SCRATCH_COMMANDS.open, { url: 'https://example.com' });
    expect(h.execs[0]).toEqual(['/usr/bin/open', 'https://example.com']);
  });

  it('close soft-deletes: the text is still readable afterwards', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const { id } = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    await run(h, SCRATCH_COMMANDS.write, { id, text: 'kept' });
    await run(h, SCRATCH_COMMANDS.close, { id });
    expect(await run(h, SCRATCH_COMMANDS.read, { id })).toMatchObject({ text: 'kept' });
  });

  it('collects a buffer closed more than seven days ago, at activation', async () => {
    const h = harness();
    await activate(h.ctx as never, h.api as never);
    const { id } = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    await run(h, SCRATCH_COMMANDS.close, { id });

    // A second activation, eight days later, against the same rows.
    h.clock.advance(8 * 24 * 60 * 60 * 1000);
    await activate(h.ctx as never, h.api as never);
    expect(await run(h, SCRATCH_COMMANDS.read, { id })).toMatchObject({ ok: false });
  });

  it('reads no wall clock — every time it stores comes from ctx.clock', async () => {
    const h = harness(4242);
    await activate(h.ctx as never, h.api as never);
    const { id } = (await run(h, SCRATCH_COMMANDS.create)) as { id: string };
    expect((h.rows.get(id) as { updatedAt: number }).updatedAt).toBe(4242);
  });
});
