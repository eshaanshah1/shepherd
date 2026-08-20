import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { color } from '@shepherd/design-tokens';
import {
  appName,
  installShellEnvironment,
  resolveAppPaths,
  runExec,
  runGit,
  shellDefaults,
  systemHome,
  systemHostName,
  systemUserName,
} from '@shepherd/platform-darwin';
import {
  CommandRegistry,
  EventBus,
  ExtensionRegistry,
  PermissionStore,
  SessionHost,
  SecretsRegistry,
  SettingsRegistry,
  SqliteStore,
  registerSessionCommands,
} from '@shepherd/core';
import { LayoutStore, registerLayoutCommands } from '@shepherd/core/layout';
import { AttentionStore, ViewingResolver, registerAttentionCommands } from '@shepherd/core';
import { diagnosticsManifest } from '@shepherd/ext-diagnostics/manifest';
import { scratchManifest } from '@shepherd/ext-scratch/manifest';
import { agentsCoreManifest } from '@shepherd/ext-agents-core/manifest';
import { claudeCodeManifest } from '@shepherd/ext-claude-code/manifest';
import { tasksManifest } from '@shepherd/ext-tasks/manifest';
import { worktreeHookManifest } from '@shepherd/ext-worktree-hook/manifest';
import { githubManifest } from '@shepherd/ext-github/manifest';
import { transcriptsManifest } from '@shepherd/ext-transcripts/manifest';
import {
  CORE_NAMESPACE,
  KERNEL,
  createLogger,
  extensionId,
  paneId,
  rootId,
  sessionId,
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
import { remoteViews } from './remote-views.ts';
import { memberOf, qualify } from '../shared/index.ts';
import { resolveTransport, type Identity, type RemoteAPI } from '@shepherd/remote';
import { SessionClient } from './session-client.ts';
import { SessionRouter } from './session-router.ts';
import { createRemotePresenter } from './remote-present.ts';
import { daemonConnector } from './daemon-launcher.ts';
import { registerSessionIpc } from './ipc.ts';
import { registerWindowIpc } from './window-ipc.ts';
import { registerLayoutIpc } from './layout-ipc.ts';
import { rootClosedFallout } from './root-closed.ts';
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
import { hookRelay } from './hook-relay.ts';
import { EMIT, INVOKE } from '../shared/index.ts';
import { agentPrincipals } from './agent-principals.ts';
import { ViewRegistry } from './view-registry.ts';
import { createSystemAlerts } from './system-alerts.ts';
import { clearAgentState } from './agent-relay.ts';
import { correlationEnv } from './correlation-env.ts';
import { publishViewingEdges } from './viewing-topic.ts';
import { publishSessionBound } from './session-bound.ts';
import { registerCaptureCommand } from './capture-command.ts';
import { registerReloadCommand } from './reload-command.ts';
import { registerSettingsCommands } from './settings-commands.ts';
import { registerSecretsCommands } from './secrets-commands.ts';
import { keychainCipher } from './safe-storage.ts';
import { GENERAL_PAGE } from './settings-general.ts';
import { registerSettingsIpc } from './settings-ipc.ts';
import { registerSettingsVisibility } from './settings-visibility.ts';
import { presenceFor } from './presence-input.ts';

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

const local: SessionHostLike = USE_DAEMON
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
      hostname: systemHostName(),
      onError: (error, context) =>
        process.stderr.write(`[shepherd] session ${context}: ${String(error)}\n`),
    });

/**
 * Sessions from anywhere in the net, behind ONE `SessionHostLike`.
 *
 * A qualified id (`mac-b∷01H…`) is another member's session and an unqualified
 * one is this Mac's, which is the bookkeeping `remote-views.ts` already does for
 * view types. Everything downstream — `SessionBridge`, the IPC layer, the
 * renderer, the smokes — keeps seeing one API and one opaque id, so watching
 * another Mac's terminal is a transport change rather than a second terminal
 * implementation. See `session-router.ts`, and in particular why a `kill` of a
 * remote session is a detach.
 *
 * `connect` reaches for `remote` lazily on purpose: the net is only up in
 * `whenReady`, and a member is only dialled when somebody actually opens one of
 * its rows.
 */
