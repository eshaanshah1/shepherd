import { KERNEL, type Disposable, type Logger, type PaneID, type SessionID } from '@shepherd/sdk';
import type { EventBus, ViewingResolver } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';

/**
 * `session.viewing` — the one predicate (ADR 0020) put on the bus, so an agent
 * extension a process away can hold a *cache* of the answer instead of asking
 * the question again.
 *
 * Why it has to be pushed rather than threaded onto the hook events the child
 * already receives: half of v1's table is *looking at a pane clears
 * need-to-check*, and that edge has no hook behind it. There is nothing to
 * thread it onto, and polling for it would be v1's bug exactly — `didFocus`
 * fired only on a focus change, so a turn that finished in front of you read
 * "done" until you clicked away and back.
 *
 * Why it is published from main rather than from `ViewingResolver`: the resolver
 * takes no `EventBus` and should not start to. Main already consumes its edges
 * the same way `AttentionStore` does, and resolving the session is a `LayoutStore`
 * lookup — so the publisher is the smaller change and keeps core's resolver
 * dependency-free.
 *
 * Nothing here decides *whether* a pane is being looked at. It relays.
 */

export const VIEWING_TOPIC = 'session.viewing';

export interface ViewingChanged {
  readonly sessionId: SessionID;
  readonly paneId: PaneID;
  readonly viewing: boolean;
}

/**
 * Which edges become events: the ones whose pane shows a session. An unbound
 * pane has nothing to correlate to — publishing it would put a `paneId` on the
 * bus that no subscriber can key anything by, which is `tab_id`-holding-a-pane-id
 * one layer along.
 */
export function viewingEvent(
  pane: PaneID,
  viewing: boolean,
  sessionFor: (pane: PaneID) => SessionID | undefined,
): ViewingChanged | null {
  const session = sessionFor(pane);
  if (session === undefined) return null;
  return { sessionId: session, paneId: pane, viewing };
}

export interface ViewingPublisherOptions {
  readonly viewing: ViewingResolver;
  readonly layout: LayoutStore;
  readonly bus: EventBus;
  readonly logger: Logger;
}

export interface ViewingPublisher extends Disposable {
  /**
   * Publish a pane's CURRENT value, unchanged from the resolver.
   *
   * For the binding moment: a pane is focused by the split that created it, so
   * its `true` edge fires before any session exists and is dropped — and
   * `bindSession` announces nothing of its own. Without a replay here a session
   * bound while frontmost would never receive a first value, and every
   * subscriber would start out guessing.
   */
  announce(pane: PaneID): void;
}

export function publishViewingEdges(options: ViewingPublisherOptions): ViewingPublisher {
  const log = options.logger.child('attention');

  const publish = (pane: PaneID, viewing: boolean): void => {
    const event = viewingEvent(pane, viewing, (id) => options.layout.sessionFor(id));
    if (event === null) {
      log.debug(`pane ${pane} viewing=${viewing} shows no session — nothing published`);
      return;
    }
    // `KERNEL`: main derived this from state it holds, and no verb was invoked.
    // The user's gaze is the cause of some edges and a pane closing is the cause
    // of others, and the publisher cannot tell which — so one honest constant
    // rather than an attribution that is right half the time.
    options.bus.emit(VIEWING_TOPIC, event, KERNEL);
  };

  const subscription = options.viewing.onDidChangeViewing(publish);

  return {
    announce: (pane) => publish(pane, options.viewing.isViewing(pane)),
    dispose: () => subscription.dispose(),
  };
}
