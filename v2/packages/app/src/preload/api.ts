import {
  EMIT,
  INVOKE,
  type LayoutSnapshot,
  type SessionDataMessage,
  type SessionExitMessage,
  type ShepherdBridge,
} from '../shared/index.ts';

/**
 * The bridge object, built against an interface instead of against electron.
 *
 * `index.ts` supplies the real `ipcRenderer` in nine lines; everything with a
 * decision in it is here, so a test can assert `Object.keys()` against
 * `BRIDGE_SURFACE` without an Electron process. (The half a unit test genuinely
 * cannot answer — whether `window.require` exists in the page — is asserted in
 * the terminal smoke, inside a real renderer.)
 */
export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  off(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

export function createBridge(ipc: IpcLike): ShepherdBridge {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    ipc.invoke(channel, ...args) as Promise<T>;

  const subscribe = <T>(channel: string, listener: (message: T) => void): (() => void) => {
    // The event object is dropped deliberately: handing the renderer an
    // `IpcRendererEvent` would leak `sender`, and with it a way back out of the
    // bridge this file exists to be.
    const wrapped = (_event: unknown, ...args: unknown[]): void => listener(args[0] as T);
    ipc.on(channel, wrapped);
    return () => {
      ipc.off(channel, wrapped);
    };
  };

  return {
    session: {
      create: (request) => invoke(INVOKE.sessionCreate, request),
      attach: (id) => invoke(INVOKE.sessionAttach, id),
      detach: (id) => invoke(INVOKE.sessionDetach, id),
      write: (id, data) => invoke(INVOKE.sessionWrite, id, data),
      paste: (id, text) => invoke(INVOKE.sessionPaste, id, text),
      resize: (id, cols, rows) => invoke(INVOKE.sessionResize, id, cols, rows),
      kill: (id) => invoke(INVOKE.sessionKill, id),
      onData: (listener) => subscribe<SessionDataMessage>(EMIT.sessionData, listener),
      onExit: (listener) => subscribe<SessionExitMessage>(EMIT.sessionExit, listener),
    },
    commands: {
      // `args` defaults to `{}` rather than travelling as `undefined`: every
      // layout command's schema is an object, and `s.object` on `undefined` is
      // an `invalid-args` failure for a gesture that simply took no arguments.
      invoke: (command, args) => invoke(INVOKE.commandInvoke, command, args ?? {}),
    },
    layout: {
      get: () => invoke(INVOKE.layoutGet),
      onChanged: (listener) => subscribe<LayoutSnapshot>(EMIT.layoutChanged, listener),
      setViewport: (rect) => invoke(INVOKE.layoutViewport, rect),
    },
    window: {
      close: () => invoke(INVOKE.windowClose),
    },
  };
}
