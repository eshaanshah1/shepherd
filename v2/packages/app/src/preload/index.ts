import { contextBridge, ipcRenderer } from 'electron';
import {
  EMIT,
  INVOKE,
  type IpcResult,
  type SessionCreateRequest,
  type SessionDataMessage,
  type SessionDescriptor,
  type SessionExitMessage,
} from '../shared/index.ts';

/**
 * The renderer's entire view of the main process.
 *
 * `contextIsolation` stays on and no `ipcRenderer` reaches the page: the
 * renderer gets these functions and nothing else, so a compromised page can
 * only say things this file already knows how to say. Note there is no generic
 * `invoke(channel, …)` escape hatch for the same reason.
 *
 * `bytes` crosses as a `Uint8Array` in both directions — never a string. See
 * `channels.ts`: main cannot decode without splitting multi-byte sequences at
 * chunk boundaries, and xterm is the thing that owns the decoder.
 */
export interface SessionApi {
  create(request: SessionCreateRequest): Promise<IpcResult<SessionDescriptor>>;
  attach(sessionId: string): Promise<IpcResult<SessionDescriptor>>;
  detach(sessionId: string): Promise<IpcResult<void>>;
  write(sessionId: string, data: string | Uint8Array): Promise<IpcResult<void>>;
  paste(sessionId: string, text: string): Promise<IpcResult<void>>;
  resize(sessionId: string, cols: number, rows: number): Promise<IpcResult<void>>;
  kill(sessionId: string): Promise<IpcResult<void>>;
  /** Returns an unsubscribe function — a pane that unmounts stops listening. */
  onData(listener: (message: SessionDataMessage) => void): () => void;
  onExit(listener: (message: SessionExitMessage) => void): () => void;
}

export interface ShepherdApi {
  readonly session: SessionApi;
}

export const shepherdApi: ShepherdApi = {
  session: {
    create: (request) => ipcRenderer.invoke(INVOKE.sessionCreate, request),
    attach: (id) => ipcRenderer.invoke(INVOKE.sessionAttach, id),
    detach: (id) => ipcRenderer.invoke(INVOKE.sessionDetach, id),
    write: (id, data) => ipcRenderer.invoke(INVOKE.sessionWrite, id, data),
    paste: (id, text) => ipcRenderer.invoke(INVOKE.sessionPaste, id, text),
    resize: (id, cols, rows) => ipcRenderer.invoke(INVOKE.sessionResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(INVOKE.sessionKill, id),
    onData: (listener) => subscribe(EMIT.sessionData, listener),
    onExit: (listener) => subscribe(EMIT.sessionExit, listener),
  },
};

function subscribe<T>(channel: string, listener: (message: T) => void): () => void {
  // The event object is dropped deliberately: handing the renderer an
  // `IpcRendererEvent` would leak `sender`, and with it a way back out of the
  // bridge this file exists to be.
  const wrapped = (_event: unknown, message: T): void => listener(message);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('shepherd', shepherdApi);
