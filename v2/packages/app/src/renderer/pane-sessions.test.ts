// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { paneId as makePaneId } from '@shepherd/sdk';
import { makePane, type Pane } from '@shepherd/core/layout';
import { PaneSessionRegistry } from './pane-sessions.ts';
import { SpySession, decode, fakeTerminal, type FakeTerminal } from './test-terminals.ts';

/**
 * The v1 root finding, as a test: **a view going away must not end a session.**
 *
 * The registry is exercised against a spy bridge, so every claim is about the
 * exact IPC calls it makes — `kill` is a string in a list, and its absence is
 * checkable.
 *
 * P4a moved the kill itself one process over: the kernel owns the layout, so
 * `layout.close` ends a session through the `SessionSink` a `LayoutStore` cannot
 * be constructed without, and by the time the pane's disappearance reaches this
 * renderer the pty is already gone. So the assertion here is now that **nothing
 * in this file kills anything, on any path** — `release` included.
 *
 * A guard with no negative control guards nothing, and "never kills" is a claim
 * that a registry which does nothing at all would also satisfy. Two controls keep
 * it honest: `create`/`attach`/`detach` are asserted positively throughout (so the
 * registry demonstrably still talks to the bridge), and `menu-dispatch.test.ts`
 * asserts the kill really does happen, against a real `LayoutStore` in main.
 */

interface Harness {
  readonly session: SpySession;
  readonly registry: PaneSessionRegistry;
  readonly terminals: FakeTerminal[];
  readonly errors: Array<{ error: unknown; context: string }>;
  readonly pane: Pane;
  host(): HTMLElement;
}

function harness(): Harness {
  const session = new SpySession();
  const terminals: FakeTerminal[] = [];
  const errors: Array<{ error: unknown; context: string }> = [];
  const registry = new PaneSessionRegistry({
    session,
    createTerminal: () => {
      const terminal = fakeTerminal();
      terminals.push(terminal);
      return terminal;
    },
    spec: (pane) => ({ paneId: pane.id }),
    onError: (error, context) => errors.push({ error, context }),
  });
  return {
    session,
    registry,
    terminals,
    errors,
    pane: makePane({ userTitle: 'one' }),
    // Real elements: the registry parents each terminal's wrapper into its
    // host, and re-parents it on a remount, so a stub would hide the thing
    // these tests are about.
    host: () => document.createElement('div'),
  };
}

// -------------------------------------------------------------------- tests

