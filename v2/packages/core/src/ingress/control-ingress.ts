import {
  externalCallerSchema,
  s,
  toDisposable,
  type Caller,
  type Logger,
  type Result,
  type Schema,
} from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { EventBus } from '../events/bus.ts';
import { UnixHttpServer, type Route } from './unix-http.ts';

/**
 * `control.sock` — the CLI's front door, and a **thin adapter over
 * `commands.invoke`**. It owns no verbs of its own.
 *
 * That is the whole point. v1 had three routing implementations
 * (`ShortcutActions`, `controlRoute`, `applyRemoteCommand`) which disagreed about
 * authorization and about what happened when a verb was unknown; here a transport
 * parses a caller, hands the registry a string and some JSON, and returns what it
 * says. Adding a command adds nothing to this file.
 *
 * CLI-first by decision (§7b): MCP is deferred and would be another adapter over
 * the same registry, never a second verb table.
 */

export const INVOKE_ROUTE = '/invoke';
export const COMMANDS_ROUTE = '/commands';
export const SUBSCRIBE_ROUTE = '/subscribe';

interface InvokePost {
  command: string;
  args?: unknown;
  caller: Exclude<Caller, { kind: 'user' }>;
}

const invokePostSchema: Schema<InvokePost> = s.object({
  command: s.string(),
  args: s.optional(s.unknown()),
  /**
   * The caller is *claimed* here and *checked* in the dispatcher. Note the type:
   * `externalCallerSchema` has no `user` variant, so a socket client cannot claim
   * to be the human at the keyboard — that kind is minted in-process, by the code
   * that saw the keystroke. Everything else is verified by `authorize`, which
   * denies a principal it does not know: an extension that is not loaded, a device
   * that is not paired, a session id that is not live.
   */
  caller: externalCallerSchema,
});

export interface ControlIngressOptions {
  readonly path: string;
  readonly commands: CommandRegistry;
  readonly bus: EventBus;
  readonly logger: Logger;
}

export class ControlIngress {
  readonly #server: UnixHttpServer;

  constructor(options: ControlIngressOptions) {
    const log = options.logger.child('ingress');

    const invoke: Route = {
      method: 'POST',
      path: INVOKE_ROUTE,
      async handle({ body }) {
        const parsed = invokePostSchema.parse(body);
        if (!parsed.ok) {
          const detail = parsed.error.map((issue) => `${issue.path} ${issue.message}`).join('; ');
          log.warn(`rejected an invoke: ${detail}`);
          return { kind: 'json', status: 400, body: { ok: false, error: { code: 'invalid-request', message: detail } } };
        }

        const { command, args, caller } = parsed.value;
        const result = await options.commands.invoke(command, args, caller);

        // The registry's own error codes travel out unchanged, and the HTTP status
        // is derived from them rather than invented — so `shepherd` can print the
        // real reason ("lacks permission \"layout\"", "cols: expected integer")
        // instead of a generic failure.
        return { kind: 'json', status: result.ok ? 200 : statusFor(result), body: result };
      },
    };

    const list: Route = {
      method: 'GET',
      path: COMMANDS_ROUTE,
      handle: () => ({ kind: 'json', status: 200, body: { ok: true, value: options.commands.list() } }),
    };

    /**
     * The subscription `shepherd wait` rides.
     *
     * v1's `wait` polled every 200ms — up to 1,500 round-trips — and because it
     * *sampled* state it missed any transition faster than its own interval. A
     * long-lived NDJSON response inverts that: the app pushes, the client blocks,
     * and nothing is sampled at all.
     */
    const subscribe: Route = {
      method: 'GET',
      path: SUBSCRIBE_ROUTE,
      handle({ query }) {
        const topic = query.get('topic') ?? '*';
        return {
          kind: 'ndjson',
          open(write) {
            const subscription = options.bus.on(topic, (payload, envelope) => {
              write({ topic, payload, envelope });
            });
            log.debug(`subscriber attached to ${topic}`);
            return toDisposable(() => {
              subscription.dispose();
              log.debug(`subscriber left ${topic}`);
            });
          },
        };
      },
    };

    this.#server = new UnixHttpServer({
      path: options.path,
      logger: options.logger,
      name: 'control',
      routes: [invoke, list, subscribe],
    });
  }

  start(): Promise<Result<void, string>> {
    return this.#server.start();
  }

  stop(): Promise<void> {
    return this.#server.stop();
  }
}

/** One place maps a command failure onto HTTP, so a CLI can branch on status. */
function statusFor(result: { ok: false; error: { code: string } }): number {
  switch (result.error.code) {
    case 'unknown-command':
      return 404;
    case 'invalid-args':
      return 400;
    case 'denied':
      return 403;
    case 'unavailable':
      return 503;
    default:
      return 500;
  }
}
