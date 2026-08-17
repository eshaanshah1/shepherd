import { createServer, type Socket } from 'node:net';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventsIngress, SessionHost, SessionServer, SqliteStore, reclaimSocketPath } from '@shepherd/core';
import {
  RemoteServer,
  kvNetStore,
  loadOrMintIdentity,
  resolveTransport,
  type EndpointFactory,
} from '@shepherd/remote';
import { createLogger, systemClock, type LogLevel } from '@shepherd/sdk';
import { socketVerdict, verdictReason, type SocketIdentity } from './socket-watch.ts';

/**
 * `shepherdd` — the process that owns the ptys.
 *
 * Run as the **Electron binary with `ELECTRON_RUN_AS_NODE=1`**, not a separate
 * node. Measured before this was planned: node-pty loads there against the same
 * ABI it is already built for, so ADR 0021's "no native rebuild per Electron
 * bump" survives. A plain-node daemon would need a second node-pty build and a
 * node on PATH that matches the engine range.
 *
 * It is spawned **detached** by whoever needs it first, and it deliberately
 * outlives them: a detached child reparents to init and keeps its ptys running
 * when Electron exits, which is the entire point of the milestone.
 *
 * Two exit rules, and the asymmetry is the design:
 *
 *   - **No clients and no sessions** ⇒ exit after a grace period. A daemon with
 *     nothing to guard is a stray process, and one per crashed run would
 *     accumulate forever.
 *   - **Sessions, but no clients** ⇒ never exit. That IS the app being closed
 *     with agents running, which is the case this whole process exists to serve.
 *
 * And a third, which is about REACHABILITY rather than about work:
 *
 *   - **The socket we bound is gone, or is no longer ours** ⇒ exit. The rule
 *     above cannot tell a restarting app from one that is never coming back, so
 *     it assumes the first — and every abandoned dev run and smoke therefore
 *     kept its ptys for good (measured: 51 daemons, 475 of this machine's 511
 *     ptys, every fresh `pty create` failing). A smoke deletes its support
 *     directory on the way out, socket included, so nothing can dial that daemon
 *     ever again. `socket-watch.ts` argues why that is a fact rather than a
 *     guess, and why the production socket never trips it.
 */

const IDLE_EXIT_MS = 30_000;

/**
 * How often the daemon checks that it is still reachable.
 *
 * A minute, because nothing here is racing: the condition it detects is
 * permanent once true, and the cost of noticing it late is one stray process for
 * up to a minute rather than for ever.
 */
const SOCKET_CHECK_MS = 60_000;

export interface Args {
  readonly socketPath: string;
  readonly level: LogLevel;
  /**
   * Where a paired DEVICE reaches the ptys, as `<support>` — absent means the
   * daemon serves the local socket only.
   *
   * The data path is the daemon's on purpose (ADR-recorded as D4): the terminal
   * then survives the app restarting. Update Shepherd and the sidebar on your
   * phone goes briefly stale while the agent you were watching keeps streaming.
   */
  readonly support?: string;
  /**
   * Which remote transport to serve the ptys over, by name.
   *
   * Forwarded from the app rather than decided here: the two processes must
   * agree, because a device holds a control connection to one and a data
   * connection to the other, and a phone that can reach the task list but not
   * the pty is the exact failure this milestone exists to prevent.
   */
  readonly transport: string;
  /**
   * What this machine calls itself, for the OSC 7 host check a session's mirror
   * makes.
   *
   * Forwarded rather than read, because `boundaries.js` puts OS APIs in
   * `platform/darwin` alone and this process may reach neither it nor `node:os`.
   * Absent means a mirror accepts only a host-less OSC 7 — a cwd that does not
   * update beats one taken from an `ssh` session's far end.
   */
  readonly hostname?: string;
  /**
   * How often to check that the socket we bound is still ours.
   *
   * A flag rather than a constant because it is the ONLY way to observe the
   * third exit rule in a test that finishes: the condition is permanent once
   * true, so a minute is right in production and unbearable in a smoke.
   */
  readonly socketCheckMs: number;
}

