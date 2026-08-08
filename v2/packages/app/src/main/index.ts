import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { color } from '@shepherd/design-tokens';
import { appName, resolveAppPaths, runExec, runGit, shellDefaults } from '@shepherd/platform-darwin';
import {
  CommandRegistry,
  EventBus,
  ExtensionRegistry,
  PermissionStore,
  SessionHost,
  SqliteStore,
  registerSessionCommands,
} from '@shepherd/core';
import { LayoutStore, registerLayoutCommands } from '@shepherd/core/layout';
import { AttentionStore, ViewingResolver, registerAttentionCommands } from '@shepherd/core';
import { diagnosticsManifest } from '@shepherd/ext-diagnostics/manifest';
import { agentsCoreManifest } from '@shepherd/ext-agents-core/manifest';
import { claudeCodeManifest } from '@shepherd/ext-claude-code/manifest';
import { tasksManifest } from '@shepherd/ext-tasks/manifest';
import { KERNEL, createLogger, extensionId, rootId, systemClock, type RootID } from '@shepherd/sdk';
import { ExtensionHost } from './ext-host.ts';
import { forkExtensionHost } from './ext-host-process.ts';
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
import {
  LOCAL_DEVICE_ID,
  LOCAL_DEVICE_PERMISSIONS,
  resolveSupport,
  startIngress,
  type RunningIngress,
} from './ingress.ts';
import { menuDispatcher } from './menu-dispatch.ts';
import { registerAgentIpc, type AgentIpc } from './agent-ipc.ts';
import { EMIT, INVOKE } from '../shared/index.ts';
import { agentPrincipals } from './agent-principals.ts';
import { ViewRegistry } from './view-registry.ts';
import { createSystemAlerts } from './system-alerts.ts';
import { clearAgentState } from './agent-relay.ts';
import { correlationEnv } from './correlation-env.ts';
import { publishViewingEdges } from './viewing-topic.ts';

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

/**
 * Alerts a smoke can read back.
 *
 * Exported through `globalThis` rather than a module export because the smoke
 * entry is imported dynamically, long after this runs, and a module-level array
 * would be a second instance by then.
 */
const smokeAlerts = {
  notify: (alert: { title: string; body: string; sessionId: string }) => {
    const seen = ((globalThis as { __shepherdAlerts?: unknown[] }).__shepherdAlerts ??= []);
    seen.push(alert);
    say(`alert ${alert.sessionId}: ${alert.title} — ${alert.body}`);
  },
};

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

/**
 * The one store. On disk under this build's own userData, so an extension's
 * `ctx.storage` survives a relaunch — a KV that forgets is a lie, and the smokes
 * already run against a throwaway userData directory so determinism is intact.
 *
 * Deliberately NOT handed to the `LayoutStore` below: a persisted pane tree would
 * restore a previous run's three panes into a smoke that asserts the app opens
 * with one.
 */
const store = new SqliteStore({ location: join(boot.userData, 'store.db'), logger });

/**
 * Who was granted what — review at install, grant once. Built-ins are pre-granted
 * what they declare; the policy lives in `PermissionStore.review`, and
 * `ExtensionRegistry.add` is the moment it runs.
 */
const permissions = new PermissionStore(store.namespace('permissions'), logger);

const registry = new CommandRegistry({
  logger,
  grants: () => ({
    // Extensions and their granted permissions, read per invocation so an install
    // takes effect without anything re-registering.
    ...permissions.grantSet(),
    // MERGED onto the extension grants, not substituted for them: `grantSet()`
    // returns empty `devices`/`agents` maps (it knows only about extensions), so
    // replacing this key would silently deny the local CLI — and every existing
    // leg of `smoke:m1` would start answering 403.
    //
    // See `ingress.ts` for why reaching the local socket is itself the
    // authorization, and for what this deliberately does not extend to.
    devices: new Map([[LOCAL_DEVICE_ID, LOCAL_DEVICE_PERMISSIONS]]),
    // Every live session is a principal (D9b). Derived from the pty host's own
    // inventory rather than a second registry, so there is no revoke path to
    // forget and nothing that can drift; `grants` is read per invocation, which
    // is what makes deriving it here correct rather than stale.
    agents: agentPrincipals(host.list().map((info) => info.id)),
  }),
});

