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
