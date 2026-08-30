import {
  externalCallerSchema,
  s,
  toDisposable,
  type Caller,
  type Logger,
  type Result,
  type Schema,
} from '@shepherd/sdk';
import type { ControlSurface, Subscription } from '../control/index.ts';
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
 *
 * Since the core/UI isolation work it adapts a `ControlSurface` rather than the
 * registry directly, and that is the point rather than a refactor: the app's
 * renderer adapts the SAME object over IPC, so snapshot-then-delta and
 * pull-with-nudge are one implementation with two transports instead of a
 * protocol whose only consumer never exercised it.
 */

export const INVOKE_ROUTE = '/invoke';
export const COMMANDS_ROUTE = '/commands';
export const SUBSCRIBE_ROUTE = '/subscribe';
/** What a client may follow, and how each topic behaves. */
export const TOPICS_ROUTE = '/topics';
/**
 * "I have read" — the other half of pull-with-nudge (ADR 0031).
 *
 * A POST rather than something on the stream, because the stream is a one-way
 * NDJSON response: HTTP has no upstream channel inside a response body, so the
 * reader's acknowledgement has to be its own request. The subscription names
 * itself in the stream's first frame.
 */
export const PULL_ROUTE = '/pull';

interface InvokePost {
  command: string;
  args?: unknown;
  caller: Exclude<Caller, { kind: 'user' }>;
  timeoutMs?: number;
}

const invokePostSchema: Schema<InvokePost> = s.object({
  command: s.string(),
  args: s.optional(s.unknown()),
  /**
   * How long this client will wait (ADR 0030). A command whose work is a model
   * call outlives any default a transport could pick, and without this the client
   * is told `timeout` while the work is still running.
   */
  timeoutMs: s.optional(s.int()),
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
  readonly surface: ControlSurface;
  readonly logger: Logger;
}

interface PullPost {
  subscription: string;
}

const pullPostSchema: Schema<PullPost> = s.object({ subscription: s.string() });

export class ControlIngress {
  readonly #server: UnixHttpServer;
  /** Live subscriptions, so `/pull` can find the one a reader names. */
  readonly #subscriptions = new Map<string, Subscription>();
  #nextSubscription = 0;

  constructor(options: ControlIngressOptions) {
    const log = options.logger.child('ingress');
    const subscriptions = this.#subscriptions;
    const nextId = (): string => `sub-${(this.#nextSubscription += 1)}`;

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

        const { command, args, caller, timeoutMs } = parsed.value;
        const result = await options.surface.invoke(
          command,
          args,
          caller,
          timeoutMs === undefined ? undefined : { timeoutMs },
        );

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
      handle: () => ({ kind: 'json', status: 200, body: { ok: true, value: options.surface.list() } }),
    };

    const topics: Route = {
      method: 'GET',
      path: TOPICS_ROUTE,
      handle: () => ({ kind: 'json', status: 200, body: { ok: true, value: options.surface.topics.list() } }),
    };

    const pull: Route = {
      method: 'POST',
      path: PULL_ROUTE,
      handle({ body }) {
        const parsed = pullPostSchema.parse(body);
        if (!parsed.ok) {
          return {
            kind: 'json',
            status: 400,
            body: { ok: false, error: { code: 'invalid-request', message: 'a subscription id is required' } },
          };
        }
        const subscription = subscriptions.get(parsed.value.subscription);
        if (subscription === undefined) {
          // 404, not 200: a reader pulling a subscription that has gone is a
          // reader that will wait forever for a nudge nobody can send, and it
          // has to be able to tell that from "you are caught up".
          return {
            kind: 'json',
            status: 404,
            body: {
              ok: false,
              error: { code: 'unknown-subscription', message: `no subscription ${parsed.value.subscription}` },
            },
          };
        }
        subscription.pull();
        return { kind: 'json', status: 200, body: { ok: true, value: { pulled: true } } };
      },
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
            const id = nextId();
            /*
             * The id goes out BEFORE any frame the subscription produces, so a
             * reader that sees a nudge already knows what to pull. It is the
             * same "these are one step" discipline the snapshot follows, and it
             * is why `open` writes rather than returning a header.
             */
            write({ kind: 'open', topic, subscription: id });
            const subscription = options.surface.subscribe(topic, (frame) => write(frame));
            subscriptions.set(id, subscription);
            return toDisposable(() => {
              subscriptions.delete(id);
              subscription.dispose();
              log.debug(`subscriber ${id} left ${topic}`);
            });
          },
        };
      },
    };

    this.#server = new UnixHttpServer({
      path: options.path,
      logger: options.logger,
      name: 'control',
      routes: [invoke, list, topics, subscribe, pull],
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
