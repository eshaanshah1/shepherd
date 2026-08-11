import type { Caller, PaneID, SessionID } from '@shepherd/sdk';
import type { EventBus } from '@shepherd/core';

/**
 * `session.bound` — a session's pane, on the bus, at the moment it becomes true.
 *
 * The symmetric half of `session.exit`, and it exists for the reason that one
 * does: an extension a process away cannot ask the layout anything, so a fact it
 * needs has to be pushed or inferred, and inference here is a heuristic over a
 * pty. Birth is worse than death was — the reconciliation sweep only runs while
 * something is already `working` or `blocked`, so a session that binds and then
 * waits is never swept, and a consumer keyed by pane would hold nothing for it
 * indefinitely.
 *
 * Who needs it: `agents-core` emits agent state keyed by session, and `tasks`
 * can only key a mirror by PANE — its record holds a `pending-` session id for
 * the first seconds after a spawn, which is exactly when an agent hits its trust
 * prompt. Resolving the pane once here beats every consumer re-deriving it.
 *
 * `LayoutStore.bindSession` stays silent on purpose — it is not a structural
 * change and announcing it would re-render the renderer that caused it. This is
 * a bus event rather than a layout notification, so that reasoning is untouched.
 */

export const SESSION_BOUND_TOPIC = 'session.bound';

export interface SessionBound {
  readonly sessionId: SessionID;
  readonly paneId: PaneID;
}

export interface SessionBoundTopic {
  announce(pane: PaneID, session: SessionID): void;
}

export function publishSessionBound(options: { bus: EventBus; by: Caller }): SessionBoundTopic {
  return {
    /**
     * Every bind, with no deduplication. A pane whose session died and was
     * replaced binds again, and a publisher that suppressed the second one would
     * leave every subscriber keyed to the dead pane.
     */
    announce(pane, session) {
      options.bus.emit(SESSION_BOUND_TOPIC, { sessionId: session, paneId: pane }, options.by);
    },
  };
}
