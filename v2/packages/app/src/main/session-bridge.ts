import type { Clock, Disposable, PaneID, Result, SessionID } from '@shepherd/sdk';
import type {
  ForegroundReading,
  ScreenState,
  SessionError,
  SessionExit,
  SessionResize,
  SessionInfo,
  SessionSpec,
  Viewport,
  WillCreateHook,
} from '@shepherd/core';
import { OutputCoalescer } from '../shared/coalescer.ts';
import {
  EMIT,
  type SessionDataMessage,
  type SessionExitMessage,
  type SessionResizeMessage,
} from '../shared/channels.ts';

/**
 * The main-process half of the session IPC, with the electron API removed.
 *
 * Everything electron-shaped is behind two small interfaces — `SessionHostLike`
 * (what this needs from the kernel) and `RendererTarget` (what it needs from a
 * `WebContents`). `ipc.ts` is the twenty lines that supply the real ones. The
 * split exists so the batching contract can be asserted with exact numbers on a
 * manual clock rather than inferred from a screenshot of a running app.
 */

/** The subset of `SessionHost` this bridge uses. `SessionHost` satisfies it. */
export interface SessionHostLike {
  create(spec: SessionSpec): Result<SessionInfo, SessionError>;
  get(id: SessionID): SessionInfo | undefined;
  list(): SessionInfo[];
  attach(id: SessionID, sink: (bytes: Uint8Array) => void): Result<Disposable, SessionError>;
  write(id: SessionID, data: string | Uint8Array): Result<void, SessionError>;
  paste(id: SessionID, text: string): Result<void, SessionError>;
  resize(id: SessionID, cols: number, rows: number): Result<void, SessionError>;
  kill(id: SessionID, signal?: string): Result<void, SessionError>;
  onExit(listener: (exit: SessionExit) => void): Disposable;
  onResize(listener: (resize: SessionResize) => void): Disposable;
  has(id: SessionID): boolean;
  /**
   * The env-injection seam, and it runs in MAIN even when the ptys do not.
   *
   * What decides a child's environment is the extension host, which lives here —
   * `claude-code` injects the session id and the hook socket path through this.
   * `SessionClient` therefore applies the hooks to the spec BEFORE it crosses the
   * socket, so `shepherdd` never has to know an extension exists. Putting the
   * seam in the daemon instead would have made it load extensions.
   */
  onWillCreate(hook: WillCreateHook): Disposable;
  /**
   * `ScreenState` in process, a promise over a socket. Callers `await` it, which
   * is a no-op for the former — one signature rather than two shapes of the same
   * question.
   */
  screen(id: SessionID): ScreenState | undefined | Promise<ScreenState | undefined>;
  snapshot(id: SessionID, sink: (bytes: Uint8Array) => void): Result<void, SessionError>;
  setViewport(id: SessionID, viewerId: string, viewport: Viewport | undefined): Result<void, SessionError>;
  /**
   * The liveness sweep's only input. A field read in process, a round trip over
   * the socket — `sessions.list` awaits it either way.
   */
  foreground(id: SessionID): ForegroundReading | Promise<ForegroundReading>;
  dispose(): void;
}

/** One renderer that can be sent to. In production this wraps `WebContents`. */
export interface RendererTarget {
  /** Stable per window; the bridge keys its attachments by it. */
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: SessionDataMessage | SessionExitMessage | SessionResizeMessage): void;
}

/**
 * The layout's half of "a leaf carries its session".
 *
 * The binding is made HERE, where a session is created, and not in the renderer
 * that asked for one. That is what makes core's `layout.close` able to end a
 * session at all: ⌘W, `shepherd pane close` and an extension all reach
 * `LayoutStore.close`, which kills through its `SessionSink` — and a store that
 * was never told which session a pane shows would close the pane and leak the
 * pty, while the renderer's own close path double-killed it.
 *
 * A create with no `paneId` binds nothing: a session that no pane shows is a
 * legitimate thing (an extension's, later), and inventing a pane for it would put
 * a lie in the tree.
 */
export interface LayoutBinding {
  bind(pane: PaneID, session: SessionID): void;
  unbind(session: SessionID): void;
}

export interface SessionBridgeOptions {
  readonly clock: Clock;
  readonly intervalMs?: number;
  readonly maxBytes?: number;
  /** Absent = nothing owns a layout yet (a test, or the session smoke). */
  readonly layout?: LayoutBinding;
}

interface Attachment {
  readonly target: RendererTarget;
  readonly coalescer: OutputCoalescer;
  readonly disposable: Disposable;
}

export class SessionBridge {
  readonly #host: SessionHostLike;
  readonly #options: SessionBridgeOptions;
  /** targetId -> sessionId -> attachment. Two windows may watch one session. */
  readonly #attachments = new Map<number, Map<SessionID, Attachment>>();
  readonly #hostExit: Disposable;
  readonly #hostResize: Disposable;

  constructor(host: SessionHostLike, options: SessionBridgeOptions) {
    this.#host = host;
    this.#options = options;
    this.#hostExit = this.#host.onExit((exit) => this.#onSessionExit(exit));
    this.#hostResize = this.#host.onResize((resize) => this.#onSessionResize(resize));
  }

  create(spec: SessionSpec): Result<SessionInfo, SessionError> {
    const created = this.#host.create(spec);
    if (created.ok && spec.paneId !== undefined) {
      this.#options.layout?.bind(spec.paneId, created.value.id);
    }
    return created;
  }

