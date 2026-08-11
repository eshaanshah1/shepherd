import { basename } from 'node:path';
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
import { DEFAULT_SCROLLBACK, TerminalMirror, type ScreenState } from './mirror.ts';
import { arbitrate, type Viewport } from './viewport.ts';

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
  /**
   * A previously captured screen, put into this session's mirror before its pty
   * says anything — what a RESTORED pane is made of.
   *
   * The mirror is the one authority on what a viewer arriving late should see,
   * and a restored pane is the latest possible arrival: the screen it is showing
   * belongs to a pty that ended days ago. Seeding here rather than writing the
   * bytes into one renderer's xterm is what makes the replay reach EVERY viewer
   * — the pane that opened it, and a phone that attaches an hour afterwards.
   *
   * It goes in through the same `feed` a live pty's output does, deliberately:
   * at create time there are no sinks yet, so feeding it lands in the mirror
   * alone, and nothing downstream needs a second case for "this part is a
   * recording".
   */
  readonly seed?: Uint8Array;
  /**
   * Lines the host keeps behind the screen, per session.
   *
   * Scrollback DEPTH, not a byte budget — the `ringBytes` it replaces measured a
   * recording, and the host now keeps a real VT emulator per session instead
   * (see `mirror.ts`).
   */
  readonly scrollback?: number;
  /** Correlation only. The host never looks a session up by pane. */
  readonly paneId?: PaneID;
  /**
   * A CLIENT-MINTED id, for a caller that must know it before a round trip
   * completes.
   *
   * R1's `SessionClient` is the reason: over a socket, `create` cannot both
   * answer synchronously and learn an id the daemon chose. Minting it on the
   * client side is what keeps `SessionHostLike` synchronous, and so keeps
   * `SessionBridge`, the renderer and every smoke unchanged by the move — the
   * alternative was making nine call sites async to serve one transport.
   *
   * Absent (the in-process case) the host mints one, as it always has. Ids are
   * random and namespaced, so a collision is not a thing that happens.
   */
  readonly id?: SessionID;
}

export interface ResolvedSpec {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly term: string;
  readonly scrollback: number;
  readonly paneId?: PaneID;
}

/**
 * What one read of the pty's foreground process says.
 *
 * `hasForegroundProcess` is tri-state on purpose — see `SessionHost.foreground`.
 * `undefined` means the tty could not be read, which a reconciler must not treat
 * as "nothing is running".
 */
export interface ForegroundReading {
  readonly name?: string;
  readonly hasForegroundProcess: boolean | undefined;
}

/**
 * What a raw `pty.process` reading means for a session that ran `command` — the
 * whole decision, as a pure function, so the case that matters is testable
 * without racing a dying pty.
 *
 * `raw` is what node-pty answered: a name, or `undefined` when the tty could not
 * be read. On darwin every failure path returns the latter rather than throwing
 * (bad fd, `tcgetpgrp` -1, `sysctl` -1, empty `p_comm`) — measured against a pty
 * killed mid-read — which is exactly why the unreadable case needs a value of
 * its own and cannot be left to a `catch`.
 *
 * The predicate is deliberately **name-blind**. The obvious alternative is to
 * match the foreground against the agent's own binary name, and it matches
 * nothing: a real `claude` install resolves to a binary named after its version
 * (`2.1.224`), and macOS derives the process name from the resolved executable.
 * A pane's command is the login shell, so while anything at all runs the
 * foreground is *something else*, and when it dies by any means the shell comes
 * back — which is the session's own command, whatever either is called.
 *
 * That same resolution bites the command side: a session spawned as `/bin/sh`
 * reports `bash` on macOS and would read busy forever. A pane must be spawned as
 * the shell's own resolved path, never through a wrapper or a name that execs
 * into a differently-named binary.
 */
