import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * The window's construction options, as a value.
 *
 * `new BrowserWindow({ … })` inline is the normal shape and it is untestable:
 * the security posture of this app — whether the page can reach node — is then
 * a literal nobody can assert about without launching Electron and getting
 * inside the renderer. Here it is a function returning an object, so the four
 * flags that matter are pinned by a unit test, and the terminal smoke's check
 * on the real `window.require` becomes confirmation rather than the only proof.
 *
 * The four:
 *   - `contextIsolation: true` — the preload's world is not the page's world,
 *     so the page cannot reach in and rewrite the bridge's functions.
 *   - `nodeIntegration: false` — no `require` in the page.
 *   - `sandbox: true` — the renderer process itself is sandboxed by the OS. This
 *     is what forces the preload to be **CommonJS** (`out/preload/index.cjs`):
 *     a sandboxed preload is not an ES module, and Electron loads it through a
 *     `require` shim that exposes `electron` and little else. The preload needs
 *     exactly `contextBridge` and `ipcRenderer`, so nothing is lost.
 *   - no `enableRemoteModule` at all — `@electron/remote` is the single largest
 *     hole one can open here, and the safest form of "off" is a key that is
 *     absent rather than one set to `false` and later flipped.
 */

export interface WindowOptionsInput {
  /** Absolute path to the built CJS preload. */
  readonly preloadPath: string;
  /**
   * Painted before any HTML exists — without it the first frame is Chromium's
   * white, which on a dark app reads as a flash.
   */
  readonly backgroundColor: string;
  readonly width?: number;
  readonly height?: number;
}

export const DEFAULT_WINDOW_SIZE = { width: 1180, height: 760 } as const;

export function windowOptions(input: WindowOptionsInput): BrowserWindowConstructorOptions {
  return {
    width: input.width ?? DEFAULT_WINDOW_SIZE.width,
    height: input.height ?? DEFAULT_WINDOW_SIZE.height,
    // Shown on `ready-to-show`, so the window never appears mid-paint.
    show: false,
    /**
     * The app draws its own titlebar and macOS keeps the traffic lights.
     *
     * Without this the window has a native bar saying "Shepherd" and the app
     * draws a second band under it saying "SHEPHERD" — two headers stacked, the
     * top one carrying no information the bottom one lacked. The renderer's
     * `.sh-plate` is now that bar, so it reserves the lights' width and marks
     * itself `-webkit-app-region: drag`.
     */
    titleBarStyle: 'hiddenInset',
    backgroundColor: input.backgroundColor,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}
