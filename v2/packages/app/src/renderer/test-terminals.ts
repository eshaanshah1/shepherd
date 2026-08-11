// The renderer's test doubles for the session bridge and for xterm, in one file
// because two test files now need them: `pane-sessions.test.ts`, which is about
// the registry, and `app.test.tsx`, which mounts the REAL registry so it can
// count terminals built across a reshape. A second copy of a spy is a second set
// of behaviours to keep in step, and the count these tests turn on is only
// meaningful if the terminal is the same fake in both.
//
// Not a `.test.ts`, so vitest does not collect it — same as `test-dom.ts`.

import type { SessionApi, SessionCreateRequest, SessionDataMessage, SessionDescriptor, SessionExitMessage, SessionResizeMessage, IpcResult } from '../shared/index.ts';
import type { TerminalDisposable, TerminalLike } from './pane-sessions.ts';

export interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

export class SpySession implements SessionApi {
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

  setViewport(
    sessionId: string,
    viewerId: string,
    viewport: { readonly cols: number; readonly rows: number } | null,
  ): Promise<IpcResult<void>> {
    this.#record('setViewport', sessionId, viewerId, viewport);
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

  resizeListeners: Array<(m: SessionResizeMessage) => void> = [];
  onResize(listener: (message: SessionResizeMessage) => void): () => void {
    this.resizeListeners.push(listener);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
    };
  }

  emitData(sessionId: string, bytes: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener({ sessionId, bytes });
  }

  emitExit(sessionId: string, exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ sessionId, exitCode });
  }
}

export interface FakeTerminal extends TerminalLike {
  /** Mutable here so a test can observe a host-driven reshape. */
  cols: number;
  rows: number;
  readonly written: Array<Uint8Array | string>;
  disposed: boolean;
  opened: HTMLElement | null;
  typed(text: string): void;
  resizedTo(cols: number, rows: number): void;
  /** Every palette this terminal has been repainted in, in order. */
  readonly themes: string[];
}

export function fakeTerminal(): FakeTerminal {
  const written: Array<Uint8Array | string> = [];
  let dataListener: ((data: string) => void) | null = null;
  let resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
  const disposable = (clear: () => void): TerminalDisposable => ({ dispose: clear });

  const themes: string[] = [];
  const terminal: FakeTerminal = {
    cols: 80,
    rows: 24,
    written,
    themes,
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
    // Recorded rather than ignored: the load-bearing claim about a theme change is
    // that a terminal is REPAINTED and not rebuilt, and only a count can say so.
    setTheme: (mode) => void themes.push(mode),
    text: () => written.map((chunk) => decode(chunk)).join(''),
    dispose: () => {
      terminal.disposed = true;
    },
    typed: (text) => dataListener?.(text),
    resizedTo: (cols, rows) => resizeListener?.({ cols, rows }),
    /*
     * Emits `onResize`, because xterm does.
     *
     * It used not to, and that is precisely why the resize storm was invisible
     * here: the registry applies the host's answer with `resize()`, xterm reports
     * it as a fresh measurement, and the registry sent it back — 29,825 round
     * trips in ten seconds in the real app, with every unit test passing. A fake
     * that cannot produce the real thing's events cannot discover its bugs.
     */
    resize: (cols: number, rows: number) => {
      terminal.cols = cols;
      terminal.rows = rows;
      resizeListener?.({ cols, rows });
    },
  };
  return terminal;
}

export function decode(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}