const sessions = new SessionRouter({
  local,
  connect: async (memberId) => {
    if (remote === undefined) throw new Error('remote is not running');
    return await remote.sessionSocket(memberId);
  },
  log: logger.child('session'),
});

/** The same object, seen as what everything downstream is written against. */
const host: SessionHostLike = sessions;

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

/**
 * Settings — the registry, with the app's own page contributed into it FIRST, so
 * `shepherd.theme` exists before any window or extension reads one.
 *
 * The kernel contributes through the same call an extension does, deliberately:
 * see `settings-general.ts`.
 */
const settings = new SettingsRegistry({ store, logger });
settings.contribute(CORE_NAMESPACE, [GENERAL_PAGE]);

/**
 * Secrets — declarations from every installed manifest, values encrypted by the
 * OS keychain.
 *
 * Built here beside settings and for the same reason: it must answer with
 * nothing activated. A user opening the Secrets screen is deciding whether to
 * hand a credential over, and activating every installed extension in order to
 * ask what they want would be the interruption the whole model avoids.
 */
const secrets = new SecretsRegistry({
  store,
  cipher: keychainCipher(),
  onError: (message) => logger.warn('extension', message),
});

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
    // Derived from the net's roster per invocation, exactly as `agents` is
    // derived from the pty host's inventory, and for the same stated reason:
    // there is no second registry to keep in step and no revoke path to forget
    // — a revoked member is tombstoned and the grant goes with it.
    //
    // Nothing populated this for one run, and a phone that had just paired
    // successfully was told `device:… is unknown (not registered as a live
    // principal)`. That is the agent-principals defect of M3 repeating for a new
    // caller kind: adding a `Caller` variant is not the same as making one work.
    devices: new Map<string, readonly Permission[]>([
      [LOCAL_DEVICE_ID, LOCAL_DEVICE_PERMISSIONS],
      ...(remote?.members() ?? []).map(
        (member) => [member.memberId, PAIRED_DEVICE_PERMISSIONS] as const,
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
 * Agent hooks from the daemon, onto this bus.
 *
 * The daemon serves `hooks.sock` now, because it is the process that outlives the
 * app: an agent keeps firing hooks into a pty the daemon owns while the app is
 * being replaced, and `report.sh` finds no socket and exits 0 by design. What used
 * to be lost is journalled there and replayed here, so a turn that ended during a
 * restart is FOLDED rather than guessed at.
 *
 * The attribution is re-applied here rather than trusted from the payload — the
 * ingress already knows who posted, and a payload naming its own session is v1's
 * `tab_id` lie. It is exactly what this app's own `EventsIngress` did when it held
 * the socket, which is what makes the fallback below equivalent rather than
 * merely similar.
 *
 * **Registered at this level, before `local.start()`, and that is load-bearing.**
 * The daemon flushes its journal INSIDE the handshake — snapshot, register and
 * replay are one step, the rule `PtyFanout` states — so a listener attached after
 * `start()` would miss precisely the events this whole path exists to deliver.
 */
const hooks = hookRelay((envelope) => {
  bus.emit(
    envelope.topic,
    envelope.payload,
    { kind: 'agent', sessionId: sessionId(envelope.sessionId) },
    envelope.seq,
  );
});
if (local instanceof SessionClient) local.onHooked((envelope) => hooks.receive(envelope));

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
    /**
     * R1 (ADR 0036): a restored pane's persisted `sessionId` is a claim, and the
     * daemon's inventory is what settles it. `has` reads the mirror
     * `SessionClient.start()` filled from the daemon's own `list`.
     *
     * **A member's session is adopted optimistically, because nothing here can
     * settle it.** The authority is another machine: this runs while the layout
     * is being restored, before anything has been dialled, and asking would mean
     * a synchronous answer to a question that needs a TLS handshake and a
     * possibly-sleeping Mac. Answering `false` would drop the binding and the
     * pane would create a LOCAL shell where B's terminal used to be — a silent
     * substitution, which is worse than a pane that says it cannot reach B yet.
     * `SessionRouter.attach` is where the claim is finally tested, and an
     * unreachable member becomes an announced exit rather than a black pane.
     */
    isLive: (id) => memberOf(id) !== undefined || host.has(id),
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

/**
 * Whether the settings screen covers the grid.
 *
 * One writer: the `window.settings` command. It is read by `syncPresence` below,
 * which is what makes ADR 0020's predicate account for a takeover — and it is the
 * clause `api-layout.ts` has promised since M1 ("not covered by a full-takeover
 * overlay") with nothing implementing it.
 */
let settingsOpen = false;

function syncPresence(): void {
  // The composition is `presenceFor`'s, so it is assertable without Electron —
  // ADR 0020 allows one writer of "is the user looking at this", and the cost of
  // that rule is that the one writer has to be provably right.
  viewing.setPresence(presenceFor({ appActive, activeRoot: activeRoot(), settingsOpen }));
}

/**
 * The same predicate, on the bus as `session.viewing`, for the agent extension a
 * process away — a cache of the one answer, never a second check.
 */
const viewingTopic = publishViewingEdges({ viewing, layout, bus, logger });

/**
 * `session.bound` — the pane a session landed in. See the module for why the
 * reconciliation sweep cannot infer this one.
 */
const boundTopic = publishSessionBound({ bus, by: KERNEL });

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
  // Where a manifest's `contributes.settings` lands, and where each extension's
  // seed is read from.
  settings,
  support,
  // Resolved at the platform boundary, where `node:os` is allowed, and handed
  // down: an extension cannot compute it and some of what it has to cooperate
  // with lives at a fixed path under `~`. Overridable per run (`HOME_FLAG`)
  // because an extension WRITES there — a smoke must not seed trust records
  // into the developer's own Claude Code config.
  homeDir: resolveHome(process.argv, systemHome()),
  userName: systemUserName(),
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

/**
 * Stops the `layout.rootsChanged` announcer at quit. Module scope for the same
 * reason `publishLayout` is: it is created during bootstrap and torn down by the
 * `will-quit` handler, which lives out here.
 */
let stopRootsAnnouncer: () => void = () => undefined;

const bridge = new SessionBridge(host, {
  clock: systemClock,
  // A pane's session is bound where it is created (see `LayoutBinding`), so
  // `layout.close` — from ⌘W, from the CLI, from an extension — is what ends it.
  layout: {
    bind: (pane, session) => {
      layout.bindSession(pane, session);
      publishLayout();
      // The pane a session lives in, announced once, at the moment it is true.
      boundTopic.announce(pane, session);
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

/**
 * A program's own name for its pane, and the directory it is sitting in.
 *
 * Read from the mirror rather than from a terminal, and that is the whole
 * reason this is in main: a suspended pane has no terminal at all, so a
 * renderer-side listener would freeze the label of every tab you are not
 * looking at. `observe` ignores a patch that changes nothing, and `layout-ipc`
 * republishes on `onDidChange` — so the renderer follows with no push from here.
 */
const observed = host.onObserved((patch) => {
  const pane = layout.paneForSession(patch.sessionId);
  if (pane === undefined) return;
  const written = layout.observe(pane, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
  });
  if (!written.ok) logger.warn('layout', `pane ${pane} kept its name: ${written.error}`);
});

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow(
    windowOptions({
      // `.cjs`, because a sandboxed renderer's preload is not an ES module.
      preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
      backgroundColor: color('canvas', 'dark'),
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
   * The user's real `PATH`, before anything in this process spawns a program.
   *
   * A Finder-launched `.app` is a child of launchd and inherits its `PATH`, which
   * is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — not the one the user
   * configured. `exec.ts`'s `STANDARD_BIN_DIRS` covers `git` and `gh` and stops
   * there; a version manager's shims exist only because a shell profile said so.
   * So this asks the login shell once and merges what it says into `process.env`,
   * which is what every consumer downstream already reads.
   *
   * **First, and awaited**, for three reasons that are each a real ordering bug:
   * `remote.serve` below shells out to `openssl`; the daemon is spawned lazily and
   * inherits `process.env` at that moment; and `exec.ts` caches a program's
   * resolved path on first use, so anything resolved under launchd's `PATH` would
   * outlive the reason it was wrong (`installShellEnvironment` drops that cache
   * for the same reason, but it cannot undo a spawn that already happened).
   *
   * The cost is real and is the whole trade: a slow profile delays the window by
   * up to `LOGIN_SHELL_TIMEOUT_MS`. Every failure — no shell, a wedged profile, a
   * timeout — lands on the environment being left exactly as it was, so the worst
   * case is the behaviour that shipped before this existed. `ms` is logged so
   * "launch got slower" is answerable rather than guessed at.
   */
  const shellEnv = await installShellEnvironment();
  logger.info(
    'app',
    `PATH from ${shellEnv.origin}${shellEnv.shell === null ? '' : ` (${shellEnv.shell})`} — ` +
      `${shellEnv.added} dir(s) added in ${shellEnv.ms}ms`,
  );

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
      /**
       * A member's view changed, so this window re-reads it — the same nudge a
       * local extension sends, through the same channel. The page never learns
       * that the change came from another machine; it learns that a list it is
       * drawing is stale, which is all it has ever been told.
       */
      onMemberViewChanged: (memberId, type) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.isDestroyed()) contents.send(EMIT.viewsChanged, qualify(memberId, type));
        }
      },
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
  if (local instanceof SessionClient) {
    const adopted = await local.start();
    if (!adopted.ok) {
      logger.child('session').error(`starting without the daemon's inventory: ${adopted.error}`);
    }
  }

  registerSessionIpc(bridge, {
    defaults: shellDefaults(),
    // The layout holds a restored pane's screen until its session exists. This
    // is the moment it does.
    takeSeed: (id) => layout.takeInitialSeed(paneId(id)),
  });
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

  /**
   * The layout changed — said on the bus, for extensions.
   *
   * The note above explains why the active-root SWITCH is not announced: it is a
   * projection, and the sidebar reads it from the snapshot it already draws the
   * stage from. This is the other kind. `tasks` contributes a row per tab,
   * labelled by that tab's focused pane, and an extension cannot read the layout
   * synchronously (`LayoutAPI`'s getters throw `ACROSS_A_PORT`) — so without an
   * announcement it would draw the label a pane had when it was spawned and keep
   * it forever, and a tab opened from the CLI would never appear at all.
   *
   * **Payload-free on purpose.** The consumer re-reads through
   * `layout.listRoots`, which is one authority; a payload here would be a
   * second, arriving by a route that can drop.
   *
   * **Debounced**, because `onDidChange` fires per structural change and an OSC
   * title landing during a build is a burst of them. The trailing edge is the
   * one that matters: what a consumer wants is "go and look again", and looking
   * once after the burst is the same answer as looking forty times during it.
   */
  let announceRoots: ReturnType<typeof setTimeout> | undefined;
  const rootsChanged = layout.onDidChange(() => {
    if (announceRoots !== undefined) return;
    announceRoots = setTimeout(() => {
      announceRoots = undefined;
      bus.emit('layout.rootsChanged', {}, KERNEL);
    }, 100);
  });
  stopRootsAnnouncer = () => {
    // The pending timer too: a timer that outlives the bus emits onto one
    // nobody is left to read, which is the shape the viewing topic's own
    // teardown comment warns about two lines down.
    if (announceRoots !== undefined) clearTimeout(announceRoots);
    announceRoots = undefined;
    rootsChanged.dispose();
  };

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
  /**
   * Views from every member of the net, drawn together.
   *
   * A remote view arrives through the SAME three calls as a local one, because
   * it is the same conversation held with a different machine — see
   * `remote-views.ts`. Which member owns a view rides in its type, so every
   * handler below routes on that one fact and nothing else in the shell has to
   * learn that other Macs exist.
   */
  const fromMembers = remoteViews({
    members: () => remote?.members() ?? [],
    invokeAt: async (memberId, command, args) => {
      if (remote === undefined) throw new Error('remote is not running');
      return remote.invokeAt(memberId, command, args);
    },
    /**
     * The members answered, late — which is the only way they can answer, since
     * the list they answer is drawn without waiting for them. The page is told
     * the way it is always told: a nudge, and it re-reads. No one view type
     * changed here, the SET did, so there is no type to name.
     */
    changed: () => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send(EMIT.viewsChanged, '');
      }
    },
    log: logger.child('session'),
  });

  /**
   * A member's row, shown HERE — the gesture this milestone exists for.
   *
   * `activate` on a remote row used to run that row's own verb over there, which
   * for a task opens a pane and switches the window on the OTHER Mac while
   * leaving this one showing nothing. A row's `presents` verb answers what it
   * stands for and performs nothing, so this Mac becomes a second viewer of the
   * same pty and nobody else's window moves.
   */
  const presenter = createRemotePresenter({
    reach: (memberId) => sessions.reach(memberId),
    invoke: (command, args) => registry.invoke(command, args, KERNEL),
    log: logger.child('session'),
  });

  ipcMain.handle(
    INVOKE.viewsPresent,
    async (_event, type: string, presents: { id: string; args?: unknown }) => {
      const memberId = memberOf(type);
      if (memberId === undefined || !fromMembers.owns(type)) {
        // Only a member's row goes through here. One of this Mac's own rows is
        // activated, which already does the right thing on the machine it is on.
        return { ok: true, value: { shown: false, reason: 'that view is local' } };
      }
      const effect = await fromMembers.present(type, presents);
      if (effect === undefined) {
        // The honest answer, and the one the row's own verb decided: a task with
        // nothing running has no terminal to show, and an empty pane pretending
        // otherwise is what `tasks.presentation` refuses to hand back.
        return { ok: true, value: { shown: false, reason: 'nothing running to show' } };
      }
      if (effect.kind === 'view') {
        // The sidebar already draws every member's views; a `view` effect is
        // something the page focuses, not something main opens.
        return { ok: true, value: { shown: false, reason: 'that row asked for a view' } };
      }
      const name = remote?.members().find((m) => m.memberId === memberId)?.name ?? memberId;
      const shown = await presenter.present(memberId, name, effect);
      return shown.ok
        ? { ok: true, value: { shown: true } }
        : { ok: true, value: { shown: false, reason: shown.error } };
    },
  );

  ipcMain.handle(INVOKE.viewsList, async () => ({
    ok: true,
    // This Mac's own first: they are the ones that always answer, and a sidebar
    // whose order depends on which machine replied fastest is a sidebar that
    // moves under the cursor.
    //
    // **Neither half is awaited over a wire.** This used to await
    // `fromMembers.list()`, which asks every member — so a profile with two
    // paired Macs that were switched off (packets dropped, not refused) never
    // answered this call at all, and the renderer's sidebar stayed empty for the
    // life of the process while the control socket, which asks nobody, answered
    // in milliseconds. A member's views arrive on the nudge below instead.
    value: [...views.list(), ...fromMembers.list()],
  }));
  ipcMain.handle(INVOKE.viewsChildren, async (_event, type: string, parent?: string) => ({
    ok: true,
    value: fromMembers.owns(type)
      ? await fromMembers.children(type, parent)
      : await views.children(type, parent),
  }));
  ipcMain.handle(INVOKE.viewsActivate, async (_event, type: string, command: { id: string; args?: unknown }) => {
    if (fromMembers.owns(type)) await fromMembers.activate(type, command);
    else await views.activate(type, command);
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
      /*
       * Read BEFORE the root is removed — afterwards `groupOf` answers undefined
       * and there is nothing left to ask. The decision itself is a pure function
       * next door, because it is the one piece of this callback that can be
       * wrong in a way you only discover by losing work.
       */
      const group = layout.groupOf(root) ?? root;
      const { nextRoot, announcement } = rootClosedFallout({
        root,
        group,
        groupRoots: layout.rootsInGroup(group),
        homeRoot: HOME_ROOT,
      });

      layoutIpc.setActive(nextRoot);
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
       *
       * **With the GROUP, and whether it is now empty.** Once a task owns several
       * roots, the bare root id cannot answer the question the consumer is
       * asking: closing the first tab of a task would archive it while another
       * tab sat there with a live agent in it. A task is finished with when ALL
       * of its tabs are, which is also the only reading a user would give the
       * gesture.
       */
      bus.emit('layout.rootClosed', announcement, KERNEL);
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

  /**
   * The settings verbs, BEFORE the extensions below: a built-in's `activate` may
   * write a setting (the quick-tier migration does), and a write into a verb
   * table that has not been filled in yet is a refusal nobody asked for.
   */
  registerSettingsCommands({ registry, settings, bus });
  registerSecretsCommands({ registry, secrets });

  /**
   * The screen's own two halves: the channels the page reads it through, and the
   * one command that moves it.
   *
   * Both effects of that command happen here, in one place — the page is told, and
   * presence is recomputed — because a takeover the predicate did not hear about
   * is a pane reported as seen while a settings screen covers it.
   */
  const settingsIpc = registerSettingsIpc({ registry, bus, settings });
  registerSettingsVisibility({
    registry,
    onChange: (open) => {
      settingsOpen = open;
      settingsIpc.pushVisibility(open);
      syncPresence();
    },
  });

  // Extensions, after the command table exists and before the sockets open — so
  // a CLI client cannot arrive before `diagnostics.ping` is registered, and so a
  // built-in's own `commands.register` cannot race the kernel's.
  extensionHost.registerCommands();
  for (const manifest of [
    diagnosticsManifest,
    scratchManifest,
    agentsCoreManifest,
    claudeCodeManifest,
    tasksManifest,
    // After `tasks`: both declare that dependency, and the points they register
    // into have to exist before they activate.
    worktreeHookManifest,
    githubManifest,
    transcriptsManifest,
  ]) {
    const added = extensions.add(manifest, 'builtin');
    if (added.ok) {
      /*
       * Declared at REGISTRATION, not at activation — one step earlier than
       * settings pages, and deliberately.
       *
       * A secret is a thing the user is asked for before anything runs, so the
       * screen listing it must not depend on the asker being up. A malformed
       * declaration is reported and its siblings are kept: an extension whose
       * second secret has a typo should still be able to hold its first.
       */
      for (const problem of secrets.declare(manifest.id, manifest.contributes?.secrets ?? [])) {
        logger.warn('extension', problem);
      }
      continue;
    }
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
    scratchManifest,
    agentsCoreManifest,
    claudeCodeManifest,
    tasksManifest,
    // After `tasks`: both declare that dependency, and the points they register
    // into have to exist before they activate.
    worktreeHookManifest,
    githubManifest,
    transcriptsManifest,
  ]) {
    if (extensions.state(extensionId(manifest.id)) === undefined) continue;
    await extensions.activate(extensionId(manifest.id));
  }

  /*
   * Now, and not before: the journal the daemon replayed at handshake time has
   * been held in `hooks` since `whenReady` started, because the bus had no
   * subscriber yet and an emit with no subscriber is gone.
   *
   * This line is the app's half of "snapshot, register and replay are one step".
   * It sits after the activation loop because that is the moment main can honestly
   * claim a consumer exists — `agents-core` declares `onStartup` for exactly this
   * — and nothing in main can know when a child subscribed to a topic.
   */
  if (hooks.buffered > 0) {
    logger.info('ingress', `replaying ${hooks.buffered} agent hook(s) the daemon held while the app was down`);
  }
  hooks.goLive();

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
    /*
     * Only when the daemon is NOT serving them. It advertises the capability in
     * the handshake, which `local.start()` above has already completed — so this
     * reads a fact rather than racing for the socket, and an old daemon (every
     * `pnpm ship` leaves one running, holding your agents' ptys) falls back to the
     * app serving hooks itself.
     */
    ...(local instanceof SessionClient && local.daemonServesHooks
      ? {}
      : { hookSocket: HOOK_SOCKET }),
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
  stopRootsAnnouncer();
  observed.dispose();
  layout.dispose();
  bridge.dispose();
  host.dispose();
  store.close();
});