/**
 * The bus. Both ingresses publish onto it and `shepherd wait` subscribes through
 * it, so it is built at this level for the same reason the `SessionHost` is:
 * nothing that comes and goes with a window may own it.
 */
const bus = new EventBus({ clock: systemClock, logger });

/**
 * The layout. Its `SessionSink` is the `SessionHost`, which is the entire reason
 * the sink is a required constructor argument in core: there is no way to build a
 * store that closes a pane and forgets the pty behind it.
 *
 * Persistence is ON (M3 D3). It was built in M0 and left unwired with the note
 * that a restored tree would make the smokes non-deterministic — which is true of
 * exactly one smoke, and not for the reason the note gave. `smoke:m1` and
 * `smoke:m2` mkdtemp a throwaway userData per run, so they open an empty database
 * and have nothing to restore. `smoke-m0` deliberately reuses ONE directory
 * across two passes, to catch a leaked single-instance lock — and that lock is
 * keyed on the DIRECTORY, not on `store.db`, so its runner drops the database
 * between passes and keeps the property it exists for.
 */
const layout = new LayoutStore({
  logger,
  clock: systemClock,
  storage: store.namespace('layout'),
  sessions: { kill: (id) => void host.kill(id) },
});

/**
 * The root the window falls back to — v1's "the window", and the one root that
 * always exists. Every OTHER root is a pane group something else owns (a task
 * owns one; the sidebar switches between them), and those come and go.
 */
const HOME_ROOT = rootId('window-1');

/**
 * Which root the window is currently showing. `layout-ipc.ts` owns the value —
 * it is a property of the window, not of the layout — and this is reassigned to
 * its getter inside `whenReady`, where every other IPC handler is registered.
 * Before then there is no window, so the home root is the only possible answer.
 */
let activeRoot: () => RootID = () => HOME_ROOT;

/**
 * Where the sockets live. Overridable per run — see `SUPPORT_FLAG`; a throwaway
 * userData directory does not isolate a socket derived from `$HOME`.
 */
const support = resolveSupport(process.argv, resolveAppPaths(IS_DEV).support);
const CONTROL_SOCKET = `${support}/control.sock`;
const HOOK_SOCKET = `${support}/hooks.sock`;

/**
 * Every session is created knowing its own id and where to post back — see
 * `correlation-env.ts` for why the kernel is what injects it, and why the
 * variable names are not v1's.
 *
 * Registered here rather than inside `whenReady`, because a session can be
 * created by anything holding the host and this hook has to be in place before
 * the first one is: a pty that started without the env cannot be told later.
 */
host.onWillCreate(({ sessionId }) => ({
  env: correlationEnv({ sessionId, eventsSocket: HOOK_SOCKET, controlSocket: CONTROL_SOCKET }),
}));

let ingress: RunningIngress | undefined;

/**
 * Attention, and the one predicate under it (ADR 0020).
 *
 * `Presence` is set from Electron's own signals below. It carries no `away`:
 * v1's `isAway` (lid shut, no external display) needs a sensor Electron does not
 * expose, so `route()` takes it as a parameter and M1 always passes false. That
 * is the honest shape — a heuristic wearing a predicate's clothes is what the
 * architecture review objected to.
 */
const viewing = new ViewingResolver(
  layout,
  { appActive: true, focusedRoot: HOME_ROOT, overlay: false },
  logger,
);
const attention = new AttentionStore({ layout, viewing, bus, logger });

/**
 * Presence, in one place, because it has two independent inputs now.
 *
 * `appActive` comes from Electron's focus/blur; `focusedRoot` comes from which
 * root is on screen, which the user can change without the app ever losing
 * focus. Recomputing both together is what stops `isFrontPane` from answering
 * about a hidden root — attention would then clear on panes nobody has seen
 * (ADR 0020: viewing is ONE predicate, so it gets one writer).
 */
let appActive = true;

function syncPresence(): void {
  viewing.setPresence({
    appActive,
    // Not ours to be frontmost in: a switch driven from the CLI while the app is
    // in the background must not resurrect a focused root.
    focusedRoot: appActive ? activeRoot() : null,
    overlay: false,
  });
}

/**
 * The same predicate, on the bus as `session.viewing`, for the agent extension a
 * process away — a cache of the one answer, never a second check.
 */
