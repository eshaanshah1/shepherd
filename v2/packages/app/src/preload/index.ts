import { contextBridge, ipcRenderer } from 'electron';
import type { ShepherdBridge } from '../shared/index.ts';
import { createBridge, type IpcLike } from './api.ts';

/**
 * The whole preload: adapt `ipcRenderer` to `IpcLike`, build the bridge, expose
 * it. `contextIsolation` stays on and no `ipcRenderer` reaches the page, so the
 * renderer sees the functions named in `BRIDGE_SURFACE` and nothing else — a
 * claim the terminal smoke re-checks against the real `window.shepherd`,
 * together with `window.require` / `window.process` being undefined.
 */
const ipc: IpcLike = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as never);
  },
  off: (channel, listener) => {
    ipcRenderer.off(channel, listener as never);
  },
};

export const shepherdApi: ShepherdBridge = createBridge(ipc);

contextBridge.exposeInMainWorld('shepherd', shepherdApi);
