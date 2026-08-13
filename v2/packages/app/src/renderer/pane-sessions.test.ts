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

function harness(options: { snapshotBytes?: (paneId: string) => Promise<Uint8Array | null> } = {}): Harness {
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
    ...(options.snapshotBytes === undefined ? {} : { snapshotBytes: options.snapshotBytes }),
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

describe('PaneSessionRegistry suspend', () => {
  /**
   * The capability R0 bought, and the reason the mirror pays for itself.
   *
   * Before the host held a screen this was impossible: a pane that stopped
   * listening could never catch up, so every mounted pane — including the ones
   * in roots nobody is looking at — parsed and rendered forever. See the
   * `suspend` comment in `pane-sessions.ts`.
   */
  it('drops the terminal and the stream, and kills nothing', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    const sessionId = h.registry.inspect(h.pane.id)?.sessionId;
    expect(sessionId).toBe('s1');

    h.registry.suspend(h.pane);
    await h.registry.settled();

    const after = h.registry.inspect(h.pane.id);
    expect(after?.suspended).toBe(true);
    expect(after?.streaming).toBe(false);
    expect(after?.mounted).toBe(false);
    // The session is KEPT — that is the whole point. Only the view went.
    expect(after?.sessionId).toBe(sessionId);
    expect(h.session.names).toContain('detach');
    // The rule this whole file exists for, on the new path too.
    expect(h.session.names).not.toContain('kill');
  });

  it('stops writing bytes into a suspended pane', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    const terminal = h.terminals[0];
    const before = terminal?.written.length ?? 0;

    h.registry.suspend(h.pane);
    await h.registry.settled();
    h.session.emitData('s1', new TextEncoder().encode('output nobody is watching'));

    // The terminal is gone, so there is nothing to write into and nothing to
    // render. A dropped byte here is not a gap: the next attach is handed the
    // screen, which already contains it.
    expect(terminal?.written.length ?? 0).toBe(before);
  });

  it('wakes on attach and ADOPTS its session rather than creating a second', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    const sessionId = h.registry.inspect(h.pane.id)?.sessionId;

    h.registry.suspend(h.pane);
    await h.registry.settled();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();

    const woken = h.registry.inspect(h.pane.id);
    expect(woken?.suspended).toBe(false);
    expect(woken?.streaming).toBe(true);
    expect(woken?.sessionId).toBe(sessionId);
    // v1's remount lesson: waking must never spawn a second pty for a pane that
    // already has one.
    expect(h.session.names.filter((name) => name === 'create')).toHaveLength(1);
    expect(h.session.names).not.toContain('kill');
  });

  it('is idempotent, and does nothing to a released pane', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();

    h.registry.suspend(h.pane);
    h.registry.suspend(h.pane);
    await h.registry.settled();
    expect(h.session.names.filter((name) => name === 'detach')).toHaveLength(1);

    h.registry.release(h.pane.id);
    await h.registry.settled();
    h.registry.suspend(h.pane);
    await h.registry.settled();
    expect(h.session.names).not.toContain('kill');
  });
});

