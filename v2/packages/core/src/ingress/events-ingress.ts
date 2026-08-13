import { s, type Logger, type Result, type Schema } from '@shepherd/sdk';
import type { HookEnvelope } from '../session/hook-journal.ts';
import { UnixHttpServer, type Route } from './unix-http.ts';

/**
 * The external event ingress — `hooks.sock`, which **the daemon** opens. Hooks
 * are its first client, not a special case: anything that can POST JSON can
 * publish an event.
 *
 * It moved out of the app, and that is the fix for a whole class of loss rather
 * than a tidy-up. An agent keeps firing hooks into a pty the daemon owns while
 * the app is being replaced, and `report.sh` finds no socket and exits 0 —
 * deliberately, because a wedged listener must never stall the agent observing
 * it. So every event during a restart vanished, and the app came back believing
 * nothing had happened. The process that outlives the app holds the socket now,
 * exactly as it holds the ptys (D4).
 *
 * Which is why this takes a `deliver` rather than an `EventBus`: there is no bus
 * in the daemon. The sink decides whether an envelope is forwarded to a connected
 * app or journalled for the next one — see `SessionServer.recordHook`.
 *
 * The wire shape, from bash:
 *
 * ```sh
 * { printf '{"topic":"claude.hook","session_id":"%s","payload":' "$SHEPHERD_SESSION_ID"
 *   printf '%s' "$payload"
 *   printf '}'
 * } | curl -sS --max-time 2 --unix-socket "$SHEPHERD_EVENTS_SOCK" \
 *       -H 'content-type: application/json' --data-binary @- http://unix/events
 * ```
 *
 * Note what is not there. **No JSON tool**: field extraction happens in
 * TypeScript on this side, so the hook's own stdin is spliced in verbatim and
 * there is nothing left for bash to escape — which is what v1's hand-rolled
 * escaper got wrong (a payload with a newline became invalid JSON and was
 * dropped in silence), and `jq` is not on a stock macOS anyway. **And no
 * `seq`**: the bus numbers per source, and a client-side counter is
 * read-increment-write with no lock, so two concurrent hooks both post the same
 * number and the second is judged a duplicate and dropped before delivery — a
 * lost `Stop` strands a pane at `working` for good.
 *
 * **The field is `session_id`, not `pane_id`.** v1's `tab_id` held a pane id —
 * a load-bearing lie across ~10 files — and core-design §5.2 proposed
 * `SHEPHERD_PANE_ID` (= session id), which is the same lie in new clothes. The
 * session is what a hook actually correlates to and what `SessionID` is declared
 * to be ("THE correlation key, everywhere"), so the name says session.
 */

export const EVENTS_ROUTE = '/events';

interface EventPost {
  topic: string;
  session_id: string;
  seq?: number;
  payload?: unknown;
}

const eventPostSchema: Schema<EventPost> = s.object({
  topic: s.string(),
  session_id: s.string(),
  /**
   * Optional, and its absence is not an error: a client that does not track its
   * own ordering lets the bus number it. Present, it is authoritative — see
   * `EventBus.emit`, which detects gaps rather than papering over them.
   */
  seq: s.optional(s.int()),
  payload: s.optional(s.unknown()),
});

export interface EventsIngressOptions {
  readonly path: string;
  /**
   * Where a well-formed envelope goes. Called synchronously, before the ack —
   * the hook is a synchronous shell command waiting on this response, so an ack
   * that outran the delivery would let a turn proceed on a state nobody has.
   */
  deliver(envelope: HookEnvelope): void;
  readonly logger: Logger;
}

export class EventsIngress {
  readonly #server: UnixHttpServer;

  constructor(options: EventsIngressOptions) {
    const log = options.logger.child('ingress');

    const post: Route = {
      method: 'POST',
      path: EVENTS_ROUTE,
      handle({ body }) {
        const parsed = eventPostSchema.parse(body);
        if (!parsed.ok) {
          // A malformed envelope is answered, not dropped. v1's equivalent failure
          // was silent: the pane never went blocked and nothing said why.
          const detail = parsed.error.map((issue) => `${issue.path} ${issue.message}`).join('; ');
          log.warn(`rejected an envelope: ${detail}`);
          return {
            kind: 'json',
            status: 400,
            body: { ok: false, error: { code: 'invalid-envelope', message: detail } },
          };
        }

        const event = parsed.value;
        options.deliver({
          topic: event.topic,
          sessionId: event.session_id,
          payload: event.payload ?? {},
          ...(event.seq === undefined ? {} : { seq: event.seq }),
        });

        // A real ack. The hook is synchronous, so this is what lets it return
        // knowing the event landed — and `seq` echoes back so a client can see
        // what the bus believes about its ordering.
        return { kind: 'json', status: 202, body: { ok: true, seq: event.seq ?? null } };
      },
    };

    this.#server = new UnixHttpServer({
      path: options.path,
      logger: options.logger,
      name: 'events',
      routes: [post],
    });
  }

  start(): Promise<Result<void, string>> {
    return this.#server.start();
  }

  stop(): Promise<void> {
    return this.#server.stop();
  }
}
