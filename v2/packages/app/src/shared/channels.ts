// The IPC vocabulary, in one file both processes import. Shared code is loaded
// in main AND renderer, so it may import neither electron nor react (lint).

/** Renderer → main, request/response (`ipcRenderer.invoke`). */
export const INVOKE = {
  sessionCreate: 'session:create',
  sessionAttach: 'session:attach',
  sessionDetach: 'session:detach',
  sessionWrite: 'session:write',
  sessionPaste: 'session:paste',
  sessionResize: 'session:resize',
  sessionKill: 'session:kill',
  layoutGet: 'layout:get',
} as const;

/** Main → renderer, fire-and-forget (`webContents.send`). */
export const EMIT = {
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  layoutChanged: 'layout:changed',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];
export type EmitChannel = (typeof EMIT)[keyof typeof EMIT];
export type Channel = InvokeChannel | EmitChannel;

export const invokeChannels = Object.values(INVOKE) as InvokeChannel[];
export const emitChannels = Object.values(EMIT) as EmitChannel[];

/**
 * Output coalescing budget for `session:data`.
 *
 * One `webContents.send` per pty `onData` floods the channel on `yes`-style
 * output — the renderer then spends its frame budget in IPC deserialization
 * rather than in xterm. Main accumulates and flushes on whichever of these
 * comes first. Retrofitting this after xterm is attached is much more
 * expensive than starting with it, so the numbers live here from day one.
 */
export const COALESCE = {
  /** Flush at most this often; ~half a frame at 60Hz. */
  intervalMs: 8,
  /** …or immediately once this much is pending. */
  maxBytes: 32 * 1024,
} as const;

/**
 * `session:data` payloads are `Uint8Array`, never `string`: decoding in main
 * splits multi-byte sequences across chunk boundaries and mangles them before
 * xterm — which owns the decoder — ever sees them.
 */
export interface SessionDataMessage {
  readonly sessionId: string;
  readonly bytes: Uint8Array;
}

export interface SessionExitMessage {
  readonly sessionId: string;
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * The wire DTOs.
 *
 * Deliberately their own types rather than re-exports of core's `SessionSpec` /
 * `SessionError`: this file is loaded in the renderer, and a type alias is one
 * refactor away from becoming a value import that drags node-pty across the
 * process boundary. Same discipline as the layout's persisted DTOs — a field
 * reaches the wire because somebody wrote it here.
 */
export interface SessionCreateRequest {
  readonly cwd: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly term?: string;
  readonly paneId?: string;
}

export interface SessionDescriptor {
  readonly sessionId: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
}

export interface IpcError {
  readonly code: string;
  readonly message: string;
}

/**
 * Every handler answers with this. A rejected `invoke` in the renderer arrives
 * as an Error whose message has been mangled by Electron's serializer and whose
 * `code` is gone — so failures are values here, exactly as they are in core.
 */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError };
