import { BrowserWindow, ipcMain } from 'electron';
import { toDisposable, type Disposable } from '@shepherd/sdk';
import { INVOKE, type IpcResult } from '../shared/index.ts';

/**
 * One verb: close the window that asked.
 *
 * ⌘W closes the focused *pane*, and only on the last pane does it fall through to
 * the window. As of P4a that distinction is core's — `layout.close` reports
 * `wasLastPane` and `onLastPaneClosed` closes the window in main — so the
 * renderer no longer has to ask, and this channel currently has no caller.
 *
 * It is kept rather than deleted because it is the only sanctioned way for a page
 * to ask at all: `window.close()` from page script is a Chromium-policy coin flip
 * for a window the page did not open. It names no window id — a renderer may only
 * ever close itself.
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
