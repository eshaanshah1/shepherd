import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { color } from '@shepherd/design-tokens';
import { appName, shellDefaults } from '@shepherd/platform-darwin';
import { CommandRegistry, SessionHost, emptyGrants } from '@shepherd/core';
import { LayoutStore, registerLayoutCommands } from '@shepherd/core/layout';
import { createLogger, rootId, systemClock } from '@shepherd/sdk';
import { IS_DEV } from './build-flags.ts';
import {
  bootstrap,
  flagValue,
  resolveUserData,
  EXIT_SECOND_INSTANCE,
} from './bootstrap.ts';
import { windowOptions } from './window-options.ts';
import { SessionBridge } from './session-bridge.ts';
import { registerSessionIpc } from './ipc.ts';
import { registerWindowIpc } from './window-ipc.ts';
import { registerLayoutIpc } from './layout-ipc.ts';
import { installMenu } from './menu.ts';
import { menuDispatcher } from './menu-dispatch.ts';

/**
 * The Electron entry point (electron-vite builds this to `out/main`, and
 * package.json's `main` names the build — Electron's app loader reads that
 * field literally and never consults `exports`, so the source stays the
 * package's public face).
 *
 * Three things are decided here and nowhere else:
 *
 *   - **Which build this is.** `IS_DEV` is substituted into the bundle at build
 *     time (`build-flags.ts`), never read from the environment.
 *   - **Which directory it owns, and only then the lock.** See `bootstrap.ts`;
 *     the order is the isolation, and it is asserted by a test.
 *   - **What the window may do.** `window-options.ts`, likewise asserted.
 *
 * The `SessionHost` is built here and is deliberately NOT owned by a window: it
 * is the registry a React unmount must not be able to reach. Windows come and
 * go against it.
 *
 * P4a adds the other three kernel pieces at the same level, and for the same
 * reason: the `CommandRegistry` (the one verb table every transport dispatches
 * into), the `LayoutStore` (which now owns the pane tree — the renderer projects
 * it), and the `LayoutStore`'s `SessionSink`, which is what makes `layout.close`
 * the thing that ends a session rather than a view's unmount.
 */

/** electron-vite sets this in dev; in a packaged build it is absent. */
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL'];

/** The smoke entries drive the REAL app; these flags are the only triggers. */
const SMOKE = flagValue(process.argv, '--shepherd-smoke');
const PRINT_PATHS = process.argv.includes('--shepherd-print-paths');

function say(line: string): void {
  process.stdout.write(`[shepherd] ${line}\n`);
}

// --- Answer-and-leave mode: which directory would this build own?
//
// It runs BEFORE any lock is requested, so `pnpm smoke:isolation` can ask both
// builds the question without either of them taking a lock or creating a
// directory. `setPath` then `getPath` rather than printing the input, so the
// answer comes out of Electron's own path store.
if (PRINT_PATHS) {
  app.setPath('userData', resolveUserData({ isDev: IS_DEV, argv: process.argv }));
  say(`isDev=${IS_DEV} userData=${app.getPath('userData')}`);
  app.exit(0);
}

// --- userData, then the lock. The order IS the isolation (bootstrap.ts).
const boot = bootstrap({ isDev: IS_DEV, argv: process.argv });
say(`isDev=${boot.isDev} userData=${boot.userData} lock=${boot.hasLock}`);

if (!boot.hasLock) {
  // Another copy owns this user-data dir. Say so and exit NON-ZERO: a silent
  // zero here is the "I double-clicked and nothing happened" bug, and a
  // launcher cannot tell "already running" from "started fine".
  say(`another instance owns ${boot.userData}; exiting`);
  app.exit(EXIT_SECOND_INSTANCE);
}

// --- the kernel. All of it outlives every window and every view.
const logger = createLogger({
  clock: systemClock,
  level: IS_DEV ? 'debug' : 'info',
  // stdout for now, prefixed like everything else this process says. The rotating
  // file v1 had is a later, deliberate addition; what matters today is that a
  // branch ending in "and then nothing happens" has somewhere to say so.
  sink: (line) => process.stdout.write(`[shepherd] ${line}\n`),
});