  /**
   * Streams a session to a renderer. Idempotent per (target, session): a
   * remount that re-attaches must not end up with two coalescers doubling every
   * byte, which is the shape the "React unmount kills the session" bug takes
   * once sessions correctly survive unmounting.
   */
  attach(target: RendererTarget, id: SessionID): Result<SessionInfo, SessionError> {
    const existing = this.#attachments.get(target.id)?.get(id);
    if (existing) {
      const info = this.#host.get(id);
      return info ? okOf(info) : errOf(unknown(id));
    }

    const coalescer = new OutputCoalescer({
      clock: this.#options.clock,
      ...(this.#options.intervalMs === undefined ? {} : { intervalMs: this.#options.intervalMs }),
      ...(this.#options.maxBytes === undefined ? {} : { maxBytes: this.#options.maxBytes }),
      flush: (bytes) => {
        if (target.isDestroyed()) return;
        target.send(EMIT.sessionData, { sessionId: id, bytes });
      },
    });

    const attached = this.#host.attach(id, (bytes) => coalescer.push(bytes));
    if (!attached.ok) {
      coalescer.dispose();
      return attached;
    }

    const info = this.#host.get(id);
    if (!info) {
      // Raced its own exit between attach and get. Unwind rather than leave a
      // subscription pointing at a session nobody can name.
      attached.value.dispose();
      coalescer.dispose();
      return errOf(unknown(id));
    }

    let byTarget = this.#attachments.get(target.id);
    if (!byTarget) {
      byTarget = new Map();
      this.#attachments.set(target.id, byTarget);
    }
    byTarget.set(id, { target, coalescer, disposable: attached.value });
    return okOf(info);
  }

  detach(target: RendererTarget, id: SessionID): void {
    const byTarget = this.#attachments.get(target.id);
    const attachment = byTarget?.get(id);
    if (!attachment || !byTarget) return;
    attachment.disposable.dispose();
    attachment.coalescer.dispose();
    byTarget.delete(id);
    if (byTarget.size === 0) this.#attachments.delete(target.id);
  }

  /** A window went away. Its sessions keep running; only its viewers go. */
  detachAll(targetId: number): void {
    const byTarget = this.#attachments.get(targetId);
    if (!byTarget) return;
    for (const attachment of byTarget.values()) {
      attachment.disposable.dispose();
      attachment.coalescer.dispose();
    }
    this.#attachments.delete(targetId);
  }

  write(id: SessionID, data: string | Uint8Array): Result<void, SessionError> {
    return this.#host.write(id, data);
  }

  paste(id: SessionID, text: string): Result<void, SessionError> {
    return this.#host.paste(id, text);
  }

  resize(id: SessionID, cols: number, rows: number): Result<void, SessionError> {
    return this.#host.resize(id, cols, rows);
  }

  kill(id: SessionID): Result<void, SessionError> {
    return this.#host.kill(id);
  }

  list(): SessionInfo[] {
    return this.#host.list();
  }

  dispose(): void {
    for (const targetId of [...this.#attachments.keys()]) this.detachAll(targetId);
    this.#hostExit.dispose();
    this.#hostResize.dispose();
  }

  /**
   * Tell every viewer of this session its new grid.
   *
   * No flush and no teardown, unlike an exit: the session is alive, and the
   * snapshot that repaints it is already on its way through `onData`.
   */
  #onSessionResize(resize: SessionResize): void {
    const message: SessionResizeMessage = {
      sessionId: resize.sessionId,
      cols: resize.cols,
      rows: resize.rows,
    };
    for (const byTarget of [...this.#attachments.values()]) {
      const attachment = byTarget.get(resize.sessionId);
      if (!attachment || attachment.target.isDestroyed()) continue;
      attachment.target.send(EMIT.sessionReshaped, message);
    }
  }

  #onSessionExit(exit: SessionExit): void {
    // Before the fan-out: a pane whose program has ended is still a pane, and a
    // snapshot that keeps advertising a dead session id would have the next
    // `layout.close` kill something that no longer exists.
    this.#options.layout?.unbind(exit.sessionId);

    const message: SessionExitMessage = {
      sessionId: exit.sessionId,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    };
    for (const [targetId, byTarget] of [...this.#attachments]) {
      const attachment = byTarget.get(exit.sessionId);
      if (!attachment) continue;
      // Flush BEFORE announcing the exit: the last thing a program prints is
      // usually the thing you wanted to read, and an exit that overtakes it
      // makes the pane look like it died mid-sentence.
      attachment.coalescer.dispose();
      attachment.disposable.dispose();
      byTarget.delete(exit.sessionId);
      if (byTarget.size === 0) this.#attachments.delete(targetId);
      if (!attachment.target.isDestroyed()) {
        attachment.target.send(EMIT.sessionExit, message);
      }
    }
  }
}

// Local Result constructors: importing `ok`/`err` from the sdk here would be
// fine, but these keep the file's only dependency on the sdk a type-only one.
function okOf<T>(value: T): Result<T, SessionError> {
  return { ok: true, value };
}
function errOf(error: SessionError): Result<never, SessionError> {
  return { ok: false, error };
}
function unknown(id: SessionID): SessionError {
  return { code: 'unknown-session', message: `no live session ${id}`, sessionId: id };
}
