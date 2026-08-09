import { createServer, type Socket } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SessionHost, reclaimSocketPath } from '@shepherd/core';
import { createLogger, systemClock, type LogLevel } from '@shepherd/sdk';
import { SessionServer } from './server.ts';

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
 */

const IDLE_EXIT_MS = 30_000;

interface Args {
  readonly socketPath: string;
  readonly level: LogLevel;
}

function parseArgs(argv: readonly string[]): Args {
  let socketPath = '';
  let level: LogLevel = 'info';
  for (const arg of argv) {
    if (arg.startsWith('--socket=')) socketPath = arg.slice('--socket='.length);
    if (arg.startsWith('--log-level=')) level = arg.slice('--log-level='.length) as LogLevel;
  }
  return { socketPath, level };
}

export async function main(argv: readonly string[]): Promise<number> {
  const { socketPath, level } = parseArgs(argv);
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
    onError: (error, context) => daemon.warn(`${context}: ${String(error)}`),
  });
  const server = new SessionServer({ host, log });

  let nextConnectionId = 1;
  const net = createServer((socket: Socket) => {
    const id = nextConnectionId;
    nextConnectionId += 1;
    socket.on('error', (error) => daemon.warn(`client ${id} socket error: ${String(error)}`));
    socket.on('close', () => {
      server.disconnect(id);
      armIdleExit();
    });
    socket.on('data', (chunk: Buffer) => {
      server.feed(id, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    server.accept({
      id,
      write: (bytes) => {
        socket.write(bytes);
      },
      close: () => socket.destroy(),
    });
    disarmIdleExit();
  });

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
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      daemon.info(`${signal} — shutting down, killing ${host.list().length} session(s)`);
      shutdown(0);
    });
  }

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
    });
  });
}

// Entry point. Guarded so the module can be imported by a test without binding.
if (process.argv[1]?.endsWith('main.ts') === true || process.argv[1]?.endsWith('main.js') === true) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
