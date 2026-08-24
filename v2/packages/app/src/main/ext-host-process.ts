import { join } from 'node:path';
import { MessageChannelMain, app, utilityProcess } from 'electron';
import type { Logger } from '@shepherd/sdk';
import type { HostFrame } from '../shared/ext-protocol.ts';
import type { ExtChildProcess } from './ext-host.ts';
import { forwardChildOutput } from './child-output.ts';

/**
 * The only file that knows the extension host is a `utilityProcess`.
 *
 * Everything above it talks to `ExtChildProcess`, which is why `ext-host.ts` is
 * unit-testable and why this file is small enough to read in one sitting. Four
 * Electron facts are encoded here and nowhere else:
 *
 *   - **The child is a fourth build target.** `utilityProcess.fork` needs built
 *     JS, and electron-vite builds main/preload/renderer — so
 *     `electron.vite.config.ts` adds `src/ext-host/index.ts` as a second input to
 *     the main build, landing at `out/main/ext-host.js` beside `index.js`. This
 *     path is that decision's other half; the two must move together.
 *   - **Frames ride a `MessageChannelMain`, not `parentPort` itself.**
 *     `parentPort` also carries Electron's own lifecycle messages, so a dedicated
 *     port keeps a future lifecycle message from arriving at `readFrames` and
 *     being logged as an unreadable frame forever.
 *   - **`MessagePortMain` queues until `start()`.** Both ends call it. Skipping it
 *     produces the `acceptBridged` failure exactly: a handshake that completes
 *     and is answered by nobody, with no error anywhere.
 *   - **`fork` only works after `app.whenReady()`.** Electron says so; a fork
 *     before that throws, and the throw would land inside the first activation.
 *
 * `stdio: 'pipe'`, not `'inherit'`. The child writes its own diagnostics to
 * stderr before the host has accepted its protocol — the one window in which it
 * cannot log through the port — and inheriting sent them to a terminal an
 * installed app does not have. Piped, they go through the logger to the file.
 */

/** Where the fourth build target lands, relative to `out/main/index.js`. */
export const EXT_HOST_ENTRY = 'ext-host.js';

export interface SpawnOptions {
  readonly logger: Logger;
  /** Overridable for a packaged layout or a test; defaults beside the main bundle. */
  readonly entry?: string;
}

export function forkExtensionHost(options: SpawnOptions): ExtChildProcess {
  const log = options.logger.child('extension');
  const entry = options.entry ?? join(import.meta.dirname, EXT_HOST_ENTRY);
  if (!app.isReady()) {
    // A named refusal rather than Electron's own message, which does not mention
    // that the caller is the extension host.
    throw new Error('utilityProcess.fork may only be called after app.whenReady(); the extension host was not started');
  }

  const child = utilityProcess.fork(entry, [], {
    serviceName: 'Shepherd Extension Host',
    stdio: 'pipe',
  });
  forwardChildOutput(child, log, 'the extension host');
  const channel = new MessageChannelMain();
  const port = channel.port1;

  // The child gets port2 and reads it off `event.ports[0]`. Sent on `spawn` rather
  // than immediately: a message posted before the child's V8 exists is dropped,
  // and the symptom is a host that never says hello — indistinguishable from a
  // child that crashed on its first line.
  child.once('spawn', () => {
    child.postMessage({ kind: 'shepherd:ext-host-port' }, [channel.port2]);
    log.debug(`extension host forked from ${entry}`);
  });

  child.on('error', (type, location) => {
    // V8 fatal errors arrive here, and `exit` follows. Logged separately because
    // the exit code alone does not say the process died of a non-continuable error.
    log.error(`extension host fatal error (${type}) at ${location}`);
  });

  port.start();

  return {
    post: (frame: HostFrame) => port.postMessage(frame),
    onFrame: (fn) => port.on('message', (message) => fn(message.data)),
    onExit: (fn) => child.on('exit', (code) => fn(code)),
    kill: () => {
      port.close();
      child.kill();
    },
  };
}
