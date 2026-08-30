import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { paneId as paneIdOf, sessionId, toDisposable, type Disposable, type SessionID } from '@shepherd/sdk';
import type { SessionError, SessionSpec } from '@shepherd/core';
import {
  INVOKE,
  type IpcResult,
  type SessionCreateRequest,
  type SessionDescriptor,
} from '../shared/index.ts';
import type { RendererTarget, SessionBridge } from './session-bridge.ts';

/**
 * The electron-shaped twenty lines. Everything with a decision in it lives in
 * `SessionBridge`, which imports no electron and is therefore tested with exact
 * numbers rather than by running the app and looking at it.
 *
 * Two things this layer owes the bridge:
 *   - **Validation.** A renderer message is a value from another process; a
 *     compromised one may send anything. Every field is checked here, and a bad
 *     one comes back as an `IpcResult` error rather than throwing inside main.
 *   - **Teardown.** A `WebContents` that goes away must take its attachments
 *     with it, or the bridge keeps a coalescer flushing into a dead channel.
 */

/** `WebContents` as the bridge sees it. */
function targetFor(contents: WebContents): RendererTarget {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    send: (channel, payload) => contents.send(channel, payload),
  };
}

/**
 * What a create request inherits when the renderer does not say. Supplied by
 * main from `@shepherd/platform-darwin` — the renderer has no `$SHELL`.
 */
export interface SessionDefaults {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface SessionIpcOptions {
  readonly defaults: SessionDefaults;
  /**
   * The screen this pane was staged to be born showing, if any — consumed once.
   *
   * The renderer asks for a session; the SEED belongs to the pane, and the
   * layout is what holds it. Attaching it here rather than sending it through
   * the create request keeps a screenful of bytes off the renderer's wire and
   * out of a page's reach — a page that could seed a mirror could paint anything
   * into any terminal's scrollback.
   */
  readonly takeSeed?: (paneId: string) => Uint8Array | undefined;
}

export function registerSessionIpc(
  bridge: SessionBridge,
  options: SessionIpcOptions,
): Disposable {
  const seenTargets = new Set<number>();

  const watch = (contents: WebContents): void => {
    if (seenTargets.has(contents.id)) return;
    seenTargets.add(contents.id);
    contents.once('destroyed', () => {
      seenTargets.delete(contents.id);
      bridge.detachAll(contents.id);
    });
  };

  const handle = <T>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, args: unknown[]) => IpcResult<T>,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      watch(event.sender);
      try {
        return fn(event, args);
      } catch (error) {
        // A handler that throws rejects the renderer's promise with a mangled
        // message and no code. Failures are values on this boundary.
        return fail('handler-threw', String(error));
      }
    });
  };

  handle(INVOKE.sessionCreate, (_event, args) => {
    const spec = parseCreate(args[0], options.defaults);
    if (!spec.ok) return spec;
    // One-shot, and taken at the moment the session is actually made: a restored
    // pane replays its screen once, and a pane whose session dies and is
    // replaced comes back empty rather than replaying a screen from before the
    // task was shelved.
    const seed = spec.value.paneId === undefined ? undefined : options.takeSeed?.(spec.value.paneId);
    const created = bridge.create(seed === undefined ? spec.value : { ...spec.value, seed });
    return created.ok ? okValue(describe(created.value)) : failFrom(created.error);
  });

  handle(INVOKE.sessionAttach, (event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    const attached = bridge.attach(targetFor(event.sender), id.value);
    return attached.ok ? okValue(describe(attached.value)) : failFrom(attached.error);
  });

  handle(INVOKE.sessionDetach, (event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    bridge.detach(targetFor(event.sender), id.value);
    return okValue(undefined);
  });

  handle(INVOKE.sessionWrite, (_event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    const data = args[1];
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      return fail('invalid-argument', 'write expects a string or Uint8Array');
    }
    const written = bridge.write(id.value, data);
    return written.ok ? okValue(undefined) : failFrom(written.error);
  });

  handle(INVOKE.sessionPaste, (_event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    if (typeof args[1] !== 'string') return fail('invalid-argument', 'paste expects a string');
    const pasted = bridge.paste(id.value, args[1]);
    return pasted.ok ? okValue(undefined) : failFrom(pasted.error);
  });

  handle(INVOKE.sessionResize, (_event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    const cols = args[1];
    const rows = args[2];
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) {
      return fail('invalid-argument', 'resize expects two positive integers');
    }
    const resized = bridge.resize(id.value, cols, rows);
    return resized.ok ? okValue(undefined) : failFrom(resized.error);
  });

  /**
   * A viewer's opinion about the size, or its withdrawal. See
   * `SessionApi.setViewport`.
   *
   * A malformed viewport is refused rather than coerced: `arbitrate` treats a
   * non-positive dimension as "not measured yet" and a caller that meant to
   * withdraw must say `null`, so silently turning junk into either one would
   * make the pty's size depend on which reading it got.
   */
  handle(INVOKE.sessionViewport, (_event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    if (typeof args[1] !== 'string' || args[1] === '') {
      return fail('invalid-argument', 'setViewport expects a viewer id');
    }
    const viewport = args[2];
    if (viewport === null || viewport === undefined) {
      const cleared = bridge.setViewport(id.value, args[1], undefined);
      return cleared.ok ? okValue(undefined) : failFrom(cleared.error);
    }
    if (typeof viewport !== 'object') {
      return fail('invalid-argument', 'setViewport expects a viewport or null');
    }
    const { cols, rows } = viewport as { cols?: unknown; rows?: unknown };
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) {
      return fail('invalid-argument', 'a viewport needs two positive integers');
    }
    const set = bridge.setViewport(id.value, args[1], { cols, rows });
    return set.ok ? okValue(undefined) : failFrom(set.error);
  });

  return toDisposable(() => {
    for (const channel of [
      INVOKE.sessionCreate,
      INVOKE.sessionAttach,
      INVOKE.sessionDetach,
      INVOKE.sessionWrite,
      INVOKE.sessionPaste,
      INVOKE.sessionResize,
      INVOKE.sessionViewport,
    ]) {
      ipcMain.removeHandler(channel);
    }
    seenTargets.clear();
  });
}

