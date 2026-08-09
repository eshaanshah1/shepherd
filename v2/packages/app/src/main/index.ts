import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { color } from '@shepherd/design-tokens';
import {
  appName,
  resolveAppPaths,
  runExec,
  runGit,
  shellDefaults,
  systemHome,
} from '@shepherd/platform-darwin';
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
import { worktreeHookManifest } from '@shepherd/ext-worktree-hook/manifest';
import {
  KERNEL,
  createLogger,
  extensionId,
  rootId,
  systemClock,
  type Permission,
  type RootID,
} from '@shepherd/sdk';
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
import { SessionBridge, type SessionHostLike } from './session-bridge.ts';
import { registerViewCommands } from './view-commands.ts';
import { createRemoteService, PAIRED_DEVICE_PERMISSIONS } from './remote-service.ts';
import { registerRemoteCommands } from './remote-commands.ts';
import { resolveTransport, type Identity, type RemoteAPI } from '@shepherd/remote';
import { SessionClient } from './session-client.ts';
import { daemonConnector } from './daemon-launcher.ts';
import { registerSessionIpc } from './ipc.ts';
import { registerWindowIpc } from './window-ipc.ts';
import { registerLayoutIpc } from './layout-ipc.ts';
import { installMenu } from './menu.ts';
import {
  LOCAL_DEVICE_ID,
  LOCAL_DEVICE_PERMISSIONS,
  resolveHome,
  resolveSupport,
  resolveTransportName,
  TRANSPORT_FLAG,
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
import { registerCaptureCommand } from './capture-command.ts';
import { registerReloadCommand } from './reload-command.ts';

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

/**
 * Sessions live in `shepherdd`, not here (R1, ADR 0036).
 *
 * `SessionClient` satisfies `SessionHostLike`, so `SessionBridge`, the layout's
 * `SessionSink`, the renderer and every smoke are untouched by the move. What
 * changed is which process owns the ptys — and therefore whether quitting this
 * one ends them.
 *
 * `SHEPHERD_SESSION_DAEMON=0` keeps the in-process host, and that is a CONTROL
 * rather than a convenience: a smoke that fails under the daemon and passes
 * in-process has localized the fault to the transport in one run. The
 * alternative is bisecting a behaviour change against a process boundary.
 */
const USE_DAEMON = process.env['SHEPHERD_SESSION_DAEMON'] !== '0';


/** Assigned in `whenReady`; disposed with the app. */
let remote: (RemoteAPI & { dispose(): void }) | undefined;

/**
 * Where the sockets live. Overridable per run — see `SUPPORT_FLAG`; a throwaway
 * userData directory does not isolate a socket derived from `$HOME`.
 *
 * Declared HERE, above the host, because the daemon's socket is one of them. It
 * was not, for one commit: the daemon bound `~/.shepherd/v2/session.sock`
 * directly, so every smoke — and `pnpm dev` — would have driven the ptys of the
 * daily app, which is the exact class of bug this flag exists to prevent.
 */
const support = resolveSupport(process.argv, resolveAppPaths(IS_DEV).support);

/**
 * The store paired devices live in — beside the sockets rather than under
 * userData, because the DAEMON opens the same file and has no userData of its
 * own. One persistence mechanism, two processes (ADR 0021).
 */
const remoteStore = new SqliteStore({ location: `${support}/remote.db`, logger });

/**
 * The daemon's entry: the bundle that `build-daemon.mjs` puts beside this file.
 *
 * Relative to `import.meta.url` — i.e. to `out/main/index.js` — and NOT to
 * `app.getAppPath()`, which returns `out/` rather than the package root and so
 * pointed at two paths that never existed. It failed silently, because a
 * detached child with `stdio: 'ignore'` has nowhere to report a
 * MODULE_NOT_FOUND; the app could only say "the daemon did not come up".
 * `SHEPHERD_DAEMON_STDIO=inherit` is what made it visible.
 *
 * The daemon is a BUNDLE and not the TypeScript source, because it is launched
 * as `electron --as-node` and Node's type stripping refuses files under
 * `node_modules` — which is how every workspace package resolves.
 */
function daemonEntry(): string {
  const bundled = fileURLToPath(new URL('../daemon/main.js', import.meta.url));
  if (!existsSync(bundled)) {
    // Named rather than left to fail as a spawn that goes nowhere: the fix is
    // running the build, and nothing else in the message would say so.
    logger.child('session').error(
      `no daemon bundle at ${bundled} — run \`pnpm --filter @shepherd/app build\``,
    );
  }
  return bundled;
}

const host: SessionHostLike = USE_DAEMON
  ? new SessionClient({
      connect: daemonConnector({
        socketPath: `${support}/session.sock`,
        support,
        entry: daemonEntry(),
        log: logger.child('session'),
      }),
      log: logger.child('session'),
    })
  : new SessionHost({
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
    // The local CLI, plus every device a human APPROVED at this Mac.
    //
    // Derived from the paired list per invocation, exactly as `agents` is
    // derived from the pty host's inventory, and for the same stated reason:
    // there is no second registry to keep in step and no revoke path to forget
    // — revoking removes the record and the grant goes with it.
    //
    // Nothing populated this for one run, and a phone that had just paired
    // successfully was told `device:… is unknown (not registered as a live
    // principal)`. That is the agent-principals defect of M3 repeating for a new
    // caller kind: adding a `Caller` variant is not the same as making one work.
    devices: new Map<string, readonly Permission[]>([
      [LOCAL_DEVICE_ID, LOCAL_DEVICE_PERMISSIONS],
      ...(remote?.devices() ?? []).map(
        (device) => [device.id, PAIRED_DEVICE_PERMISSIONS] as const,
      ),
    ]),
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
  sessions: {
    kill: (id) => void host.kill(id),
    // R1 (ADR 0036): a restored pane's persisted `sessionId` is a claim, and
    // the daemon's inventory is what settles it. `has` reads the mirror
    // `SessionClient.start()` filled from the daemon's own `list`.
    isLive: (id) => host.has(id),
  },
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
  // Resolved at the platform boundary, where `node:os` is allowed, and handed
  // down: an extension cannot compute it and some of what it has to cooperate
  // with lives at a fixed path under `~`. Overridable per run (`HOME_FLAG`)
  // because an extension WRITES there — a smoke must not seed trust records
  // into the developer's own Claude Code config.
  homeDir: resolveHome(process.argv, systemHome()),
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
  /**
   * Remote FIRST, and the order is load-bearing.
   *
   * `serve` mints this Mac's TLS identity, and the daemon serves the data path
   * with the SAME certificate — a device pins one cert and presents one secret,
   * so two would mean the phone refusing the terminal it was just told to open.
   * The daemon cannot mint (it has no `openssl` grant, deliberately), so it must
   * find the identity already there.
   *
   * It did not, for one run: the daemon is spawned by the first session call,
   * which used to happen before this, so it started, found no identity and
   * served no data path — and the phone could list tasks and then open a
   * terminal that never painted. Nothing failed; the feature was simply absent.
   */
  if (SMOKE === undefined) {
    remote = createRemoteService({
      support,
      registry,
      // In `support`, not userData: the DAEMON opens this same file, and it has
      // no userData. One store, two processes (ADR 0021).
      devices: remoteStore.namespace('devices'),
      log: logger.child('session'),
    });
    registerRemoteCommands({ remote, registry, log: logger.child('session') });
    /**
     * Whichever transport was asked for, resolved by name.
     *
     * Every transport is the same server with the same pairing and the same
     * TLS — all that differs is which interface gets bound, which is the whole
     * reason `Endpoint` is an interface. v1 had no such seam, so its LAN
     * listener had to terminate TLS itself and bridge the raw fd into a server
     * hard-wired to the tailnet, through a `socketpair`.
     *
     * An unknown name refuses rather than falling back: serving a different way
     * than asked means believing you are reachable when you are not.
     */
    const transportName = resolveTransportName(process.argv);
    const transport = resolveTransport(transportName);
    if (!transport.ok) {
      logger.child('session').error(transport.error);
    } else {
      await remote.serve((identity: Identity, port?: number) =>
        transport.value({ identity, ...(port === undefined ? {} : { port }) }),
      );
    }
  }

  /**
   * Reach the daemon and adopt what it is already running — before any window
   * opens, because that is when the layout restores and asks `isLive` whether
   * each persisted binding still means something (ADR 0036).
   *
   * Awaited rather than fired-and-forgotten: a restore that raced this would see
   * an empty inventory, drop every binding, and create a second pty for every
   * pane while the daemon's originals kept running — the exact orphaning the
   * persisted binding exists to prevent. Failing to reach the daemon is reported
   * and the app continues; every pane then simply creates, which is the pre-R1
   * behaviour and a much better outcome than refusing to start.
   */
  if (host instanceof SessionClient) {
    const adopted = await host.start();
    if (!adopted.ok) {
      logger.child('session').error(`starting without the daemon's inventory: ${adopted.error}`);
    }
  }

  registerSessionIpc(bridge, { defaults: shellDefaults() });
  registerWindowIpc();

  const layoutIpc = registerLayoutIpc({
    store: layout,
    registry,
    active: HOME_ROOT,
    // Presence follows the active root, wired here rather than at each switch
    // site so no future caller can move the window without moving the predicate.
    //
    // Deliberately NOT announced on the bus. The switch is already published to
    // the renderer as part of the layout snapshot, which is what draws the
    // stage — so the sidebar highlights from that same value (`TreeItem.root`)
    // rather than from an extension mirroring a second copy of it. A bus event
    // is for something an extension must ACT on, which is why `rootClosed` is
    // one (a task archives itself) and this is not (it is a projection).
    onActiveChanged: () => syncPresence(),
  });
  publishLayout = layoutIpc.publish;
  activeRoot = layoutIpc.getActive;

  registerAttentionCommands({ store: attention, registry });

  /**
   * Contributed views, in the one verb table (§4.3).
   *
   * The renderer already reaches them over IPC; this is what lets the CLI, MCP
   * and a paired DEVICE reach the same rows without a second implementation
   * each — which is the thing v1 got wrong three times over.
   */
  registerViewCommands({ views, registry });

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
    // What running out of panes MEANS, decided in exactly one place. Core does
    // not know what a window is; it knows that a root has run out of panes.
    onLastPaneClosed: (root) => {
      /**
       * **The home root's last pane leaves an EMPTY WINDOW, and does not quit.**
       *
       * It used to call `win.close()`, and with `window-all-closed` that is an
       * app which vanishes when you tidy up — you close your last pane and the
       * thing you were working in is gone. The empty state is a real destination
       * now: it says the app is running, that nothing is in flight, and ⌘T is
       * right there. v1 closed the window because it had no empty state to fall
       * back to, and v1 itself ended up here — a workspace may hold zero tabs
       * and `WorkspaceEmptyView` is what it draws.
       *
       * There is nothing to do: `store.close` has already emptied the root and
       * announced it, so the projection the page receives carries `tree: null`
       * and the stage draws `EmptyState`. Quitting is ⌘Q or the window's own
       * close button, both untouched — this removes a fall-through rather than
       * adding a guard against closing.
       *
       * Any OTHER root is a pane group the window merely shows — a task's, say —
       * so running it out of panes means that group is finished with, not that
       * the app is. Switching away FIRST, because a window drawing a root that
       * has just been removed draws nothing at all.
       */
      if (root === HOME_ROOT) {
        logger.info('layout', 'the home root is empty; the window stays open on the empty state');
        return;
      }
      layoutIpc.setActive(HOME_ROOT);
      const removed = layout.removeRoot(root);
      if (!removed.ok) logger.warn('layout', `could not remove ${root}: ${removed.error}`);

      /**
       * And SAY so, because an extension that owns the root needs to know.
       *
       * `tasks` archives a task when you close the last of its panes, and it
       * used to infer that from `session.exit` — count the task's own recorded
       * panes down to zero. That inference is wrong across a relaunch: pane ids
       * are regenerated when a layout is restored, so the record names panes
       * that no longer exist, the count never reaches zero, and closing the last
       * pane archives nothing. (The delete path had already learned this and
       * says so in its own comment; the close path did not carry it over.)
       *
       * The layout is the only thing that knows a root ran out of panes, and it
       * knows it whoever opened them and however many times the app restarted.
       * So it is the layout that announces it, and the extension reacts.
       */
      bus.emit('layout.rootClosed', { root }, KERNEL);
    },
  });

  /**
   * The app photographing itself, beside the other kernel verbs and before the
   * sockets open — so a CLI client cannot arrive ahead of the command it wants.
   *
   * The window is resolved INSIDE the closure, not captured: there is no window
   * yet at this point (it is created after the ingress starts), and on macOS the
   * app outlives its last window and can be handed a new one by `activate`. A
   * captured reference would photograph a destroyed window forever.
   */
  registerCaptureCommand({
    registry,
    clock: systemClock,
    supportDir: support,
    capture: async () => {
      const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (target === undefined) return null;
      const image = await target.webContents.capturePage();
      const size = image.getSize();
      return { png: image.toPNG(), width: size.width, height: size.height };
    },
  });

  /**
   * New UI without killing anybody's agents — see `reload-command.ts` for why
   * this works at all (the `SessionHost` above outlives every window, on
   * purpose). Resolved late for the same reason `capture` is: there is no
   * window yet, and macOS can hand the app a new one.
   */
  registerReloadCommand({
    registry,
    reload: () => {
      const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (target === undefined) return false;
      target.webContents.reload();
      return true;
    },
  });

  // Extensions, after the command table exists and before the sockets open — so
  // a CLI client cannot arrive before `diagnostics.ping` is registered, and so a
  // built-in's own `commands.register` cannot race the kernel's.
  extensionHost.registerCommands();
  for (const manifest of [
    diagnosticsManifest,
    agentsCoreManifest,
    claudeCodeManifest,
    tasksManifest,
    // After `tasks`: it declares that dependency, and the point it registers
    // into has to exist before it activates.
    worktreeHookManifest,
  ]) {
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
  for (const manifest of [
    diagnosticsManifest,
    agentsCoreManifest,
    claudeCodeManifest,
    tasksManifest,
    // After `tasks`: it declares that dependency, and the point it registers
    // into has to exist before it activates.
    worktreeHookManifest,
  ]) {
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
  /*
   * The home root opens **EMPTY** on a first run.
   *
   * `{ empty: true }` applies to the MINT only — a restore brings back whatever
   * the user left, panes and all — so this is the state of a profile that has
   * never been used, and of one whose last pane was closed. Minting a shell
   * there is what made the app's empty state unreachable: "you have no tasks"
   * was drawn as a live terminal, sitting in whatever directory happened to be
   * current, which after deleting the last task is one that has just been
   * removed from disk. The unit of work here is a task; a shell nobody asked for
   * is not a reasonable thing to open in its place.
   */
  layout.open(HOME_ROOT, undefined, { empty: true });
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
