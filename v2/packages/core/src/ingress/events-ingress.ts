import { s, sessionId, type Logger, type Result, type Schema } from '@shepherd/sdk';
import type { EventBus } from '../events/bus.ts';
import { UnixHttpServer, type Route } from './unix-http.ts';

/**
 * The external event ingress — `hooks.sock`, wherever main opens it. Hooks are
 * its first client, not a special case: anything that can POST JSON can publish
 * an event.
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
  readonly bus: EventBus;
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
        options.bus.emit(
          event.topic,
          event.payload ?? {},
          { kind: 'agent', sessionId: sessionId(event.session_id) },
          event.seq,
        );

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
