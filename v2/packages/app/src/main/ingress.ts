import { mkdir } from 'node:fs/promises';
import { ControlIngress, EventsIngress, type CommandRegistry, type EventBus } from '@shepherd/core';
import type { Logger, Permission } from '@shepherd/sdk';
import { PERMISSIONS } from '@shepherd/sdk';
import { flagValue } from './bootstrap.ts';

/**
 * Starting the two external front doors.
 *
 * Both are unix sockets in the app's own support directory, and both are created
 * only after the single-instance lock is held — v1 `unlink`ed its control socket
 * unconditionally at startup, so a second instance silently stole the CLI from
 * the first and every `shepherd` command then drove the wrong window.
 * `reclaimSocketPath` (inside `UnixHttpServer.start`) is the second half of that
 * fix: it refuses a path something live is answering on.
 */

/**
 * Where the sockets live. Mirrors `--shepherd-user-data`, and for the same
 * reason: a smoke run must not answer on the real instance's socket, and two
 * concurrent runs must not fight over one path. Without this the support
 * directory is derived from `$HOME` alone, so a throwaway userData dir would not
 * make a run isolated — it would just make it *look* isolated.
 */
export const SUPPORT_FLAG = '--shepherd-support';

export function resolveSupport(argv: readonly string[], fallback: string): string {
  return flagValue(argv, SUPPORT_FLAG) ?? fallback;
}

/**
 * The entitlements a caller reaching the LOCAL control socket gets.
 *
 * The socket is `0600` in the user's own support directory, so opening it already
 * proves you are the user this app belongs to — the authorization happened in the
 * filesystem. That is also exactly v1's model (a local control socket with no
 * auth), made explicit rather than implicit.
 *
 * Two things this deliberately is NOT:
 *   - It is not a grant to a *remote* device. When pairing lands, a paired phone
 *     gets its own narrower entitlements; it does not inherit these.
 *   - It is not a grant to an *agent*. An agent in a pane identifies itself as
 *     `{kind:'agent', sessionId}` and is authorized against its own session, so
 *     that scoping keeps working — `authorize` denies a session it does not know,
 *     and populating live sessions is `agents-core`'s job (M2).
 */
export const LOCAL_DEVICE_ID = 'local-cli';
export const LOCAL_DEVICE_PERMISSIONS: readonly Permission[] = PERMISSIONS;

export interface IngressOptions {
  readonly registry: CommandRegistry;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly support: string;
  readonly controlSocket: string;
  readonly hookSocket: string;
}

export interface RunningIngress {
  stop(): Promise<void>;
}

/**
 * Starts both. A socket that cannot be bound is **logged and skipped**, not
 * fatal: a broken hook channel must not stop the terminal from opening, and the
 * one thing that must never happen is the v1 case where a listener silently
 * failed to exist and the symptom was a phone that appeared to be ignored.
 */
export async function startIngress(options: IngressOptions): Promise<RunningIngress> {
  const log = options.logger.child('ingress');
  await mkdir(options.support, { recursive: true, mode: 0o700 });

  const events = new EventsIngress({
    path: options.hookSocket,
    bus: options.bus,
    logger: options.logger,
  });
  const control = new ControlIngress({
    path: options.controlSocket,
    commands: options.registry,
    bus: options.bus,
    logger: options.logger,
  });

  const started: { stop(): Promise<void> }[] = [];
  for (const [name, server] of [
    ['events', events],
    ['control', control],
  ] as const) {
    const result = await server.start();
    if (result.ok) started.push(server);
    else log.error(`${name} socket did not start: ${result.error}`);
  }

  return {
    async stop() {
      for (const server of started) await server.stop();
    },
  };
}
