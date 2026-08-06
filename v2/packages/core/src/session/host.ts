import { spawn as spawnPty, type IPty } from 'node-pty';
import {
  err,
  ok,
  toDisposable,
  type Disposable,
  type PaneID,
  type Result,
  type SessionID,
} from '@shepherd/sdk';
import { newSessionId, type RandomId } from '../identity.ts';
import { PtyFanout, type PtySink } from './fanout.ts';
import { PtyRing } from './ring.ts';

/**
 * The registry of live PTY sessions. One per terminal, keyed by `SessionID`.
 *
 * Two rules this class exists to enforce, both of them v1 findings:
 *
 *   1. **A session outlives its view.** Nothing here is created or destroyed by
 *      a window, a pane, or a React unmount — only by an explicit `create` /
 *      `kill`. A view attaches and detaches; the pty does not notice.
 *   2. **Bytes, not strings.** The pty is opened with `encoding: null`, so
 *      `onData` yields Buffers and they travel as `Uint8Array` all the way to
 *      xterm, which owns the decoder. Decoding here would split a multi-byte
 *      sequence across a chunk boundary and mangle it before anyone can help.
 *
 * Every failure is a typed `Result`, never a throw: the callers are an IPC
 * handler and (in M1) an extension, and neither should be able to take the main
 * process down by naming a session that has already exited.
 */

export const DEFAULT_RING_BYTES = 256 * 1024;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_TERM = 'xterm-256color';

/** What a caller asks for. Everything optional has a default in `resolveSpec`. */
export interface SessionSpec {
  readonly cwd: string;
  /** Absolute path preferred — core does not read PATH (that is the caller's env). */
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * The child's environment, verbatim. Core deliberately does NOT default this
   * to `process.env`: reading the ambient environment is an OS concern, and the
   * app decides what a session inherits. node-pty adds `TERM` and `PWD` of its
   * own accord — see `resolveSpec`.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly term?: string;
  readonly ringBytes?: number;
  /** Correlation only. The host never looks a session up by pane. */
  readonly paneId?: PaneID;
}

export interface ResolvedSpec {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly term: string;
  readonly ringBytes: number;
  readonly paneId?: PaneID;
}

/** The public view of a live session. A dead one is not in the registry at all. */
export interface SessionInfo {
  readonly id: SessionID;
  readonly pid: number;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly paneId?: PaneID;
}

export interface SessionExit {
  readonly sessionId: SessionID;
  readonly exitCode: number;
  readonly signal?: number;
  readonly paneId?: PaneID;
}

export type SessionErrorCode = 'unknown-session' | 'spawn-failed' | 'invalid-argument';

export interface SessionError {
  readonly code: SessionErrorCode;
  readonly message: string;
  readonly sessionId?: SessionID;
}

/**
 * The env-injection seam. M1's extension host is the first consumer: an agent
 * extension will want `SHEPHERD_SESSION_ID` and a hook socket path in the
 * child, and this is where it puts them — not a special case inside `create`.
 *
 * Synchronous on purpose. `create` returns a `SessionID` that the layout needs
 * in the same tick it decides to open a pane; an async hook would make session
 * creation a promise and every caller a state machine. A hook that needs IO
 * does it at registration time and closes over the answer.
 */
export interface WillCreateEvent {
  readonly sessionId: SessionID;
  /** The spec as resolved so far, with earlier hooks' patches already merged. */
  readonly spec: ResolvedSpec;
}

export interface WillCreatePatch {
  /** Merged over the env, key by key. A later hook wins a collision. */
  readonly env?: Readonly<Record<string, string>>;
}

export type WillCreateHook = (event: WillCreateEvent) => WillCreatePatch | void;

export interface SessionHostOptions {
  readonly newId?: RandomId;
  readonly defaultRingBytes?: number;
  /**
   * Where a swallowed failure goes. There is no logger in core, and "a hook
   * threw and its env silently did not apply" is exactly the branch v1's
   * logging rule exists to catch — so the host reports rather than hides it.
   */
  readonly onError?: (error: unknown, context: string) => void;
}

interface SessionRecord {
  readonly info: SessionInfo;
  readonly pty: IPty;
  readonly fanout: PtyFanout;
  cols: number;
  rows: number;
  exited: boolean;
}