describe('PaneSessionRegistry lifetime', () => {
  it('creates exactly one session the first time a pane is mounted', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();

    // `setViewport`, not `resize`: a pane declares what it can show and the host
    // arbitrates between every viewer of that pty. See `SessionApi.setViewport`.
    expect(h.session.names).toEqual(['create', 'attach', 'setViewport']);
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

    // The viewport is WITHDRAWN and then `detach` so main stops coalescing bytes
    // into a view that is gone; no `kill`, because core already killed it and a
    // second one would be an `unknown-session` error on a perfectly correct
    // close. The withdrawal is not tidiness: a closed pane whose viewport
    // survived would keep every other viewer of that pty letterboxed.
    expect(h.session.names).toEqual(['setViewport', 'detach']);
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
    // live here and release is the thing that ends it — withdrawing this pane's
    // viewport on the way out.
    expect(h.session.names).toEqual(['setViewport', 'detach']);
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

    // The window is going away, so this renderer stops being a viewer: it says so
    // — withdrawing its viewport — before it stops listening. A page that merely
    // detached would leave its size constraining a pty that outlives it, which
    // after R1 it does.
    expect(h.session.names).toEqual(['setViewport', 'detach']);
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

  it('declares a viewport when the terminal re-measures, and not before it is bound', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    h.terminals[0]?.resizedTo(120, 40); // before create resolved: nothing to report
    await h.registry.settled();
    h.session.calls.length = 0;

    h.terminals[0]?.resizedTo(120, 40);

    /*
     * An OPINION keyed by the pane, not a command. `resize` is last-writer-wins,
     * so a pane reporting its window that way fought every other viewer of the
     * same pty — this Mac's other pane, a phone, another member — at the rate a
     * `ResizeObserver` fires. Keyed by pane id so two panes on one session are two
     * viewers rather than one that overwrites the other.
     */
    expect(h.session.calls).toEqual([
      { name: 'setViewport', args: ['s1', h.pane.id, { cols: 120, rows: 40 }] },
    ]);
  });

  it('does NOT report the host’s own answer back to it — the resize storm', async () => {
    /*
     * The bug this exists for, measured in the running app: 29,825 resizes in
     * ten seconds, cycling 28x39 → 24x39 → 56x45 → 64x45 and round again, with
     * every pane on screen feeding it.
     *
     * The registry applies the host's answer with `terminal.resize()`; xterm
     * emits `onResize` for that, and the listener reported it to the host as a
     * fresh authoritative size. So every correction bounced straight back, and
     * with more than one pane the corrections chased each other at frame rate.
     * `xterm-terminal.ts` has claimed since it was written that `resize`
     * "reshapes the grid without telling the host". This is what makes it true.
     */
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.calls.length = 0;

    h.session.resizeListeners.forEach((listener) =>
      listener({ sessionId: 's1', cols: 24, rows: 39 }),
    );

    expect(h.terminals[0]?.cols).toBe(24);
    expect(h.terminals[0]?.rows).toBe(39);
    expect(h.session.calls).toEqual([]);
  });

  it('still reports a re-measure of its own after applying the host’s', async () => {
    // The control: suppression is scoped to the write, not latched. Without this
    // the fix above could silence the pane permanently and both tests would pass.
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.resizeListeners.forEach((listener) =>
      listener({ sessionId: 's1', cols: 24, rows: 39 }),
    );
    h.session.calls.length = 0;

    h.terminals[0]?.resizedTo(100, 50);

    expect(h.session.calls).toEqual([
      { name: 'setViewport', args: ['s1', h.pane.id, { cols: 100, rows: 50 }] },
    ]);
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

describe('retheme', () => {
  it('repaints every live terminal without building one', () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    const built = h.terminals.length;

    h.registry.retheme('light');

    // The load-bearing claim: a theme change costs no new terminal. A rebuilt one
    // is a released pty and a lost scrollback, which is a high price for a colour
    // — and a count is the only thing that can tell the two apart.
    expect(h.terminals).toHaveLength(built);
    // The tail, not the whole list: a terminal is painted once when it is built
    // (with the live mode) and again on every change.
    expect(h.terminals[0]?.themes.at(-1)).toBe('light');
  });

  it('opens a terminal born LATER in the theme that is live', () => {
    // Not exotic: a suspended root wakes on a switch, and `tasks.spawn` opens a
    // pane into a root nobody is looking at. Either would otherwise open in the
    // factory's default and sit on the wrong palette until the next change.
    const h = harness();
    h.registry.retheme('light');
    h.registry.attach(h.pane, h.host());
    expect(h.terminals[0]?.themes).toContain('light');
  });
});


/**
 * A pane that shows a FILE, not a session.
 *
 * The claim these make is the one the whole archived-tab change rests on:
 * mounting such a pane must not reach `#sync`'s create branch, however many
 * times it is attached, suspended and woken. `session.names` is the evidence —
 * a `create` in it is a pty spawned in a worktree the archive deleted.
 */
describe('a read-only pane', () => {
  const readOnlyPane = (id: string, file = `/${id}.term`): Pane =>
    makePane({ id: makePaneId(id), readOnly: true, snapshotFile: file });

  it('creates no session, however many times it is attached', async () => {
    const h = harness({ snapshotBytes: () => Promise.resolve(new Uint8Array([0x68, 0x69])) });
    const pane = readOnlyPane('p-1');

    h.registry.attach(pane, h.host());
    await h.registry.settled();
    h.registry.detach(pane.id);
    h.registry.attach(pane, h.host());
    await h.registry.settled();

    expect(h.session.names).not.toContain('create');
    expect(h.registry.inspect(pane.id)?.sessionId).toBeNull();
  });

  it('is born showing the bytes main answers with', async () => {
    const h = harness({ snapshotBytes: () => Promise.resolve(new TextEncoder().encode('old work')) });
    const pane = readOnlyPane('p-2');

    h.registry.attach(pane, h.host());
    await h.registry.settled();

    expect((h.terminals[0]?.written ?? []).map(decode).join('')).toContain('old work');
  });

  it('comes back blank rather than refusing when the file has gone', async () => {
    const h = harness({ snapshotBytes: () => Promise.resolve(null) });
    const pane = readOnlyPane('p-3', '/gone.term');

    h.registry.attach(pane, h.host());
    await h.registry.settled();

    // A terminal exists and it is empty. An expired archive costs a screen, not
    // a tab — and above all it must not fall back to starting a shell.
    expect(h.terminals).toHaveLength(1);
    expect(h.session.names).not.toContain('create');
  });

  it('writes its screen again after being suspended and woken', async () => {
    // Suspending disposes the terminal, so waking builds a FRESH one — and a
    // pane whose bytes were written only on the first build would wake blank.
    const h = harness({ snapshotBytes: () => Promise.resolve(new TextEncoder().encode('old work')) });
    const pane = readOnlyPane('p-4');

    h.registry.attach(pane, h.host());
    await h.registry.settled();
    h.registry.suspend(pane);
    await h.registry.settled();
    h.registry.attach(pane, h.host());
    await h.registry.settled();

    expect(h.terminals).toHaveLength(2);
    expect((h.terminals[1]?.written ?? []).map(decode).join('')).toContain('old work');
  });

  it('still creates a session for an ordinary pane', async () => {
    // The negative control. "Never creates" is a claim a registry that does
    // nothing would also satisfy.
    const h = harness();
    h.registry.attach(makePane({ id: makePaneId('p-5') }), h.host());
    await h.registry.settled();
    expect(h.session.names).toContain('create');
  });
});
