import { systemClock } from '@shepherd/sdk';
import type { ChildFrame } from '../shared/ext-protocol.ts';
import { BUILTIN_MODULES } from './builtins.ts';
import { ExtHostRuntime } from './runtime.ts';

/**
 * The utility-process entry point: everything about owning a port, and nothing
 * else. Every decision lives in `runtime.ts`, which knows nothing about Electron
 * and is therefore testable without forking anything.
 *
 * Two Electron facts this file exists to encode:
 *
 *   - **The port comes from the `process.parentPort` GLOBAL.** Not
 *     `import process from 'node:process'` — the boundary lint denies that under
 *     `app/src/**` because an OS builtin belongs to `packages/platform`, and the
 *     global is what Electron actually populates. Lint cannot see a global, so
 *     this comment is the guard.
 *   - **A `MessagePortMain` must be `start()`ed; `parentPort` must not.**
 *     `parentPort` queues messages until a `message` handler is registered, while
 *     a transferred port queues them until `start()` is called and would
 *     otherwise sit silent with both sides believing they were connected. That is
 *     the `acceptBridged` failure shape exactly: a completed handshake answered
 *     by nobody.
 *
 * The dedicated channel is not ceremony either. `parentPort` also carries
 * Electron's own lifecycle messages, so keeping frames on a port of their own
 * means a future lifecycle message cannot arrive at `readFrames` and be logged as
 * an unreadable frame forever.
 */

const stderr = (line: string): void => void process.stderr.write(`[ext-host] ${line}\n`);

const parent = process.parentPort;
if (parent === undefined || parent === null) {
  // Reachable only by running this file outside a utility process. Saying so
  // beats a `TypeError` on `undefined.on`, which reads as a code defect.
  stderr('no parentPort — this entry only runs inside utilityProcess.fork()');
} else {
  parent.once('message', (event) => {
    const port = event.ports[0];
    if (port === undefined) {
      stderr('the host sent its first message with no port attached; there is no channel to answer on');
      return;
    }

    const send = (frame: ChildFrame): void => {
      try {
        port.postMessage(frame);
      } catch (error) {
        // A closed port throws. Nothing can be reported over it by definition, so
        // stderr is the only place left — and a silent catch here would make a
        // dead channel look like a host that stopped asking.
        stderr(`could not post ${frame.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const runtime = new ExtHostRuntime({
      send,
      clock: systemClock,
      childPid: process.pid,
      modules: BUILTIN_MODULES,
      log: stderr,
    });

    port.on('message', (message) => runtime.receive(message.data));
    port.on('close', () => stderr('the host closed the frame channel'));
    // Before `start()` nothing is delivered; before `hello` the host has nothing
    // to judge. In that order, so a `hello-ok` racing our own send still lands.
    port.start();
    runtime.start();
  });
}
