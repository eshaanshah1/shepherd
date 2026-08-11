import { describe, expect, it } from 'vitest';
import { EventBus } from '@shepherd/core';
import { KERNEL, nullLogger, paneId, sessionId, systemClock } from '@shepherd/sdk';
import { SESSION_BOUND_TOPIC, publishSessionBound, type SessionBound } from './session-bound.ts';

/**
 * The birth signal, asserted against a REAL bus.
 *
 * `session.exit` exists because inferring a death from the pty sweep is a
 * heuristic. This is the same argument for birth, and it is stronger: the sweep
 * only runs while something is already `working` or `blocked`, so a session that
 * is bound and then sits idle is never swept at all.
 */

describe('session.bound', () => {
  const harness = (): { bus: EventBus; seen: SessionBound[] } => {
    const bus = new EventBus({ logger: nullLogger, clock: systemClock });
    const seen: SessionBound[] = [];
    bus.on(SESSION_BOUND_TOPIC, (payload) => void seen.push(payload as SessionBound));
    return { bus, seen };
  };

  it('carries both ids, so a subscriber can key by either', () => {
    const { bus, seen } = harness();
    publishSessionBound({ bus, by: KERNEL }).announce(paneId('p1'), sessionId('s1'));

    expect(seen).toEqual([{ sessionId: 's1', paneId: 'p1' }]);
  });

  it('announces every bind, because a rebind is a NEW pane for that session', () => {
    // A pane whose session died and was replaced binds again. A publisher that
    // deduplicated would leave every consumer pointing at the dead pane.
    const { bus, seen } = harness();
    const topic = publishSessionBound({ bus, by: KERNEL });

    topic.announce(paneId('p1'), sessionId('s1'));
    topic.announce(paneId('p2'), sessionId('s1'));

    expect(seen.map((event) => event.paneId)).toEqual(['p1', 'p2']);
  });
});