const viewingTopic = publishViewingEdges({ viewing, layout, bus, logger });

/**
 * `session.exit` — a session ended, on the bus.
 *
 * An agent extension holds per-session state a process away: a vendor's
 * ownership lock, its resume id, and whether the user is looking at it. Without
 * this it learns of a death only from the reconciliation sweep, which is a
 * *heuristic over a pty* — so the exact signal would go unused and every dead
 * session would leak an entry until something inferred it.
 */
host.onExit((exit) => {
  bus.emit(
    'session.exit',
    { sessionId: exit.sessionId, exitCode: exit.exitCode, ...(exit.paneId === undefined ? {} : { paneId: exit.paneId }) },
    KERNEL,
  );
});

/**
 * The extension host, and the registry that drives it.
 *
 * The two are mutually dependent by construction — the registry is built *with*
 * the host's `Activator`, and the host reads the registry to answer
 * `extensions.list` and to put extensions back after a crash. The host therefore
 * takes the registry as a getter: it is only ever called from inside an
 * activation, which is long after both exist, and a getter says that out loud
 * where a mutable field somebody has to remember to set would not.
 *
 * `spawn` is injected for the same reason `SessionBridge`'s clock is: the whole
 * decision surface in `ext-host.ts` — caller derivation, the proposed gate, one
 * bounded restart — is then testable without forking a process.
 */
/**
 * Assigned inside `whenReady`, where every other IPC handler is registered. The
 * extension host is built before it and needs to reach it when the child dies,
 * so the indirection is the seam rather than a second ordering rule.
 */
let agentIpc: AgentIpc | undefined;

/**
 * Contributed views (M3 P6). Constructed before the host because the host
 * records contributions into it; the two halves meet here rather than importing
 * each other. `read` goes back through the host, because the provider lives in
 * the child and cannot cross the port.
 */
const views: ViewRegistry = new ViewRegistry({
  read: async (extension, type, parent) =>
    (await extensionHost.readTree(extension, type, parent)) as never,
  invoke: async (command, args, caller) => {
    const result = await registry.invoke(command, args, caller);
    if (!result.ok) logger.warn('app', `a view row's command ${command} failed: ${result.error.message}`);
    return result;
  },
  publish: (type) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send(EMIT.viewsChanged, type);
    }
  },
});

const extensionHost = new ExtensionHost({
  registry,
  // The return type is written out because the two constructions below are
  // mutually recursive, and without it TypeScript has no fixed point to infer.
  extensions: (): ExtensionRegistry => extensions,
  permissions,
  bus,
  kv: (namespace) => store.namespace(namespace),
  support,
  views,
  // The one runner, from the one directory allowed to spawn (Rebuild checklist
  // item 4). Injected rather than imported by the host so a test can prove a
  // denial denies without a real subprocess.
  run: { exec: runExec, git: runGit },
  logger,
  clock: systemClock,
  isDev: IS_DEV,
  /**
   * Developer surfaces are **opt-in, not implied by a dev build**.
   *
   * The dev build is the app being dogfooded daily, so "is this a dev build"
   * is the wrong question for "should the sidebar show instruments for the
   * app's own internals". A smoke asserts on them (it drives the production
   * bundle deliberately), and `--shepherd-dev-views` turns them on by hand.
   */
  devSurfaces: SMOKE !== undefined || process.argv.includes('--shepherd-dev-views'),
  spawn: () => forkExtensionHost({ logger }),
  // Every indicator on screen came from that process. Leaving them is a
  // confident lie — a pane frozen at WORKING after the only thing that could
  // say otherwise is gone.
  onHostGone: (reason) => {
    if (agentIpc === undefined) return;
    clearAgentState({
      relay: agentIpc.relay,
      attention,
      logger,
      reason,
      publish: agentIpc.publish,
      badge: agentIpc.badge,
    });
  },
});

