// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { paneId as makePaneId } from '@shepherd/sdk';
import { makePane, type Pane } from '@shepherd/core/layout';
import type {
  IpcResult,
  SessionApi,
  SessionCreateRequest,
  SessionDataMessage,
  SessionDescriptor,
  SessionExitMessage,
} from '../shared/index.ts';
import {
  PaneSessionRegistry,
  type TerminalDisposable,
  type TerminalLike,
} from './pane-sessions.ts';

/**
 * The v1 root finding, as a test: **a view going away must not end a session.**
 *
 * The registry is exercised against a spy bridge, so every claim is about the
 * exact IPC calls it makes — `kill` is a string in a list, and its absence is
 * checkable. The negative control (`close` DOES kill) is in the same describe
 * block on purpose: a guard with no negative control guards nothing, and the
 * failure mode it protects against is a registry that simply never kills.
 */

// ------------------------------------------------------------------- spies

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

class SpySession implements SessionApi {
  readonly calls: Call[] = [];
  #nextId = 0;
  dataListeners: Array<(m: SessionDataMessage) => void> = [];
  exitListeners: Array<(m: SessionExitMessage) => void> = [];
  /** Set to make the next create fail. */
  failCreate = false;
  /** Set to hold every create open until `releaseCreates()`. */
  deferCreate = false;
  #deferred: Array<() => void> = [];

  releaseCreates(): void {
    for (const release of this.#deferred.splice(0)) release();
  }

  get names(): string[] {
    return this.calls.map((call) => call.name);
  }

  #record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  create(request: SessionCreateRequest): Promise<IpcResult<SessionDescriptor>> {
    this.#record('create', request);
    if (this.failCreate) {
      return Promise.resolve({ ok: false, error: { code: 'spawn-failed', message: 'nope' } });
    }
    this.#nextId += 1;
    const value: SessionDescriptor = {
      sessionId: `s${this.#nextId}`,
      pid: 100 + this.#nextId,
      cols: 80,
      rows: 24,
    };
    if (!this.deferCreate) return Promise.resolve({ ok: true, value });
    return new Promise((resolve) => {
      this.#deferred.push(() => resolve({ ok: true, value }));
    });
  }

  attach(sessionId: string): Promise<IpcResult<SessionDescriptor>> {
    this.#record('attach', sessionId);
    return Promise.resolve({ ok: true, value: { sessionId, pid: 1, cols: 80, rows: 24 } });
  }

  detach(sessionId: string): Promise<IpcResult<void>> {
    this.#record('detach', sessionId);
    return Promise.resolve({ ok: true, value: undefined });
  }

  write(sessionId: string, data: string | Uint8Array): Promise<IpcResult<void>> {
    this.#record('write', sessionId, data);
    return Promise.resolve({ ok: true, value: undefined });
  }

  paste(sessionId: string, text: string): Promise<IpcResult<void>> {
    this.#record('paste', sessionId, text);
    return Promise.resolve({ ok: true, value: undefined });
  }

  resize(sessionId: string, cols: number, rows: number): Promise<IpcResult<void>> {
    this.#record('resize', sessionId, cols, rows);
    return Promise.resolve({ ok: true, value: undefined });
  }

  kill(sessionId: string): Promise<IpcResult<void>> {
    this.#record('kill', sessionId);
    return Promise.resolve({ ok: true, value: undefined });
  }

  onData(listener: (message: SessionDataMessage) => void): () => void {
    this.dataListeners.push(listener);
    return () => {
      this.dataListeners = this.dataListeners.filter((l) => l !== listener);
    };
  }

  onExit(listener: (message: SessionExitMessage) => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }

  emitData(sessionId: string, bytes: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener({ sessionId, bytes });
  }

  emitExit(sessionId: string, exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ sessionId, exitCode });
  }
}

interface FakeTerminal extends TerminalLike {
  readonly written: Array<Uint8Array | string>;
  disposed: boolean;
  opened: HTMLElement | null;
  typed(text: string): void;
  resizedTo(cols: number, rows: number): void;
}

function fakeTerminal(): FakeTerminal {
  const written: Array<Uint8Array | string> = [];
  let dataListener: ((data: string) => void) | null = null;
  let resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
  const disposable = (clear: () => void): TerminalDisposable => ({ dispose: clear });

  const terminal: FakeTerminal = {
    cols: 80,
    rows: 24,
    written,
    disposed: false,
    opened: null,
    open: (host) => {
      terminal.opened = host;
    },
    write: (data) => {
      written.push(data);
    },
    onData: (listener) => {
      dataListener = listener;
      return disposable(() => {
        dataListener = null;
      });
    },
    onResize: (listener) => {
      resizeListener = listener;
      return disposable(() => {
        resizeListener = null;
      });
    },
    focus: () => undefined,
    fit: () => ({ cols: 80, rows: 24 }),
    text: () => written.map((chunk) => decode(chunk)).join(''),
    dispose: () => {
      terminal.disposed = true;
    },
    typed: (text) => dataListener?.(text),
    resizedTo: (cols, rows) => resizeListener?.({ cols, rows }),
  };
  return terminal;
}

function decode(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}

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

  // ------------------------------------------------- the negative control
  it('kills on an explicit close — otherwise the guard above guards nothing', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.close(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual(['detach', 'kill']);
    expect(h.session.calls.at(-1)?.args[0]).toBe('s1');
    expect(h.terminals[0]?.disposed).toBe(true);
    expect(h.registry.inspect(h.pane.id)).toBeUndefined();
    expect(h.registry.paneIds()).toEqual([]);
  });

  it('kills a pane closed while unmounted — the session was still running', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.registry.detach(h.pane.id);
    await h.registry.settled();
    h.session.calls.length = 0;

    h.registry.close(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual(['detach', 'kill']);
  });

  it('does not kill a session that already exited', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    await h.registry.settled();
    h.session.emitExit('s1', 0);
    h.session.calls.length = 0;

    h.registry.close(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual([]);
  });

  it('a pane closed before its create runs never spawns a shell at all', async () => {
    const h = harness();
    h.registry.attach(h.pane, h.host());
    // Same tick: `close` marks the entry before the queued work reaches `create`.
    h.registry.close(h.pane.id);
    await h.registry.settled();

    expect(h.session.names).toEqual([]);
  });

  it('a close that lands MID-create still kills the session that create returns', async () => {
    const h = harness();
    h.session.deferCreate = true;
    h.registry.attach(h.pane, h.host());
    await Promise.resolve(); // let the queue reach the `await create(...)`
    h.registry.close(h.pane.id);
    h.session.releaseCreates();
    await h.registry.settled();

    // The dangerous ordering: the pane is gone, and a pty exists that nothing
    // in the renderer names any more. It must not be left running.
    expect(h.session.names).toEqual(['create', 'kill']);
    expect(h.session.calls.at(-1)?.args[0]).toBe('s1');
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
    h.registry.close(makePaneId('ghost'));
    await h.registry.settled();
    expect(h.session.calls).toEqual([]);
  });
});
