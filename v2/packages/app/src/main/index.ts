import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { color } from '@shepherd/design-tokens';
import { appName, resolveAppPaths, shellDefaults } from '@shepherd/platform-darwin';
import { SessionHost } from '@shepherd/core';
import { systemClock } from '@shepherd/sdk';
import { SessionBridge } from './session-bridge.ts';
import { registerSessionIpc } from './ipc.ts';
import { registerWindowIpc } from './window-ipc.ts';
import { installMenu } from './menu.ts';

/**
 * The Electron entry point (electron-vite builds this to `out/main`, and
 * package.json's `main` names the build — Electron's app loader reads that
 * field literally and never consults `exports`, so the source stays the
 * package's public face).
 *
 * Startup order is the load-bearing part, and it is the reverse of the obvious
 * one: `app.setPath('userData', …)` runs BEFORE `requestSingleInstanceLock()`,
 * because Chromium keys the lock off the user-data directory. Locked first, a
 * dev build and the daily one share a lock and the second refuses to launch —
 * the exact isolation the redirect exists to buy. (Measured in the P0 probe;
 * `paths.ts` carries the note and `smoke-session.ts` pins it.)
 *
 * The `SessionHost` is built here, at module scope, and is deliberately NOT
 * owned by a window: it is the registry a React unmount must not be able to
 * reach. Windows come and go against it.
 */

/** electron-vite sets this in dev; in a packaged build it is absent. */
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL'];
const IS_DEV = !app.isPackaged;

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

// --- 1. userData, then the lock. The order IS the isolation.
const paths = resolveAppPaths(IS_DEV);
app.setPath('userData', argValue('--shepherd-user-data') ?? paths.userData);

if (!app.requestSingleInstanceLock()) {
  // Another copy owns this user-data dir. Say so — a silent exit here is the
  // "I double-clicked and nothing happened" bug.
  process.stdout.write('[shepherd] another instance owns this userData dir; exiting\n');
  app.quit();
}

// --- 2. the session registry, which outlives every window and every view.
const host = new SessionHost({
  onError: (error, context) =>
    process.stderr.write(`[shepherd] session ${context}: ${String(error)}\n`),
});
const bridge = new SessionBridge(host, { clock: systemClock });

/** The smoke drives the REAL app; `--shepherd-smoke=terminal` is the only trigger. */
const SMOKE = argValue('--shepherd-smoke');

export function createWindow(): BrowserWindow {
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
      // bridge's functions and nothing else — asserted in the terminal smoke
      // against the real `window.shepherd`, `window.require`, `window.process`.
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  captureIfAsked(win);

  if (RENDERER_DEV_URL !== undefined) {
    forwardRendererDiagnostics(win);
    void win.loadURL(SMOKE === undefined ? RENDERER_DEV_URL : `${RENDERER_DEV_URL}?smoke=1`);
  } else {
    if (SMOKE !== undefined) forwardRendererDiagnostics(win);
    void win.loadFile(
      join(import.meta.dirname, '../renderer/index.html'),
      SMOKE === undefined ? {} : { query: { smoke: '1' } },
    );
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
  // `did-finish-load` fires before React's first commit, so a capture always
  // waits. The delay is settable because a manual run photographs the app
  // AFTER driving it (a keystroke, a menu item), not at startup.
  const delayMs = Number(process.env['SHEPHERD_CAPTURE_DELAY_MS'] ?? '1200');
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents
        .capturePage()
        .then((image) => writeFile(path, image.toPNG()))
        .then(() => process.stdout.write(`[capture] wrote ${path}\n`))
        .catch((error: unknown) => process.stdout.write(`[capture] failed ${String(error)}\n`));
    }, Number.isFinite(delayMs) ? delayMs : 1200);
  });
}

void app.whenReady().then(async () => {
  registerSessionIpc(bridge, { defaults: shellDefaults() });
  registerWindowIpc();
  // No `dispatch` override: a command goes to the focused window's renderer,
  // which is the only process that knows what a pane is.
  installMenu({ appName: appName(IS_DEV), isDev: IS_DEV });

  const win = createWindow();

  if (SMOKE !== undefined) {
    const { runTerminalSmoke } = await import('./smoke-terminal.ts');
    // The catch is not decoration. Without it a throw inside the smoke becomes
    // an unhandled rejection — a warning on stderr — and the app then exits
    // ZERO, so a broken build reports success. Measured, while proving a
    // negative control: the run printed a TypeError and passed.
    await runTerminalSmoke(win, host).catch((error: unknown) => {
      process.stdout.write(`smoke: FAIL threw ${String(error)}\n`);
      app.exit(1);
    });
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  bridge.dispose();
  host.dispose();
});
