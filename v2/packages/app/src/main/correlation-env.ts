import type { SessionID } from '@shepherd/sdk';

/**
 * The correlation env every session is created with — `SHEPHERD_SESSION_ID` and
 * the two socket paths a hook (or the CLI) posts back to.
 *
 * **The kernel injects this, not an agent extension.** `SessionHost.onWillCreate`
 * is synchronous by documented design (a session id has to exist in the tick the
 * layout opens a pane), and an extension is reachable only by request/response
 * over a port — so an extension physically cannot answer that hook. Both values
 * are kernel facts anyway: the session id is core's own correlation key and the
 * events socket is core's own front door. What stays vendor-specific is the
 * plugin that reads them.
 *
 * **The names are deliberately not v1's.** v2 has *two* sockets, so `SHEPHERD_SOCK`
 * names neither — and worse, v1 owns that name on this machine and means something
 * incompatible by it (length-framed writes over a raw unix socket, not HTTP). The
 * split is what lets both apps run at once: a `claude` in a v1 pane satisfies v1's
 * guard and no-ops v2's plugin, and the reverse.
 */

export const SESSION_ID_VAR = 'SHEPHERD_SESSION_ID';
export const EVENTS_SOCK_VAR = 'SHEPHERD_EVENTS_SOCK';
export const CONTROL_SOCK_VAR = 'SHEPHERD_CONTROL_SOCK';

export interface CorrelationEnvInput {
  /** The draft's own id — what a hook posts as `session_id`. */
  readonly sessionId: SessionID;
  /** `hooks.sock`: where an event is POSTed. */
  readonly eventsSocket: string;
  /** `control.sock`: where a command is invoked. */
  readonly controlSocket: string;
}

export function correlationEnv(input: CorrelationEnvInput): Record<string, string> {
  return {
    [SESSION_ID_VAR]: input.sessionId,
    [EVENTS_SOCK_VAR]: input.eventsSocket,
    [CONTROL_SOCK_VAR]: input.controlSocket,
  };
}
