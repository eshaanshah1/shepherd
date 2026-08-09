import { connect, type Socket } from 'node:net';
import { spawnDetached } from '@shepherd/platform-darwin';
import type { CategoryLogger } from '@shepherd/sdk';
import type { ClientSocket } from './session-client.ts';

/**
 * Reaching `shepherdd`: connect if it is there, start it if it is not.
 *
 * **Start-if-absent, never start-then-connect.** The daemon is a single instance
 * keyed on its socket, and the normal case after the first launch is that one is
 * already running with your agents in it. Spawning first and asking questions
 * later would either race two daemons onto one socket or, worse, have the second
 * one lose and exit while the app waited on it.
 *
 * The daemon is **this same binary** re-executed with `ELECTRON_RUN_AS_NODE=1`
 * (measured: node-pty loads there against the ABI it is already built for), and
 * **detached with `unref`** so it reparents to init and outlives us. That last
 * part is the whole milestone; a child that died with its parent would make this
 * an elaborate way to change nothing.
 */

export interface LauncherOptions {
  readonly socketPath: string;
  /** Passed through so the daemon can serve the DATA path to paired devices. */
  readonly support: string;
  /** The daemon entry — `main.ts` in dev, the bundled `main.js` when packaged. */
  readonly entry: string;
  readonly log: CategoryLogger;
  /** How long to keep retrying a freshly spawned daemon before giving up. */
  readonly readyTimeoutMs?: number;
  /** Injected so a test need not spawn a real process. */
  readonly spawn?: (entry: string, socketPath: string, support: string) => void;
}

const READY_TIMEOUT_MS = 10_000;
const RETRY_MS = 100;

export function daemonConnector(options: LauncherOptions): () => Promise<ClientSocket> {
  return async () => {
    const existing = await tryConnect(options.socketPath);
    if (existing) {
      options.log.info(`connected to a session daemon already running at ${options.socketPath}`);
      return wrap(existing);
    }

    options.log.info('no session daemon listening — starting one');
    (options.spawn ?? spawnDaemon)(options.entry, options.socketPath, options.support);

    const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      // Poll rather than watch: the socket appears when the daemon binds, and
      // there is no event for that a would-be client can subscribe to.
      const socket = await tryConnect(options.socketPath);
      if (socket) {
        options.log.info('the session daemon came up');
        return wrap(socket);
      }
      if (Date.now() > deadline) {
        throw new Error(`the session daemon did not come up within ${options.readyTimeoutMs ?? READY_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  };
}

function tryConnect(path: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const give = (value: Socket | undefined) => {
      socket.removeAllListeners('connect');
      socket.removeAllListeners('error');
      resolve(value);
    };
    socket.once('connect', () => give(socket));
    socket.once('error', () => {
      socket.destroy();
      give(undefined);
    });
  });
}

/**
 * The daemon is THIS binary, re-executed as node.
 *
 * The spawn itself lives in `platform/darwin` — `boundaries.js` denies
 * `child_process` here, and the first version of this satisfied lint with a
 * `require()`, which is exactly the quiet route-around that file exists to
 * prevent.
 */
function spawnDaemon(entry: string, socketPath: string, support: string): void {
  spawnDetached({
    execPath: process.execPath,
    args: [entry, `--socket=${socketPath}`, `--support=${support}`],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
}

/** A `net.Socket`, as `SessionClient` wants to see it. */
function wrap(socket: Socket): ClientSocket {
  return {
    write: (bytes) => {
      socket.write(bytes);
    },
    destroy: () => socket.destroy(),
    onData: (fn) =>
      socket.on('data', (chunk: Buffer) => {
        fn(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }),
    onClose: (fn) => socket.on('close', () => fn()),
    onError: (fn) => socket.on('error', (error) => fn(error)),
  };
}