export class SessionHost {
  readonly #sessions = new Map<SessionID, SessionRecord>();
  readonly #willCreate: WillCreateHook[] = [];
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #newId: RandomId | undefined;
  readonly #defaultRingBytes: number;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  constructor(options: SessionHostOptions = {}) {
    this.#newId = options.newId;
    this.#defaultRingBytes = options.defaultRingBytes ?? DEFAULT_RING_BYTES;
    this.#onError = options.onError;
  }

  // ---------------------------------------------------------------- lifecycle

  create(spec: SessionSpec): Result<SessionInfo, SessionError> {
    const invalid = validate(spec);
    if (invalid) return err(invalid);

    const id = this.#newId ? newSessionId(this.#newId) : newSessionId();
    const resolved = this.#applyHooks(id, resolveSpec(spec, this.#defaultRingBytes));

    let pty: IPty;
    try {
      pty = spawnPty(resolved.command, [...resolved.args], {
        name: resolved.term,
        cwd: resolved.cwd,
        env: { ...resolved.env },
        cols: resolved.cols,
        rows: resolved.rows,
        // The whole point. `encoding: 'utf8'` (node-pty's default) hands us
        // strings decoded at arbitrary chunk boundaries; null keeps Buffers.
        encoding: null,
      });
    } catch (error) {
      return err({
        code: 'spawn-failed',
        message: `spawn ${resolved.command} in ${resolved.cwd} failed: ${String(error)}`,
        sessionId: id,
      });
    }

    const info: SessionInfo = {
      id,
      pid: pty.pid,
      cwd: resolved.cwd,
      command: resolved.command,
      args: resolved.args,
      cols: resolved.cols,
      rows: resolved.rows,
      ...(resolved.paneId === undefined ? {} : { paneId: resolved.paneId }),
    };

    const record: SessionRecord = {
      info,
      pty,
      fanout: new PtyFanout(new PtyRing(resolved.ringBytes)),
      cols: resolved.cols,
      rows: resolved.rows,
      exited: false,
    };
    this.#sessions.set(id, record);

    pty.onData((chunk: string | Buffer) => {
      record.fanout.feed(toBytes(chunk));
    });

    pty.onExit(({ exitCode, signal }) => {
      this.#reap(id, record, exitCode, signal);
    });

    return ok(info);
  }

  /**
   * Ends a session. `onExit` fires exactly once and the id leaves `list()` —
   * a caller that kills and then lists must not see a corpse, and one that
   * kills twice must not get two exits.
   */
  kill(id: SessionID, signal?: string): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    try {
      record.pty.kill(signal);
    } catch (error) {
      // A pty whose child is already gone throws EIO/ESRCH here. The process is
      // dead either way; reap it rather than reporting a failure that isn't one.
      this.#onError?.(error, `kill(${id})`);
      this.#reap(id, record, 0, undefined);
    }
    return ok(undefined);
  }

  /** Kills every session. For app teardown; leaves the host reusable. */
  dispose(): void {
    for (const id of [...this.#sessions.keys()]) this.kill(id);
    this.#sessions.clear();
    this.#exitListeners.clear();
    this.#willCreate.length = 0;
  }

  // ------------------------------------------------------------------ queries

  /** Live sessions only. A dead id returns undefined. */
  get(id: SessionID): SessionInfo | undefined {
    const record = this.#sessions.get(id);
    if (!record) return undefined;
    return { ...record.info, cols: record.cols, rows: record.rows };
  }

  list(): SessionInfo[] {
    return [...this.#sessions.keys()].map((id) => this.get(id)).filter(isDefined);
  }

  has(id: SessionID): boolean {
    return this.#sessions.has(id);
  }

  /** The replay ring's contents, for a caller that wants them without attaching. */
  snapshot(id: SessionID): Uint8Array | undefined {
    return this.#sessions.get(id)?.fanout.snapshot();
  }

  // ------------------------------------------------------------------- streams

  /**
   * Registers `sink` and replays the ring to it in ONE step (see `PtyFanout`):
   * the first bytes a sink receives are the screen it missed, and the live
   * bytes continue from there with no gap and no duplicate.
   */
  attach(id: SessionID, sink: PtySink): Result<Disposable, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    return ok(record.fanout.attach(sink));
  }

  write(id: SessionID, data: string | Uint8Array): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    record.pty.write(typeof data === 'string' ? data : asBuffer(data));
    return ok(undefined);
  }

  /**
   * Multi-line text, newlines normalized to CR — a pty carries Enter as `\r`,
   * and an `\n` reaches a shell as a literal linefeed it will not act on.
   *
   * Deliberately does NOT wrap the text in `ESC[200~`/`ESC[201~`. Bracketed
   * paste is a mode the *running program* enables and the *emulator* honours;
   * in v2 the emulator is xterm.js in the renderer, which knows the mode and
   * brackets on its own. Doing it here too would double the markers.
   */
  paste(id: SessionID, text: string): Result<void, SessionError> {
    return this.write(id, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
  }

  resize(id: SessionID, cols: number, rows: number): Result<void, SessionError> {
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) {
      return err({
        code: 'invalid-argument',
        message: `resize needs positive integers, got ${cols}x${rows}`,
        sessionId: id,
      });
    }
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    if (record.cols === cols && record.rows === rows) return ok(undefined);
    record.cols = cols;
    record.rows = rows;
    record.pty.resize(cols, rows);
    return ok(undefined);
  }

  // -------------------------------------------------------------------- events

  onExit(listener: (exit: SessionExit) => void): Disposable {
    this.#exitListeners.add(listener);
    return toDisposable(() => {
      this.#exitListeners.delete(listener);
    });
  }

  onWillCreate(hook: WillCreateHook): Disposable {
    this.#willCreate.push(hook);
    return toDisposable(() => {
      const at = this.#willCreate.indexOf(hook);
      if (at >= 0) this.#willCreate.splice(at, 1);
    });
  }

  // -------------------------------------------------------------------- internals

  #applyHooks(id: SessionID, spec: ResolvedSpec): ResolvedSpec {
    let current = spec;
    for (const hook of this.#willCreate) {
      let patch: WillCreatePatch | void;
      try {
        patch = hook({ sessionId: id, spec: current });
      } catch (error) {
        // One bad hook must not stop a terminal opening — but it must not be
        // invisible either, which is what `onError` is for.
        this.#onError?.(error, `onWillCreate hook for ${id}`);
        continue;
      }
      if (patch?.env) current = { ...current, env: { ...current.env, ...patch.env } };
    }
    return current;
  }

  #reap(id: SessionID, record: SessionRecord, exitCode: number, signal: number | undefined): void {
    if (record.exited) return;
    record.exited = true;
    this.#sessions.delete(id);

    const exit: SessionExit = {
      sessionId: id,
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      ...(record.info.paneId === undefined ? {} : { paneId: record.info.paneId }),
    };
    for (const listener of [...this.#exitListeners]) {
      try {
        listener(exit);
      } catch (error) {
        this.#onError?.(error, `onExit listener for ${id}`);
      }
    }
    // After the exit has been announced: a sink still attached would otherwise
    // hold the ring (and the window's IPC channel) alive for a dead session.
    record.fanout.clear();
  }
}