// ------------------------------------------------------------------ validation

function okValue<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function failFrom(error: SessionError): IpcResult<never> {
  return { ok: false, error: { code: error.code, message: error.message } };
}

function describe(info: {
  id: SessionID;
  pid: number;
  cols: number;
  rows: number;
}): SessionDescriptor {
  return { sessionId: info.id, pid: info.pid, cols: info.cols, rows: info.rows };
}

function parseId(raw: unknown): IpcResult<SessionID> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail('invalid-argument', 'sessionId must be a non-empty string');
  }
  return okValue(sessionId(raw));
}

function parseCreate(raw: unknown, defaults: SessionDefaults): IpcResult<SessionSpec> {
  if (typeof raw !== 'object' || raw === null) {
    return fail('invalid-argument', 'create expects an object');
  }
  const request = raw as Partial<SessionCreateRequest>;
  if (request.cwd !== undefined && (typeof request.cwd !== 'string' || request.cwd.length === 0)) {
    return fail('invalid-argument', 'cwd must be a non-empty string');
  }
  if (
    request.command !== undefined &&
    (typeof request.command !== 'string' || request.command.length === 0)
  ) {
    return fail('invalid-argument', 'command must be a non-empty string');
  }
  if (request.args !== undefined && !isStringArray(request.args)) {
    return fail('invalid-argument', 'args must be an array of strings');
  }
  if (request.env !== undefined && !isStringRecord(request.env)) {
    return fail('invalid-argument', 'env must be a record of strings');
  }
  for (const key of ['cols', 'rows'] as const) {
    const value = request[key];
    if (value !== undefined && !isPositiveInt(value)) {
      return fail('invalid-argument', `${key} must be a positive integer`);
    }
  }
  // A request that names a command names its own args too: inheriting `-l`
  // from the default login shell would append it to somebody else's argv.
  const namesCommand = request.command !== undefined;
  return okValue({
    cwd: request.cwd ?? defaults.cwd,
    command: request.command ?? defaults.command,
    args: request.args === undefined ? (namesCommand ? [] : [...defaults.args]) : [...request.args],
    env: request.env === undefined ? { ...defaults.env } : { ...request.env },
    ...(request.cols === undefined ? {} : { cols: request.cols }),
    ...(request.rows === undefined ? {} : { rows: request.rows }),
    ...(typeof request.term === 'string' ? { term: request.term } : {}),
    ...(typeof request.paneId === 'string' ? { paneId: paneIdOf(request.paneId) } : {}),
  });
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}
