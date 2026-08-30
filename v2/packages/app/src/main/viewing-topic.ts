import { KERNEL, type Disposable, type Logger, type PaneID, type SessionID } from '@shepherd/sdk';
import type { EventBus, PrincipalKey, ViewerRegistry, ViewingResolver } from '@shepherd/core';
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
 *
 * **What changed in ADR 0052:** it relays into a `ViewerRegistry` rather than
 * straight onto the bus, and the bus event carries the aggregated SET. This
 * window is one principal among several — a phone reports its own answer through
 * `sessions.viewing` — and a subscriber must be told "somebody is looking",
 * not "this Mac is looking", or a turn seen on a phone raises a banner here.
 * It is still ONE predicate (ADR 0020): the resolver is still the only thing
 * that decides for this window, and the registry is the only thing that
 * aggregates.
 */

export const VIEWING_TOPIC = 'session.viewing';

export interface ViewingChanged {
  readonly sessionId: SessionID;
  /**
   * The pane THIS window shows it in, when there is one. A viewer is a client,
   * not a pane, so this is a courtesy for the local subscriber rather than the
   * subject — a phone's viewing has no pane here at all.
   */
  readonly paneId?: PaneID;
  /** The aggregate. `viewers.length > 0`, and nothing recomputes it. */
  readonly viewing: boolean;
  /** Who. Present so "why did I get no banner" has an answer that is not a guess. */
  readonly viewers: readonly PrincipalKey[];
}

/*
 * `viewingEvent` used to live here — a pure edge→payload function. It went with
 * ADR 0052: an event is no longer derived from one client's edge, it is derived
 * from the SET after that edge was recorded, and there is nothing left to
 * compute without the registry in hand. Its rule survives in `report` below: an
 * unbound pane has nothing to correlate to, so it reports nothing.
 */

export interface ViewingPublisherOptions {
  readonly viewing: ViewingResolver;
  readonly layout: LayoutStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** Where every client's answer is aggregated. */
  readonly viewers: ViewerRegistry;
  /** This window's name in the set. */
  readonly principal: PrincipalKey;
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
  const { viewers, principal } = options;

  /**
   * The session each pane was last reported as showing.
   *
   * It exists for one edge, and it is the edge that matters most: `LayoutStore
   * .close` deletes the pane→session binding **synchronously** and only then
   * announces the change, so by the time the resolver fires `(closedPane, false)`
   * — the edge it fires precisely so a subscriber stops suppressing alerts for a
   * pane that no longer exists — `sessionFor` is already empty and the report
   * would go nowhere. This principal would then be recorded as viewing a session
   * forever, which is both a suppressed banner and a `SessionLifetime` hold.
   *
   * So the drop path consults what we last said, rather than what the layout can
   * still answer.
   */
  const lastReported = new Map<PaneID, SessionID>();

  /** The pane this window shows a session in, for the courtesy field. */
  const paneOf = (session: SessionID): PaneID | undefined => options.layout.paneForSession(session);

  const emit = (session: SessionID): void => {
    const set = viewers.viewersOf(session);
    const pane = paneOf(session);
    // `KERNEL`: main derived this from state it holds, and no verb was invoked.
    // The user's gaze is the cause of some edges and a pane closing is the cause
    // of others, and the publisher cannot tell which — so one honest constant
    // rather than an attribution that is right half the time.
    options.bus.emit<ViewingChanged>(
      VIEWING_TOPIC,
      {
        sessionId: session,
        ...(pane === undefined ? {} : { paneId: pane }),
        viewing: set.length > 0,
        viewers: set,
      },
      KERNEL,
    );
  };

  /** Answers whether the SET changed, so `announce` can tell an emit happened. */
  const report = (pane: PaneID, viewing: boolean): boolean => {
    const session = options.layout.sessionFor(pane);
    if (session === undefined) {
      const previous = lastReported.get(pane);
      if (previous === undefined) {
        log.debug(`pane ${pane} viewing=${viewing} shows no session — nothing reported`);
        return false;
      }
      lastReported.delete(pane);
      // Always `false`: the pane is no longer showing this session, so THIS
      // client is no longer looking at it, whatever the resolver said about the
      // pane. Another client may still be, and the set says so.
      log.debug(`pane ${pane} no longer shows ${previous} — reported viewing=false for it`);
      return viewers.report(principal, previous, false);
    }
    lastReported.set(pane, session);
    return viewers.report(principal, session, viewing);
  };

  /**
   * Seed the registry from the resolver BEFORE subscribing to it.
   *
   * `PtyFanout`'s rule one layer along: snapshot and register are one step. A
   * publisher that started empty would swallow the FIRST edge of every pane that
   * is already being looked at — the resolver only fires on a change, and the
   * change it fires is from a value the registry never heard.
   *
   * Before the relay, not after: seeding is this window catching up with itself,
   * not news. Emitting it would push a `session.viewing` for every live pane
   * every time this is constructed, which for a subscriber is indistinguishable
   * from the user having just looked at all of them.
   */
  for (const root of options.layout.roots()) {
    for (const pane of options.layout.panes(root)) {
      const session = options.layout.sessionFor(pane);
      if (session === undefined) continue;
      lastReported.set(pane, session);
      viewers.report(principal, session, options.viewing.isViewing(pane));
    }
  }

  /** Every session, not just this window's: a phone's report changes the set too. */
  const relay = viewers.onDidChange((session) => emit(session));

  const subscription = options.viewing.onDidChangeViewing((pane, viewing) => void report(pane, viewing));

  return {
    /**
     * Publish a pane's CURRENT value, changed or not.
     *
     * Unconditional, deliberately: this is a SEED for subscribers, and a seed
     * that only fires on a change is not a seed. A subscriber can tell "not
     * viewed" from "never heard of", and only one of the two is an answer.
     */
    announce: (pane) => {
      const session = options.layout.sessionFor(pane) ?? lastReported.get(pane);
      if (session === undefined) {
        log.debug(`pane ${pane} shows no session — nothing announced`);
        return;
      }
      // Emit only if the report did not already: a change goes out through the
      // relay, and a seed that also emitted would say the same thing twice —
      // which for a subscriber counting edges is a second gesture.
      if (!report(pane, options.viewing.isViewing(pane))) emit(session);
    },
    dispose: () => {
      subscription.dispose();
      relay.dispose();
      lastReported.clear();
    },
  };
}