describe('PaneSessionRegistry lifetime', () => {
  it('creates exactly one session the first time a pane is mounted', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();

    expect(h.session.names).toEqual(['create', 'attach', 'resize']);
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe('s1');
    expect(h.registry.inspect(h.pane.id)?.streaming).toBe(true);
    expect(h.registry.inspect(h.pane.id)?.mounted).toBe(true);
  });

  it("types a pane's initialCommand once, and never again on a remount", async () => {
    // The seam `tasks.spawn` runs an agent through. Once is the whole point: a
    // remount re-runs `#sync`, and a command typed a second time starts a
    // SECOND agent in a pane that already has one — v1's remount lesson with a
    // process attached to it.
    const h = harness();
    const pane = makePane({ userTitle: 'agent', initialCommand: 'echo hi' });

    h.registry.attach(pane, h.host());
    await h.registry.settled();
    const typed = h.session.calls.filter((call) => call.name === 'write');
    expect(typed).toHaveLength(1);
    expect(decode(typed[0]?.args[1] as string)).toBe('echo hi\n');

    h.registry.detach(pane.id);
    h.registry.attach(pane, h.host());
    await h.registry.settled();
    expect(h.session.calls.filter((call) => call.name === 'write')).toHaveLength(1);
  });

  it('types nothing for an ordinary pane — the control for the test above', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    expect(h.session.names).not.toContain('write');
  });

  it('unmounting only unparents: no kill, and not even a torn-down terminal', async () => {
    const h = harness();
    const host = h.host();
    h.registry.attach(h.pane, host);
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.detach(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual([]);
    expect(h.session.names).not.toContain('kill');
    // The mapping survives — this is what "the session outlives the view" means.
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe('s1');
    expect(h.registry.inspect(h.pane.id)?.mounted).toBe(false);
    // …and so does the screen, and the stream feeding it.
    expect(h.registry.inspect(h.pane.id)?.streaming).toBe(true);
    expect(h.terminals[0]?.disposed).toBe(false);
    expect(host.childElementCount).toBe(0);
  });

  it('a remount re-parents the SAME terminal into the new host', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    const terminal = h.terminals[0];
    h.registry.detach(h.pane.id);
    await h.registry.settled();
    h.session.calls.length = 0;

    const secondHost = h.host();
    h.registry.attach(h.pane, secondHost);
    await h.registry.settled();

    // Nothing crossed the bridge at all: no second session, no re-attach, and
    // therefore no replay to duplicate what the terminal already shows.
    expect(h.session.names).toEqual([]);
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]).toBe(terminal);
    expect(secondHost.childElementCount).toBe(1);
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe('s1');
  });

  it('survives ten unmount/remount cycles on one session', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) {
      h.registry.attach(h.pane, h.host());
      await h.registry.settled();
      h.registry.detach(h.pane.id);
      await h.registry.settled();
    }
    expect(h.session.names.filter((n) => n === 'create')).toHaveLength(1);
    expect(h.session.names.filter((n) => n === 'attach')).toHaveLength(1);
    expect(h.session.names).not.toContain('kill');
    expect(h.terminals).toHaveLength(1);
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe('s1');
  });

  // ------------------------------------------- release: drop the view, kill nothing
  it('release drops the terminal and stops the stream — and does NOT kill', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.release(h.pane.id);
    await h.registry.settled();

    // `detach` so main stops coalescing bytes into a view that is gone; no
    // `kill`, because core already killed it and a second one would be an
    // `unknown-session` error on a perfectly correct close.
    expect(h.session.names).toEqual(['detach']);
    expect(h.session.names).not.toContain('kill');
    expect(h.terminals[0]?.disposed).toBe(true);
    expect(h.registry.inspect(h.pane.id)).toBeUndefined();
    expect(h.registry.paneIds()).toEqual([]);
  });

  it('release of an UNPARENTED pane still stops its stream', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.registry.detach(h.pane.id);
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.release(h.pane.id);
    await h.registry.settled();

    // `detach` the VIEW leaves the stream running on purpose (that is what makes
    // a remount cost an `appendChild` instead of a replay), so the stream is still
    // live here and release is the thing that ends it.
    expect(h.session.names).toEqual(['detach']);
    expect(h.session.names).not.toContain('kill');
  });

  it('says nothing to a session that already exited', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.emitExit('s1', 0);
    h.session.calls.length = 0;

    h.registry.release(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual([]);
  });

  it('a pane released before its create runs never spawns a shell at all', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    // Same tick: `release` marks the entry before the queued work reaches
    // `create`, which is why that flag is set synchronously.
    h.registry.release(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual([]);
  });

  it('a release that lands MID-create leaves the pty to core, not to itself', async () => {
    const h = harness();
    h.session.deferCreate = true;
    h.registry.attach(h.pane, h.host());
    await Promise.resolve(); // let the queue reach the `await create(...)`
    h.registry.release(h.pane.id);
    h.session.releaseCreates();
    await h.registry.settled();

    // The ordering worth naming: a pty now exists that this renderer no longer
    // names. It is main's — the pane's session was bound in `SessionBridge.create`
    // the moment the pty was spawned, so `layout.close` can still reach it. A
    // kill from here would race that binding and report a failure either way.
    expect(h.session.names).toEqual(['create']);
    expect(h.session.names).not.toContain('kill');
  });

  it('disposing the registry drops every view and stream but kills nothing', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.dispose();
    await h.registry.settled();

    expect(h.session.names).toEqual(['detach']);
    expect(h.terminals[0]?.disposed).toBe(true);
  });
});