export function foregroundReading(raw: string | undefined, command: string): ForegroundReading {
  // Not `false`: "I could not look" is not "nothing is there", and a reconciler
  // that conflated them would demote a live agent over one unreadable tick.
  if (raw === undefined || raw === '') return { hasForegroundProcess: undefined };
  // Basenames, because the spec carries a path (`/bin/zsh`) and the pty reports
  // a bare name (`zsh`).
  return { name: raw, hasForegroundProcess: basename(raw) !== basename(command) };
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

/** The pty's new size, after whatever decided it. */
export interface SessionResize {
  readonly sessionId: SessionID;
  readonly cols: number;
  readonly rows: number;
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
  readonly defaultScrollback?: number;
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
  /**
   * viewerId -> the size that viewer can display. Absent from the map = no
   * opinion, which is the state an extension tap or a read-only viewer stays in
   * forever. See `viewport.ts` for why that distinction is the whole design.
   */
  readonly viewports: Map<string, Viewport>;
  cols: number;
  rows: number;
  exited: boolean;
}

export class SessionHost {
  readonly #sessions = new Map<SessionID, SessionRecord>();
  readonly #willCreate: WillCreateHook[] = [];
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #resizeListeners = new Set<(resize: SessionResize) => void>();
  readonly #newId: RandomId | undefined;
  readonly #defaultScrollback: number;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  constructor(options: SessionHostOptions = {}) {
    this.#newId = options.newId;
    this.#defaultScrollback = options.defaultScrollback ?? DEFAULT_SCROLLBACK;
    this.#onError = options.onError;
  }

  // ---------------------------------------------------------------- lifecycle

  create(spec: SessionSpec): Result<SessionInfo, SessionError> {
    const invalid = validate(spec);
    if (invalid) return err(invalid);

    const id = spec.id ?? (this.#newId ? newSessionId(this.#newId) : newSessionId());
    const resolved = this.#applyHooks(id, resolveSpec(spec, this.#defaultScrollback));

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
      fanout: new PtyFanout(
        new TerminalMirror({
          cols: resolved.cols,
          rows: resolved.rows,
          scrollback: resolved.scrollback,
        }),
      ),
      viewports: new Map(),
      cols: resolved.cols,
      rows: resolved.rows,
      exited: false,
    };
    // BEFORE the pty is wired: the seeded screen is what was there before, and
    // anything the new child says belongs after it.
    if (spec.seed !== undefined && spec.seed.length > 0) record.fanout.feed(spec.seed);

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

  /**
   * The screen as bytes, for a caller that wants it without attaching.
   *
   * Callback-shaped rather than a return value, for the reason in `mirror.ts`:
   * the mirror captures at a point in its write queue, and a synchronous getter
   * would have to serialize a terminal that may still be parsing — which is
   * exactly the bug probe p4 found.
   */
  snapshot(id: SessionID, sink: (bytes: Uint8Array) => void, lines?: number): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    record.fanout.snapshot(sink, lines);
    return ok(undefined);
  }

  /**
   * What is on this session's display right now — core-design §4.1's third
   * tier, which that document defers to "B-lite, post-M4, on-demand".
   *
   * It arrives early and for free: the host runs the emulator anyway, so this is
   * a read rather than a feature. Undefined for an unknown or dead session.
   */
  screen(id: SessionID): ScreenState | undefined {
    return this.#sessions.get(id)?.fanout.screen();
  }

  /**
   * The name of the process currently in the pty's **foreground** — `sh` for an
   * idle shell, `sleep` while a `sleep` runs in it. Measured on macOS; it is
   * node-pty's `IPty.process`, not the pid we spawned.
   *
   * Undefined for an unknown or dead session. node-pty reads this through the
   * tty on every access and a pty whose child is mid-exit can throw, so the
   * throw is reported and answered as "nothing" rather than escaping into a
   * sweep that runs on a timer.
   *
   * For the first tick or so after spawn it answers with the command *path* we
   * handed it — node-pty's own fallback for a tty it cannot read yet. Harmless
   * here (the predicate below reads that as "the session's own command"), but it
   * is why a test must wait on the settled NAME and not on the predicate.
   */
  /**
   * The pty's foreground process name, and what that implies — **from one read**.
   *
   * Both answers come from a single `pty.process` access on purpose: sampling
   * twice can report `{name: 'sleep', hasForegroundProcess: false}` if a child
   * exits between them, and a self-contradictory pair is worse than either
   * answer alone for a caller trying to cross-check.
   *
   * `hasForegroundProcess` is `undefined` — **never `false`** — when the tty
   * could not be read, and that distinction is the whole point. node-pty does
   * not throw here: on darwin every failure path (bad fd, `tcgetpgrp` -1,
   * `sysctl` -1, empty `p_comm`) returns NULL and surfaces as `undefined`,
   * measured over a pty killed mid-read. Collapsing that into `false` would hand
   * the reconciliation sweep its demote signal for a live, working agent whose
   * tty was merely unreadable for a tick, with nothing anywhere saying why. So
   * an unreadable tty is reported through `onError` and answered as "cannot
   * tell", and the sweep is expected to fail toward NOT demoting.
   */
  foreground(id: SessionID): ForegroundReading {
    const record = this.#sessions.get(id);
    // A session that is gone is running nothing, and its exit is the exact
    // signal for that case — so this is knowledge, not an absence of it.
    if (!record) return { hasForegroundProcess: false };

    let raw: string | undefined;
    try {
      // node-pty types this `string`; on darwin it is genuinely `string |
      // undefined`, and the cast is what makes that lie visible.
      raw = record.pty.process as string | undefined;
    } catch (error) {
      // Kept for platforms where this IS a throw. On darwin it is not, which is
      // why `foregroundReading` carries the unreadable case rather than this.
      this.#onError?.(error, `foreground(${id})`);
      return { hasForegroundProcess: undefined };
    }

    const reading = foregroundReading(raw, record.info.command);
    if (reading.name === undefined) {
      // The branch that must never be silent: the sweep is about to be told
      // "cannot tell", and without this nothing anywhere says why.
      this.#onError?.(
        new Error(`node-pty could not read the foreground process of ${id}`),
        `foreground(${id})`,
      );
    }
    return reading;
  }

  foregroundProcess(id: SessionID): string | undefined {
    return this.foreground(id).name;
  }

  /**
   * Whether anything is running in front of the session's own command — the
   * input to the liveness reconciler, which asks "state says working; is it?".
   *
   * The predicate is deliberately **name-blind**. The obvious alternative is to
   * match the foreground against the agent's own binary name, and it matches
   * nothing: a real `claude` install resolves to a binary named after its
   * version (`2.1.224`), and macOS derives the process name from the resolved
   * executable. A pane's session command is the login shell, so while anything
   * at all runs the foreground is *something else*, and when it dies by any
   * means the shell comes back — which is the session's own command, whatever
   * either of them happens to be called.
   *
   * Basenames, because the spec carries a path (`/bin/bash`) and the pty reports
   * a bare name (`bash`). False for a dead or unknown id: a session that is gone
   * is running nothing, and its exit is the exact signal for that case anyway.
   *
   * The same resolution that defeats name matching bites the command side too:
   * `p_comm` is the RESOLVED executable, so a session spawned as `/bin/sh` on
   * macOS reports `bash` and reads busy forever. A pane must therefore be
   * spawned as the shell's own path, not through a wrapper or an alias.
   *
   * Inverts for a session whose command *is* the long-running program (a
   * headless agent spawned directly, which would read idle while alive). Such a
   * session's liveness is its exit; don't reconcile it from here.
   */
  hasForegroundProcess(id: SessionID): boolean | undefined {
    return this.foreground(id).hasForegroundProcess;
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
    // The mirror is the authority on the screen, so it is resized WITH the pty
    // rather than told afterwards: a program redrawing into its new size would
    // otherwise be parsed against the old one, and every late viewer would be
    // handed a screen that is wrong in a way nothing else reveals.
    record.fanout.resize(cols, rows);
    // Announced, because a viewer that is not told keeps painting into the old
    // grid. Nothing else can discover this: the bytes are valid either way.
    for (const listener of [...this.#resizeListeners]) {
      try {
        listener({ sessionId: id, cols, rows });
      } catch (error) {
        this.#onError?.(error, `onResize listener for ${id}`);
      }
    }
    return ok(undefined);
  }

  /**
   * Declares what `viewerId` can display, and re-arbitrates the pty's size.
   *
   * `undefined` withdraws the opinion, which is what a detaching viewer does —
   * so a phone that goes away stops constraining the Mac it was letterboxing.
   * A viewer that never calls this never influences the size at all, which is
   * v1's "viewer-not-resizer" rule expressed as the absence of an entry rather
   * than as a flag somebody has to remember to set.
   */
  setViewport(
    id: SessionID,
    viewerId: string,
    viewport: Viewport | undefined,
  ): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));

    if (viewport === undefined) record.viewports.delete(viewerId);
    else record.viewports.set(viewerId, viewport);

    const decided = arbitrate([...record.viewports.values()]);
    // Nobody has an opinion: leave the pty as it is rather than snapping it to a
    // default, which would reflow a running program for no reason at all.
    if (decided === undefined) return ok(undefined);
    return this.resize(id, decided.cols, decided.rows);
  }

  // -------------------------------------------------------------------- events

  /**
   * The pty's size changed — because somebody resized it, or because viewport
   * arbitration decided a new one when a viewer arrived or left.
   */
  onResize(listener: (resize: SessionResize) => void): Disposable {
    this.#resizeListeners.add(listener);
    return toDisposable(() => {
      this.#resizeListeners.delete(listener);
    });
  }

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
    // hold the mirror (and the window's IPC channel) alive for a dead session.
    // `clear` disposes the emulator too — ~0.5 MB per session that would
    // otherwise outlive its pty.
    record.viewports.clear();
    record.fanout.clear();
  }
}

// ------------------------------------------------------------------ free helpers

export function resolveSpec(spec: SessionSpec, defaultScrollback = DEFAULT_SCROLLBACK): ResolvedSpec {
  return {
    cwd: spec.cwd,
    command: spec.command,
    args: spec.args ? [...spec.args] : [],
    env: { ...(spec.env ?? {}) },
    cols: spec.cols ?? DEFAULT_COLS,
    rows: spec.rows ?? DEFAULT_ROWS,
    term: spec.term ?? DEFAULT_TERM,
    scrollback: spec.scrollback ?? defaultScrollback,
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