const host = new SessionHost({
  onError: (error, context) =>
    process.stderr.write(`[shepherd] session ${context}: ${String(error)}\n`),
});

const registry = new CommandRegistry({
  logger,
  // Nothing is granted yet — `PermissionStore` is P5. A `user` caller is always
  // allowed (`authorize`), which is every caller M1's chrome has, so an empty
  // grant set is the honest value rather than a placeholder.
  grants: () => emptyGrants(),
});

/**
 * The layout. Its `SessionSink` is the `SessionHost`, which is the entire reason
 * the sink is a required constructor argument in core: there is no way to build a
 * store that closes a pane and forgets the pty behind it.
 *
 * No `storage`: layout persistence stays unwired until something in main owns a
 * `SqliteStore`. A persisted tree would also make both smokes non-deterministic —
 * they assert "the app opens with one pane", and a previous run's three-pane
 * layout would restore into it.
 */
const layout = new LayoutStore({
  logger,
  clock: systemClock,
  sessions: { kill: (id) => void host.kill(id) },
});

const ROOT = rootId('window-1');

/**
 * Assigned once `registerLayoutIpc` exists, which is inside `whenReady` because
 * that is where every other IPC handler is registered. The bridge is built before
 * it and needs to publish, so the indirection is the seam rather than a second
 * ordering rule to remember. Before assignment there is no renderer to tell.
 */
let publishLayout: () => void = () => undefined;

const bridge = new SessionBridge(host, {
  clock: systemClock,
  // A pane's session is bound where it is created (see `LayoutBinding`), so
  // `layout.close` — from ⌘W, from the CLI, from an extension — is what ends it.
  layout: {
    bind: (pane, session) => {
      layout.bindSession(pane, session);
      publishLayout();
    },
    unbind: (session) => {
      layout.unbindSession(session);
      publishLayout();
    },
  },
});

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow(
    windowOptions({
      // `.cjs`, because a sandboxed renderer's preload is not an ES module.
      preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
      backgroundColor: color('ink-deep', 'dark'),
    }),
  );

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

  const layoutIpc = registerLayoutIpc({ store: layout, registry, root: ROOT });
  publishLayout = layoutIpc.publish;

  registerLayoutCommands({
    store: layout,
    registry,
    // ⌘W's fall-through, decided in exactly one place. Core does not know what a
    // window is; it knows that a root has run out of panes, which is the only
    // case in which closing one may close a window.
    onLastPaneClosed: () => {
      const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (target === undefined) {
        logger.warn('app', 'last pane closed but there is no window to close');
        return;
      }
      target.close();
    },
  });

  // The tree exists before the page can ask for it: `layout:get` is the first
  // thing the renderer does, and a root that is not open yet would answer
  // `no-root` and leave a blank window with nothing anywhere saying why.
  layout.open(ROOT);

  installMenu({
    appName: appName(IS_DEV),
    isDev: IS_DEV,
    dispatch: menuDispatcher(registry, (command, message) =>
      logger.warn('command', `menu ${command}: ${message}`),
    ),
  });

  // `hold` opens no window: it exists so `pnpm smoke:single-instance` can have
  // a live process owning the lock while a second one tries for it.
  if (SMOKE === 'hold') {
    say('holding the lock; waiting to be killed');
    return;
  }

  const win = createWindow();

  if (SMOKE !== undefined) {
    const { runSmoke } = await import('./smoke-registry.ts');
    // The catch is not decoration. Without it a throw inside the smoke becomes
    // an unhandled rejection — a warning on stderr — and the app then exits
    // ZERO, so a broken build reports success. Measured, while proving a
    // negative control: the run printed a TypeError and passed.
    await runSmoke(SMOKE, win, host).catch((error: unknown) => {
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
  // The layout write is debounced (a drag would otherwise write per mousemove),
  // so the pending one has to be forced out here or the last change made before
  // quitting is the one that never lands.
  layout.flush();
  layout.dispose();
  bridge.dispose();
  host.dispose();
});