describe('PaneSessionRegistry streaming', () => {
  it('routes a session’s bytes to that pane’s terminal and no other', async () => {
    const h = harness();
    const other = makePane({ userTitle: 'two' });
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.registry.attach(other, h.host());
    await h.registry.settled();

    h.session.emitData('s1', new TextEncoder().encode('one'));
    h.session.emitData('s2', new TextEncoder().encode('two'));

    expect(h.registry.inspect(h.pane.id)?.text).toBe('one');
    expect(h.registry.inspect(other.id)?.text).toBe('two');
  });

  it('keeps writing to an unparented pane, so a remount has no gap in it', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.emitData('s1', new TextEncoder().encode('before;'));

    h.registry.detach(h.pane.id);
    h.session.emitData('s1', new TextEncoder().encode('while away;'));
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.emitData('s1', new TextEncoder().encode('after;'));

    // One continuous screen, each byte exactly once: the failure this replaces
    // is a remount that either loses the middle or replays the beginning.
    expect(h.registry.inspect(h.pane.id)?.text).toBe('before;while away;after;');
  });

  it('sends what the user types to that pane’s session', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.calls.length = 0;

    h.terminals[0]?.typed('ls\r');

    expect(h.session.names).toEqual(['write']);
    expect(h.session.calls[0]?.args).toEqual(['s1', 'ls\r']);
  });

  it('resizes the pty when the terminal re-measures, and not before it is bound', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    h.terminals[0]?.resizedTo(120, 40); // before create resolved: nothing to resize
    await h.registry.settled();
    h.session.calls.length = 0;

    h.terminals[0]?.resizedTo(120, 40);

    expect(h.session.calls).toEqual([{ name: 'resize', args: ['s1', 120, 40] }]);
  });

  it('a second attach with no detach moves the one terminal rather than making two', async () => {
    const h = harness();
    const first = h.host();
    const second = h.host();
    h.registry.attach(h.pane, first);
    await h.registry.settled();
    h.registry.attach(h.pane, second);
    await h.registry.settled();

    expect(h.terminals).toHaveLength(1);
    expect(first.childElementCount).toBe(0);
    expect(second.childElementCount).toBe(1);
    expect(h.session.names.filter((n) => n === 'create')).toHaveLength(1);
  });

  it('reports a failed create instead of leaving a pane silently dead', async () => {
    const h = harness();
    h.session.failCreate = true;
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();

    expect(h.errors.map((e) => e.context)).toEqual([`create ${h.pane.id}`]);
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBeNull();
  });

  it('ignores a detach for a pane it has never seen', async () => {
    const h = harness();
    h.registry.detach(makePaneId('ghost'));
    h.registry.release(makePaneId('ghost'));
    await h.registry.settled();
    expect(h.session.calls).toEqual([]);
  });
});

describe('a page reload', () => {
  /**
   * The claim the live-update story rests on: sessions live in main and outlive
   * the window, so reloading the renderer to pick up new UI must not cost a pty.
   *
   * Measured before this existed: one `window.reload` with two panes open left
   * FOUR sessions — the page created a second one per pane, and the originals
   * were left alive, rendered by nobody and killable only through a pane that
   * no longer pointed at them.
   */
  it('adopts the session the layout already binds, instead of creating a second', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host(), 's-existing');
    await h.registry.settled();

    expect(h.session.names).not.toContain('create');
    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe('s-existing');
    // It still streams: adopting is not the same as doing nothing.
    expect(h.session.names).toContain('attach');
  });

  it('creates when the layout knows of no session — the control', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    expect(h.session.names).toContain('create');
  });

  it('never re-points a pane that already has a session', async () => {
    // Main's binding and ours agreeing is the normal case; re-pointing would
    // orphan whatever this pane was already streaming.
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    const first = h.registry.inspect(h.pane.id)?.sessionId;

    h.registry.attach(h.pane, h.host(), 's-other');
    await h.registry.settled();

    expect(h.registry.inspect(h.pane.id)?.sessionId).toBe(first);
  });
});