const extensions: ExtensionRegistry = new ExtensionRegistry({
  permissions,
  activator: extensionHost.activator,
  logger,
});

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
      // The pane was focused before it had a session, so its viewing edge has
      // already been and gone. Replay the current value or this session's mirror
      // starts empty and a turn finishing in front of you reads as unseen.
      viewingTopic.announce(pane);
      // D10's one seam, consumed here because this is the first moment there is
      // something to type into. `take` empties it, so a rebind — a pane whose
      // session died and was replaced — does NOT replay the command.
      const initial = layout.takeInitialInput(pane);
      if (initial !== undefined) {
        const written = host.write(session, initial);
        if (!written.ok) {
          logger.warn('layout', `initial input for ${pane} was not delivered: ${written.error.message}`);
        }
      }
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

  const layoutIpc = registerLayoutIpc({
    store: layout,
    registry,
    active: HOME_ROOT,
    // Presence follows the active root, wired here rather than at each switch
    // site so no future caller can move the window without moving the predicate.
    onActiveChanged: () => syncPresence(),
  });
  publishLayout = layoutIpc.publish;
  activeRoot = layoutIpc.getActive;

  registerAttentionCommands({ store: attention, registry });

  // Before the extensions activate, so the first transition an agent publishes
  // has somewhere to land rather than being emitted at nobody.
  // Contributed views: three reads and one gesture. The page names a view type
  // — which main told it about — never a topic and never a caller.
  ipcMain.handle(INVOKE.viewsList, () => ({ ok: true, value: views.list() }));
  ipcMain.handle(INVOKE.viewsChildren, async (_event, type: string, parent?: string) => ({
    ok: true,
    value: await views.children(type, parent),
  }));
  ipcMain.handle(INVOKE.viewsActivate, async (_event, type: string, command: { id: string; args?: unknown }) => {
    await views.activate(type, command);
    return { ok: true, value: undefined };
  });
  /**
   * The same gesture, for a contributed component that has to show the answer.
   *
   * The kernel's own `Result` is what comes back from `ViewRegistry.invoke`, and
   * it is passed through rather than unwrapped: a failed create is a value the
   * form draws ("that path is not a git repo"), not an exception the page has to
   * reconstruct from a mangled Electron error string.
   */
  ipcMain.handle(INVOKE.viewsInvoke, async (_event, type: string, command: string, args?: unknown) => {
    const result = (await views.invoke(type, command, args)) as
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string } }
      | undefined;
    if (result === undefined) {
      // A view nobody owns. Reported rather than silently resolved: a form whose
      // submit does nothing is the "and then nothing happens" branch v1's log
      // rule exists for.
      return { ok: false, error: { code: 'unknown-view', message: `no extension owns the view "${type}"` } };
    }
    if (result.ok) return { ok: true, value: result.value };
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  });

  agentIpc = registerAgentIpc({
    bus,
    layout,
    attention,
    logger,
    // The smoke records alerts instead of raising them: a run that stacked real
    // banners in the user's Notification Center could not assert the one thing
    // ADR 0020 is about — that a turn finishing under your eyes raises nothing.
    alerts: SMOKE === undefined ? createSystemAlerts({ logger }) : smokeAlerts,
  });

  // `sessions.list`, which carries each session's foreground process — the
  // reconciliation sweep's only input, and the reason it needs no subprocess.
  // Registered beside the other kernel verbs and before the sockets open, so a
  // client cannot arrive ahead of the command it wants to invoke.
  registerSessionCommands({
    host,
    registry,
    // The one predicate, answering for each row — so an agent extension's pushed
    // mirror is seeded by the read it already makes rather than by a re-announce
    // mechanism nobody can trigger.
    viewing: (pane) => viewing.isViewing(pane),
  });

  registerLayoutCommands({
    store: layout,
    registry,
    homeRoot: HOME_ROOT,
    activeRoot: layoutIpc.getActive,
    // What "switch" means is the window's business: draw that root, and treat
    // its panes as the ones being looked at. Core validates and delegates.
    onSwitchRoot: (root) => layoutIpc.setActive(root),
    // ⌘W's fall-through, decided in exactly one place. Core does not know what a
    // window is; it knows that a root has run out of panes, which is the only
    // case in which closing one may close a window.
    onLastPaneClosed: (root) => {
      /**
       * Only the HOME root's last pane closes the window. Any other root is a
       * pane group the window merely shows — a task's, say — so running it out
       * of panes means that group is finished with, not that the app is.
       * Switching away FIRST, because a window drawing a root that has just
       * been removed draws nothing at all.
       */
      if (root !== HOME_ROOT) {
        layoutIpc.setActive(HOME_ROOT);
        const removed = layout.removeRoot(root);
        if (!removed.ok) logger.warn('layout', `could not remove ${root}: ${removed.error}`);
        return;
      }
      const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (target === undefined) {
        logger.warn('app', 'last pane closed but there is no window to close');
        return;
      }
      target.close();
    },
  });

  // Extensions, after the command table exists and before the sockets open — so
  // a CLI client cannot arrive before `diagnostics.ping` is registered, and so a
  // built-in's own `commands.register` cannot race the kernel's.
  extensionHost.registerCommands();
  for (const manifest of [diagnosticsManifest, agentsCoreManifest, claudeCodeManifest, tasksManifest]) {
    const added = extensions.add(manifest, 'builtin');
    if (added.ok) continue;
    for (const problem of added.error) {
      logger.error('extension', `built-in ${manifest.id} is unloadable: ${problem.field}: ${problem.message}`);
    }
  }
  // Awaited, and in order, so each child is up and its commands registered
  // before anything can invoke them. A failure is already logged by the registry
  // with the reason kept on its record — `extensions.list` reads it back.
  //
  // `agents-core` is activated explicitly rather than left to its `onStartup`
  // trigger, because `claude-code` will declare it as a dependency and the
  // registry activates dependencies first: doing it here keeps one ordering
  // rather than two that must agree.
  for (const manifest of [diagnosticsManifest, agentsCoreManifest, claudeCodeManifest, tasksManifest]) {
    if (extensions.state(extensionId(manifest.id)) === undefined) continue;
    await extensions.activate(extensionId(manifest.id));
  }

  // The tree exists before the page can ask for it: `layout:get` is the first
  // thing the renderer does, and a root that is not open yet would answer
  // `no-root` and leave a blank window with nothing anywhere saying why.
  //
  // EVERY persisted root, not just the home one. With a root per task, opening
  // only home would leave every task's layout on disk and invisible — and the
  // next write would then persist the roots that had been opened and drop the
  // rest, so "invisible" would quietly become "gone". `open` is idempotent, so
  // home appearing in that list again costs nothing.
  layout.open(HOME_ROOT);
  for (const root of layout.persistedRoots()) layout.open(root);

  // After the lock (held in `bootstrap`) and after the command table is
  // registered, so the first CLI client cannot arrive before there is anything
  // for it to invoke.
  ingress = await startIngress({
    registry,
    bus,
    logger,
    support,
    controlSocket: CONTROL_SOCKET,
    hookSocket: HOOK_SOCKET,
  });

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
    await runSmoke(SMOKE, win, host, {
      bus,
      controlSocket: CONTROL_SOCKET,
      hookSocket: HOOK_SOCKET,
      attentionCount: () => attention.count(),
      layout,
      root: HOME_ROOT,
      alerts: () => ((globalThis as { __shepherdAlerts?: { sessionId: string }[] }).__shepherdAlerts ?? []),
      agentStates: () => agentIpc?.relay.snapshot() ?? [],
    }).catch((error: unknown) => {
      process.stdout.write(`smoke: FAIL threw ${String(error)}\n`);
      app.exit(1);
    });
    return;
  }

  // The two signals Electron does give us. Without these, `isViewing` is frozen
  // at "yes" and a turn that finished while you were in another app would read
  // as one you had already seen — v1's bug, in reverse.
  app.on('browser-window-focus', () => {
    appActive = true;
    syncPresence();
  });
  app.on('browser-window-blur', () => {
    appActive = false;
    syncPresence();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // Unbind the sockets before the process goes: a listener that outlives its app
  // is the corpse `reclaimSocketPath` then has to reason about on the next launch.
  void ingress?.stop();
  // Before anything else that could still be asked of it. `dispose` sets its own
  // shut-down flag FIRST, which is what stops the child's exit from being read as
  // a crash — otherwise quitting would log an error, spend the one restart, and
  // mark every extension failed on the way out.
  extensionHost.dispose();
  attention.dispose();
  // Before the resolver it subscribes to, so the last edges of a shutdown are
  // not published onto a bus nobody is left to read.
  viewingTopic.dispose();
  viewing.dispose();
  // The layout write is debounced (a drag would otherwise write per mousemove),
  // so the pending one has to be forced out here or the last change made before
  // quitting is the one that never lands.
  layout.flush();
  layout.dispose();
  bridge.dispose();
  host.dispose();
  store.close();
});
