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
    const created = bridge.create(spec.value);
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

  handle(INVOKE.sessionKill, (_event, args) => {
    const id = parseId(args[0]);
    if (!id.ok) return id;
    const killed = bridge.kill(id.value);
    return killed.ok ? okValue(undefined) : failFrom(killed.error);
  });

  return toDisposable(() => {
    for (const channel of [
      INVOKE.sessionCreate,
      INVOKE.sessionAttach,
      INVOKE.sessionDetach,
      INVOKE.sessionWrite,
      INVOKE.sessionPaste,
      INVOKE.sessionResize,
      INVOKE.sessionKill,
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
