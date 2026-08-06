import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { color } from '@shepherd/design-tokens';

/**
 * The Electron entry point (electron-vite builds this to `out/main`, and
 * package.json's `main` names the build — Electron's app loader reads that
 * field literally and never consults `exports`, so the source stays the
 * package's public face).
 *
 * P3 opens a window and nothing else: no session host, no IPC registration, no
 * userData redirect and no single-instance lock. Those are P4's, and their
 * order matters — `app.setPath('userData', …)` must run BEFORE
 * `requestSingleInstanceLock()`, because Chromium keys the lock off the
 * user-data dir, and a lock taken first is shared by the dev build and the
 * daily one: the exact isolation the redirect exists to buy. `smoke-session.ts`
 * already pins that ordering.
 *
 * What is here now is the part that would otherwise get skipped later: strict
 * renderer isolation, and a window that does not flash white before React runs.
 */

/** electron-vite sets this in dev; in a packaged build it is absent. */
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL'];

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    // The backdrop token, painted before any HTML exists. Without it the first
    // frame is Chromium's white, which on a dark app reads as a flash.
    backgroundColor: color('ink-deep', 'dark'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload requires an unsandboxed renderer (Electron's own
      // constraint). Context isolation is still on, so the page sees the
      // bridge's functions and nothing else.
      sandbox: false,
    },
  });

  // `show: false` until `ready-to-show`: an empty window that then fills in is
  // the thing every Electron app gets mocked for.
  win.once('ready-to-show', () => win.show());

  // Self-gated: the capture hook is a no-op unless SHEPHERD_CAPTURE is set, and
  // it must work against the built bundle too, not only the dev server.
  captureIfAsked(win);

  if (RENDERER_DEV_URL !== undefined) {
    forwardRendererDiagnostics(win);
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * In dev, put the renderer's console on the terminal running `pnpm dev`.
 *
 * Without this the only place a renderer error appears is a DevTools window
 * nobody has open, so "the app looks fine" and "the app logged a React error on
 * every render" are the same observation. A load failure or a dead renderer is
 * worse: the window just stays empty, with no line anywhere saying why.
 */
function forwardRendererDiagnostics(win: BrowserWindow): void {
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  win.webContents.on('console-message', (details) => {
    const level = levels[details.level as unknown as number] ?? String(details.level);
    process.stdout.write(`[renderer:${level}] ${details.message}\n`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    process.stdout.write(`[renderer:load-failed] ${code} ${description} ${url}\n`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    process.stdout.write(`[renderer:gone] ${details.reason}\n`);
  });
}

/**
 * `SHEPHERD_CAPTURE=/path/out.png pnpm dev` — write one PNG of the window and
 * say so, for a reviewer who cannot look at the screen.
 *
 * `webContents.capturePage()` rather than macOS `screencapture -l <id>`: the
 * latter needs Screen Recording permission, which an automated session does not
 * have (it fails with "could not create image from window", which is
 * indistinguishable from the app not having drawn). This asks the app for its
 * own pixels, so it works with no permission at all.
 */
function captureIfAsked(win: BrowserWindow): void {
  const path = process.env['SHEPHERD_CAPTURE'];
  if (path === undefined || path === '') return;
  win.webContents.once('did-finish-load', () => {
    // A frame after load: `did-finish-load` fires before React's first commit.
    setTimeout(() => {
      void win.webContents
        .capturePage()
        .then((image) => writeFile(path, image.toPNG()))
        .then(() => process.stdout.write(`[capture] wrote ${path}\n`))
        .catch((error: unknown) => process.stdout.write(`[capture] failed ${String(error)}\n`));
    }, 1200);
  });
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
