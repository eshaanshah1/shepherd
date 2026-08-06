import { BrowserWindow, ipcMain } from 'electron';
import { toDisposable, type Disposable } from '@shepherd/sdk';
import { INVOKE, type IpcResult } from '../shared/index.ts';

/**
 * One verb: close the window that asked.
 *
 * ⌘W closes the focused *pane*, and only on the last pane does it fall through
 * to the window — a distinction only the renderer can make, because only the
 * renderer holds the layout. So the fall-through is a request rather than a
 * menu role, and it names no window id: a renderer may only ever close itself.
 */
export function registerWindowIpc(): Disposable {
  ipcMain.handle(INVOKE.windowClose, (event): IpcResult<void> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || window.isDestroyed()) {
      return { ok: false, error: { code: 'no-window', message: 'sender has no window' } };
    }
    window.close();
    return { ok: true, value: undefined };
  });

  return toDisposable(() => ipcMain.removeHandler(INVOKE.windowClose));
}