// ------------------------------------------------------------------ free helpers

export function resolveSpec(spec: SessionSpec, defaultRingBytes = DEFAULT_RING_BYTES): ResolvedSpec {
  return {
    cwd: spec.cwd,
    command: spec.command,
    args: spec.args ? [...spec.args] : [],
    env: { ...(spec.env ?? {}) },
    cols: spec.cols ?? DEFAULT_COLS,
    rows: spec.rows ?? DEFAULT_ROWS,
    term: spec.term ?? DEFAULT_TERM,
    ringBytes: spec.ringBytes ?? defaultRingBytes,
    ...(spec.paneId === undefined ? {} : { paneId: spec.paneId }),
  };
}

function validate(spec: SessionSpec): SessionError | undefined {
  if (!spec.command) {
    return { code: 'invalid-argument', message: 'command is required' };
  }
  if (!spec.cwd) {
    return { code: 'invalid-argument', message: 'cwd is required' };
  }
  if (spec.cols !== undefined && !isPositiveInt(spec.cols)) {
    return { code: 'invalid-argument', message: `cols must be a positive integer, got ${spec.cols}` };
  }
  if (spec.rows !== undefined && !isPositiveInt(spec.rows)) {
    return { code: 'invalid-argument', message: `rows must be a positive integer, got ${spec.rows}` };
  }
  return undefined;
}

function unknownSession(id: SessionID): SessionError {
  return { code: 'unknown-session', message: `no live session ${id}`, sessionId: id };
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * node-pty types `onData` as `IEvent<string>` whatever the encoding, so the one
 * place the lie is corrected is here. With `encoding: null` every chunk is a
 * Buffer; the string branch is a guard, not an expectation.
 */
function toBytes(chunk: string | Buffer): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
}

/** A view, not a copy — node-pty writes it straight to the socket. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