export function parseArgs(argv: readonly string[]): Args {
  let socketPath = '';
  let level: LogLevel = 'info';
  let support: string | undefined;
  let transport = 'loopback';
  let hostname: string | undefined;
  let socketCheckMs = SOCKET_CHECK_MS;
  for (const arg of argv) {
    if (arg.startsWith('--socket-check-ms=')) {
      const given = Number.parseInt(arg.slice('--socket-check-ms='.length), 10);
      // A zero or a word would busy-loop or produce a `NaN` interval that never
      // fires; either way the rule silently stops existing.
      if (Number.isInteger(given) && given > 0) socketCheckMs = given;
    }
    if (arg.startsWith('--transport=')) transport = arg.slice('--transport='.length);
    if (arg.startsWith('--socket=')) socketPath = arg.slice('--socket='.length);
    if (arg.startsWith('--log-level=')) level = arg.slice('--log-level='.length) as LogLevel;
    if (arg.startsWith('--support=')) support = arg.slice('--support='.length);
    if (arg.startsWith('--hostname=')) hostname = arg.slice('--hostname='.length);
  }
  return {
    socketPath,
    socketCheckMs,
    level,
    transport,
    ...(support === undefined ? {} : { support }),
    ...(hostname === undefined || hostname === '' ? {} : { hostname }),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const { socketPath, level, support, transport, hostname, socketCheckMs } = parseArgs(argv);
  const log = createLogger({
    clock: systemClock,
    level,
    // stdout: the launcher redirects it to a file. A daemon that logged nowhere
    // would make "the app cannot reach it" unanswerable.
    sink: (line) => process.stdout.write(`${line}\n`),
  });
  const daemon = log.child('session');

  if (socketPath === '') {
    daemon.error('refusing to start: --socket=<path> is required');
    return 2;
  }

  await mkdir(dirname(socketPath), { recursive: true });

  // The single-instance decision, reused rather than reinvented: a connect probe
  // that distinguishes "somebody is listening" from "a corpse from a crashed
  // run". v1 unlinked unconditionally and a second instance silently stole the
  // socket from the first.
  const reclaimed = await reclaimSocketPath(socketPath, log);
  if (!reclaimed.ok) {
    daemon.error(`refusing to start: ${reclaimed.error}`);
    return 3;
  }

  const host = new SessionHost({
    // The OSC 7 host check's other half — core is handed this rather than
    // reading it, so a session's cwd can only ever come from this machine.
    ...(hostname === undefined ? {} : { hostname }),
    onError: (error, context) => daemon.warn(`${context}: ${String(error)}`),
  });
  const server = new SessionServer({ host, log });

  /**
   * `hooks.sock`, served HERE rather than in the app.
   *
   * The whole reason: an agent keeps firing hooks into a pty this process owns
   * while the app is being replaced, and `report.sh` finds no socket and exits 0
   * — deliberately, so an observer can never stall the agent it observes. Every
   * one of those events used to be lost, and a `claude` that did not restart never
   * fires another `SessionStart` to say what happened. So the process that
   * outlives the app holds them, exactly as it holds the ptys (D4).
   *
   * The path is derived from `--socket` rather than from `--support`: the two must
   * land in the same directory as the value `SHEPHERD_EVENTS_SOCK` carries, and
   * deriving it from the one argument that is always present is what makes that a
   * guarantee rather than a convention. `--support` is optional here.
   *
   * A bind that FAILS is logged and left: the app keeps its own ingress for
   * exactly this case, and `setServesHooks` is what tells it which of the two is
   * live. That is also the upgrade path — a new app against this old daemon finds
   * the capability absent and serves hooks itself.
   */
  const hookSocketPath = `${dirname(socketPath)}/hooks.sock`;
  const hooks = new EventsIngress({
    path: hookSocketPath,
    deliver: (envelope) => server.recordHook(envelope),
    logger: log,
  });
  const hooksStarted = await hooks.start();
  if (hooksStarted.ok) {
    server.setServesHooks(true);
    daemon.info(`serving agent hooks on ${hookSocketPath}`);
  } else {
    // Not fatal, and not silent: the app falls back to serving them itself, which
    // costs only the events fired while it is down — today's behaviour.
    daemon.warn(`not serving agent hooks (${hooksStarted.error}); the app will serve them itself`);
  }

  const net = createServer((socket: Socket) => {
    // The id is the SERVER's, not ours. This process feeds it from two
    // transports — this socket and the TLS endpoint below — and when each
    // numbered its own connections from 1 the second one to arrive replaced the
    // first in the server's client table. See `Connection` in core.
    const id = server.accept({
      write: (bytes) => {
        socket.write(bytes);
      },
      close: () => socket.destroy(),
    });
    socket.on('error', (error) => daemon.warn(`client ${id} socket error: ${String(error)}`));
    socket.on('close', () => {
      server.disconnect(id);
      armIdleExit();
    });
    socket.on('data', (chunk: Buffer) => {
      server.feed(id, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    disarmIdleExit();
  });

  /**
   * The DATA path for paired devices (D4).
   *
   * A device pairs with the app — only the app can show an approval — and then
   * presents the secret it was issued here. The daemon shows no code, so
   * `pairingDecision` refuses every unknown device: a headless process cannot
   * admit a stranger, which is what makes serving from here safe.
   *
   * An admitted connection is handed to the SAME `SessionServer` the Mac's own
   * renderer talks to. There is no device-specific session code anywhere,
   * because that is the whole design.
   */
  let remotePort: number | undefined;
  const resolved = resolveTransport(transport);
  if (!resolved.ok) daemon.error(resolved.error);
  // Refuses rather than falling back: serving the ptys a different way than the
  // app serves control is how a phone gets a task list it can reach and a
  // terminal it cannot.
  const endpointFor: EndpointFactory | undefined = resolved.ok ? resolved.value : undefined;
  if (support !== undefined && endpointFor !== undefined) {
    const identity = await loadOrMintIdentity({
      dir: `${support}/remote-identity`,
      // The app normally mints it first; the daemon minting is the crash-recovery
      // case, and both land on the same file so a device's pin still matches.
      mint: async () => ({ ok: false, error: 'the daemon does not mint identities' }),
    });
    if (identity.ok) {
      /**
       * The port this daemon served on last time, re-used.
       *
       * A device stores the data port it paired with, so an OS-chosen one moves
       * whenever the daemon restarts and the phone dials an address that now
       * belongs to nobody — its terminal simply never paints. The control port
       * needed the same fix for the same reason; a port a client remembers has
       * to be a port the host remembers too.
       */
      const remembered = await readPort(`${support}/remote-data-port`);
      const remote = new RemoteServer({
        // The DATA path follows the control path onto the network, because a
        // device holds both and half a membership is no membership: reachable views
        // and an unreachable terminal is the shape this whole milestone exists
        // to avoid.
        endpoint: endpointFor({
          identity: identity.value,
          ...(remembered === undefined ? {} : { port: remembered }),
        }),
        identity: identity.value,
        // THE store, opened read-mostly by this process too. The app admits a
        // new member (only it can show an approval); the daemon reads, so a
        // device that joined there is admitted here with no second ceremony —
        // and a member of the net the app has never seen is admitted by its
        // chain, which is the same code path.
        net: kvNetStore(
          new SqliteStore({ location: `${support}/remote.db`, logger: log }).namespace('devices'),
        ),
        sessions: server,
        // Never reached: with no code showing, an unknown device is refused
        // before an approval is asked for. Present because the type requires it,
        // and refusing is the only honest answer a process with no UI can give.
        approve: async () => false,
        log: daemon,
        newCode: () => '',
        now: () => Date.now(),
      });
      let listening = await remote.start();
      if (!listening.ok && remembered !== undefined) {
        // Taken by something else: serve on a fresh one rather than not at all.
        // Paired devices must then re-pair, which is worse than being reachable
        // and better than being silently absent.
        daemon.warn(`data port ${remembered} is taken — serving on a fresh one`);
        listening = await new RemoteServer({
          endpoint: endpointFor({ identity: identity.value }),
          identity: identity.value,
          net: kvNetStore(
            new SqliteStore({ location: `${support}/remote.db`, logger: log }).namespace('devices'),
          ),
          sessions: server,
          approve: async () => false,
          log: daemon,
          newCode: () => '',
          now: () => Date.now(),
        }).start();
      }
      if (listening.ok) {
        remotePort = listening.value.port;
        daemon.info(`remote data path on ${listening.value.address}:${remotePort}`);
        // Written where the app can read it back for the pairing payload: the
        // port is chosen by the OS, so this file is the only honest source.
        await writeFile(`${support}/remote-data-port`, String(remotePort), 'utf8');
      }
    } else {
      // Not fatal: the local socket still works, so the Mac is unaffected. Said
      // out loud because "my phone cannot open a terminal" has to be traceable.
      daemon.warn(`no remote data path: ${identity.error}`);
    }
  }

  let idleTimer: NodeJS.Timeout | undefined;
  function disarmIdleExit(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }
  function armIdleExit(): void {
    disarmIdleExit();
    idleTimer = setTimeout(() => {
      // Re-checked at FIRE time, not at arm time: a session created during the
      // grace period must cancel the exit, and a client that connected and left
      // again must not extend it forever.
      if (server.clientCount > 0 || host.list().length > 0) {
        armIdleExit();
        return;
      }
      daemon.info('no clients and no sessions — exiting');
      shutdown(0);
    }, IDLE_EXIT_MS);
    // Never hold the event loop open just to wait for our own exit.
    idleTimer.unref?.();
  }

  /**
   * Keep checking that the socket we bound is still the one under our name.
   *
   * Started only after a successful `listen`, so the identity recorded is the
   * file this process is actually serving. A stat that fails for any reason
   * OTHER than the path being absent is ignored: `undefined` here means ENOENT
   * and nothing else, because a daemon that killed live agents over a transient
   * `EINTR` would be a worse bug than the leak this closes.
   */
  async function watchOwnSocket(): Promise<void> {
    const identify = async (): Promise<SocketIdentity | undefined> => {
      try {
        const found = await stat(socketPath);
        return { dev: found.dev, ino: found.ino };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined;
        daemon.warn(`could not stat ${socketPath}: ${String(error)}`);
        // Not `undefined`: that would read as "gone" and end the daemon.
        return bound;
      }
    };

    const bound = await identify();
    if (bound === undefined) {
      // Bound and already unlinked, which is somebody else's race and not a
      // state this can reason about. The other two rules still apply.
      daemon.warn(`${socketPath} vanished between listen and stat — not watching it`);
      return;
    }

    const timer = setInterval(() => {
      void identify().then((now) => {
        const verdict = socketVerdict(bound, now);
        if (verdict === 'ours') return;
        daemon.info(verdictReason(verdict, socketPath));
        clearInterval(timer);
        // `shutdown` kills every session, which is the honest cost: they are
        // ptys nobody can reach and nobody will ever attach to again.
        shutdown(0);
      });
    }, socketCheckMs);
    // Never hold the event loop open just to watch our own file.
    timer.unref?.();
  }

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    server.dispose();
    // `host.dispose()` KILLS every session, so it belongs only on a real
    // shutdown — never on a client going away, which is the distinction this
    // whole process is built around.
    host.dispose();
    net.close();
    // Unlinks the socket file, so a replacement daemon can bind it rather than
    // finding a corpse `reclaimSocketPath` has to reason about.
    void hooks.stop();
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      daemon.info(`${signal} — shutting down, killing ${host.list().length} session(s)`);
      shutdown(0);
    });
  }

  /**
   * A stray error does NOT get to kill every terminal in the app.
   *
   * Node terminates on an unhandled rejection, and this process had no handler
   * for one — so any unawaited failure anywhere in the remote path, the pairing
   * store or the sqlite layer took every pty with it, silently, from a process
   * whose stdio went to `'ignore'`. Measured once: four sessions, two of them
   * already dead ptys of a daemon nobody could account for.
   *
   * Surviving a fault is the deliberate choice here, and it is not the usual
   * one. The asymmetry is what settles it: exiting GUARANTEES the loss of every
   * agent the user has running, while continuing merely risks a degraded
   * process, and the faults this actually catches live in paths a Mac's own
   * terminals never touch. That trade is only honest because it is loud —
   * revisit it if this ever prints without a matching bug being findable.
   */
  process.on('uncaughtException', (error: Error) => {
    daemon.error(`uncaughtException — staying up: ${error.stack ?? String(error)}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    daemon.error(`unhandledRejection — staying up: ${stack}`);
  });

  /**
   * Whatever the reason, the last line says the daemon went.
   *
   * Every named exit above already logs, which is exactly why this one is worth
   * having: it can only ever fire for a route nobody thought of, and that is the
   * route that costs a day. Sync writes only — the fd is a file, so
   * `process.stdout.write` lands before the process does.
   */
  process.on('exit', (code) => {
    daemon.info(`exiting with code ${code}, ${host.list().length} session(s) were live`);
  });

  return new Promise<number>((resolve) => {
    net.on('error', (error) => {
      daemon.error(`listen failed: ${String(error)}`);
      resolve(4);
    });
    net.listen(socketPath, () => {
      daemon.info(`listening on ${socketPath} (pid ${process.pid})`);
      // Announced on stdout in a fixed shape so a launcher can wait for
      // readiness rather than sleeping and hoping.
      process.stdout.write(`shepherdd: ready ${process.pid}\n`);
      armIdleExit();
      void watchOwnSocket();
    });
  });
}

// Entry point. Guarded so the module can be imported by a test without binding.
if (process.argv[1]?.endsWith('main.ts') === true || process.argv[1]?.endsWith('main.js') === true) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}

/** A remembered port, or undefined when there is none. */
async function readPort(path: string): Promise<number | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const value = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
