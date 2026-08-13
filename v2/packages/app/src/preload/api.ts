import {
  EMIT,
  INVOKE,
  type AgentIndicatorDTO,
  type LayoutSnapshots,
  type SessionDataMessage,
  type SessionExitMessage,
  type SessionResizeMessage,
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
      setViewport: (id, viewerId, viewport) =>
        invoke(INVOKE.sessionViewport, id, viewerId, viewport),
      kill: (id) => invoke(INVOKE.sessionKill, id),
      onData: (listener) => subscribe<SessionDataMessage>(EMIT.sessionData, listener),
      onExit: (listener) => subscribe<SessionExitMessage>(EMIT.sessionExit, listener),
      onResize: (listener) => subscribe<SessionResizeMessage>(EMIT.sessionReshaped, listener),
    },
    commands: {
      // `args` defaults to `{}` rather than travelling as `undefined`: every
      // layout command's schema is an object, and `s.object` on `undefined` is
      // an `invalid-args` failure for a gesture that simply took no arguments.
      invoke: (command, args) => invoke(INVOKE.commandInvoke, command, args ?? {}),
      list: () => invoke(INVOKE.commandList),
    },
    layout: {
      get: () => invoke(INVOKE.layoutGet),
      onChanged: (listener) => subscribe<LayoutSnapshots>(EMIT.layoutChanged, listener),
      setViewport: (rect) => invoke(INVOKE.layoutViewport, rect),
      snapshot: (paneId) => invoke(INVOKE.layoutSnapshot, paneId),
    },
    agents: {
      get: () => invoke(INVOKE.agentsGet),
      onChanged: (listener) =>
        subscribe<readonly AgentIndicatorDTO[]>(EMIT.agentsChanged, listener),
    },
    /**
     * Contributed views. Note what the page can ask for: WHICH views exist, a
     * named view's rows, and "the user clicked this row". It cannot name a bus
     * topic or a caller — the same refusal `bridge.ts` makes for `invoke`, and
     * the reason a compromised page cannot promote itself here either. Who a
     * click is attributed to is decided in main (D14).
     */
    views: {
      list: () => invoke(INVOKE.viewsList),
      children: (type: string, parent?: string) => invoke(INVOKE.viewsChildren, type, parent),
      activate: (type: string, command: { id: string; args?: unknown }) =>
        invoke(INVOKE.viewsActivate, type, command),
      invoke: (type: string, command: string, args?: unknown) =>
        invoke(INVOKE.viewsInvoke, type, command, args),
      present: (type: string, presents: { id: string; args?: unknown }) =>
        invoke(INVOKE.viewsPresent, type, presents),
      onChanged: (listener: (type: string) => void) => subscribe<string>(EMIT.viewsChanged, listener),
    },
    /**
     * Settings. What the page may ask for: which pages exist, a write, a reset,
     * to be told when a value or the screen's visibility changed, and to ask that
     * the screen be raised or dropped.
     *
     * It cannot name a bus topic, cannot name a caller, and cannot DECIDE whether
     * the screen is up — main owns that, because the same answer feeds
     * `presence.overlay` and ADR 0020 allows exactly one writer of it.
     */
    settings: {
      list: () => invoke(INVOKE.settingsList),
      set: (key, value) => invoke(INVOKE.settingsSet, key, value),
      reset: (key) => invoke(INVOKE.settingsReset, key),
      setOpen: (open) => invoke(INVOKE.settingsOpen, open),
      invoke: (page, command, args) => invoke(INVOKE.settingsInvoke, page, command, args),
      // The payload's type comes from `SettingsApi`, which this object is checked
      // against — never from an `@shepherd/sdk` import. The preload bundle is
      // sandboxed, and a value imported here fails to load the whole script.
      onChanged: (listener) => subscribe(EMIT.settingsChanged, listener),
      onVisibility: (listener) => subscribe<boolean>(EMIT.settingsVisibility, listener),
    },
    window: {
      close: () => invoke(INVOKE.windowClose),
    },
  };
}
