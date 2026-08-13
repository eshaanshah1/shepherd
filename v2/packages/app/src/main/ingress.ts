import { mkdir } from 'node:fs/promises';
import { ControlIngress, EventsIngress, type CommandRegistry, type EventBus } from '@shepherd/core';
import type { Logger, Permission } from '@shepherd/sdk';
import { PERMISSIONS, sessionId } from '@shepherd/sdk';
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
 * Which remote transport to serve over, BY NAME — `loopback` (the default),
 * `wifi`, or whatever else is registered.
 *
 * A name rather than a `--wifi` boolean, because the point of `Endpoint` is that
 * a transport is registered rather than branched on; a flag per transport puts
 * the `if` back one layer up. See `transports.ts`.
 *
 * Loopback stays the default and that is the security posture rather than
 * caution: anything else puts a TLS listener on a network shared with other
 * people's machines, and that must be somebody's decision. Loopback plus
 * `adb reverse` over USB needs no such decision.
 */
export const TRANSPORT_FLAG = '--shepherd-remote';

export const DEFAULT_TRANSPORT = 'loopback';

export function resolveTransportName(argv: readonly string[]): string {
  return flagValue(argv, TRANSPORT_FLAG) ?? DEFAULT_TRANSPORT;
}

/**
 * Where `ctx.homeDir` points, and for the third time the same reason: a
 * throwaway run must not reach the real user's files.
 *
 * It exists because `homeDir` is not read-only. `tasks` pre-seeds Claude Code's
 * trust record for the directories it generates, which is a write into
 * `~/.claude.json` — so without this a smoke would leave records for a dozen
 * deleted temp directories in the developer's own Claude Code configuration on
 * every run.
 */
export const HOME_FLAG = '--shepherd-home';

export function resolveHome(argv: readonly string[], fallback: string): string {
  return flagValue(argv, HOME_FLAG) ?? fallback;
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
  /**
   * Where to serve agent hooks — **absent means the daemon is already serving
   * them**, which is the normal case.
   *
   * The socket moved to the daemon so an event fired while the app is being
   * replaced is journalled rather than lost. This path stays for the daemon that
   * predates that: `pnpm ship` leaves the old process running (deliberately — it
   * is holding your agents' ptys), and it advertises no hook capability, so the
   * app serves them itself exactly as it always did. Dropping this fallback would
   * mean nobody served hooks at all for the life of that daemon, which is a worse
   * failure than the one the journal fixes.
   */
  readonly hookSocket?: string;
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

  const hookSocket = options.hookSocket;
  const events =
    hookSocket === undefined
      ? undefined
      : new EventsIngress({
          path: hookSocket,
          // The same attribution `session-client` re-applies to a forwarded
          // envelope, so the two paths are equivalent rather than merely similar.
          deliver: (envelope) =>
            options.bus.emit(
              envelope.topic,
              envelope.payload,
              { kind: 'agent', sessionId: sessionId(envelope.sessionId) },
              envelope.seq,
            ),
          logger: options.logger,
        });
  const control = new ControlIngress({
    path: options.controlSocket,
    commands: options.registry,
    bus: options.bus,
    logger: options.logger,
  });
  if (events === undefined) log.info('the daemon is serving agent hooks; not opening our own socket');

  const started: { stop(): Promise<void> }[] = [];
  for (const [name, server] of [
    ...(events === undefined ? [] : ([['events', events]] as const)),
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
