import { describe, expect, it } from 'vitest';
import { EventBus, ViewingResolver } from '@shepherd/core';
import { LayoutStore } from '@shepherd/core/layout';
import {
  nullLogger,
  paneId,
  rootId,
  sessionId,
  systemClock,
  type PaneID,
  type SessionID,
} from '@shepherd/sdk';
import { VIEWING_TOPIC, publishViewingEdges, viewingEvent, type ViewingChanged } from './viewing-topic.ts';

/**
 * The `session.viewing` publisher, asserted against a REAL resolver, layout and
 * bus. A fixture that restated the resolver's answers would be a second
 * implementation of the one predicate — the thing ADR 0020 forbids — so a test
 * written that way could not catch the bug it exists to catch.
 */

const ROOT = rootId('window-1');

interface Harness {
  readonly layout: LayoutStore;
  readonly viewing: ViewingResolver;
  readonly bus: EventBus;
  /** Payloads seen on `session.viewing`, in arrival order. */
  readonly seen: ViewingChanged[];
  readonly pane: PaneID;
}

function harness(appActive = true): Harness {
  const layout = new LayoutStore({
    logger: nullLogger,
    clock: systemClock,
    sessions: { kill: () => undefined },
  });
  layout.open(ROOT);
  const viewing = new ViewingResolver(
    layout,
    { appActive, focusedRoot: appActive ? ROOT : null, overlay: false },
    nullLogger,
  );
  const bus = new EventBus({ clock: systemClock, logger: nullLogger });
  const seen: ViewingChanged[] = [];
  bus.on<ViewingChanged>(VIEWING_TOPIC, (payload) => void seen.push(payload));
  const pane = layout.focused(ROOT);
  expect(pane).not.toBeNull();
  return { layout, viewing, bus, seen, pane: pane as PaneID };
}

function publisher(h: Harness): ReturnType<typeof publishViewingEdges> {
  return publishViewingEdges({ viewing: h.viewing, layout: h.layout, bus: h.bus, logger: nullLogger });
}

describe('viewingEvent', () => {
  const bound = (id: SessionID) => (pane: PaneID) => (pane === paneId('p1') ? id : undefined);

  it('turns an edge for a bound pane into the payload', () => {
    const event = viewingEvent(paneId('p1'), true, bound(sessionId('sess-1')));
    expect(event).toEqual({ sessionId: 'sess-1', paneId: 'p1', viewing: true });
  });

  it('publishes nothing for a pane with no session', () => {
    // Paired with the case above deliberately: alone, this would pass just as
    // well against a function that always answered null.
    expect(viewingEvent(paneId('p2'), true, bound(sessionId('sess-1')))).toBeNull();
  });

  it('carries a false edge, which is the half that clears a mirror', () => {
    expect(viewingEvent(paneId('p1'), false, bound(sessionId('sess-1')))?.viewing).toBe(false);
  });
});

describe('publishViewingEdges', () => {
  it('publishes one event per edge for a bound pane', () => {
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);
    const running = publisher(h);

    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });
    h.viewing.setPresence({ appActive: true, focusedRoot: ROOT, overlay: false });

    expect(h.seen).toEqual([
      { sessionId: session, paneId: h.pane, viewing: false },
      { sessionId: session, paneId: h.pane, viewing: true },
    ]);
    running.dispose();
  });

  it('publishes nothing for a pane no session is bound to', () => {
    const h = harness();
    const running = publisher(h);
    // The edge count is the negative control: "nothing published" is only worth
    // asserting once we know an edge was there to publish.
    const edges: boolean[] = [];
    h.viewing.onDidChangeViewing((_pane, viewing) => void edges.push(viewing));

    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });

    expect(edges).toEqual([false]);
    expect(h.seen).toEqual([]);
    running.dispose();
  });

  it('stops publishing once disposed', () => {
    const h = harness();
    h.layout.bindSession(h.pane, sessionId('sess-1'));
    const running = publisher(h);
    running.dispose();
    const edges: boolean[] = [];
    h.viewing.onDidChangeViewing((_pane, viewing) => void edges.push(viewing));

    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });

    expect(edges).toEqual([false]);
    expect(h.seen).toEqual([]);
  });

  it('announces a pane whose session binds while it is already being viewed', () => {
    // The gap this closes: a new pane is focused by the split that created it,
    // so the resolver's `true` edge fires BEFORE any session exists and is
    // correctly dropped. `bindSession` announces nothing of its own, so without
    // this call that session's mirror never gets a first value at all — and a
    // `Stop` under the user's eyes would then land `needsCheck`.
    const h = harness();
    const running = publisher(h);
    const session = sessionId('sess-1');

    h.layout.bindSession(h.pane, session);
    running.announce(h.pane);

    expect(h.seen).toEqual([{ sessionId: session, paneId: h.pane, viewing: true }]);
    running.dispose();
  });

  it('announces a definite false for a pane nobody is looking at', () => {
    // A seed of `false` is not the same as no seed: a subscriber can tell "not
    // viewed" from "never heard of", and only one of the two is an answer.
    const h = harness(false);
    const running = publisher(h);
    h.layout.bindSession(h.pane, sessionId('sess-1'));
    running.announce(h.pane);

    expect(h.seen).toEqual([{ sessionId: 'sess-1', paneId: h.pane, viewing: false }]);
    running.dispose();
  });

  it('keeps FIFO with hook events, which is what makes the mirror safe', () => {
    // A viewing edge and a hook event share one bus and one port. Could they
    // reorder, a `Stop` would be reduced against a stale `viewing` and land the
    // wrong state — so the ordering is an invariant, not a coincidence.
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);
    const running = publisher(h);

    const order: string[] = [];
    h.bus.on('*', (_payload, envelope) => void order.push(envelope.source.kind));
    h.bus.emit('claude.hook', { event: 'Stop' }, { kind: 'agent', sessionId: session });
    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });
    h.bus.emit('claude.hook', { event: 'UserPromptSubmit' }, { kind: 'agent', sessionId: session });

    expect(order).toEqual(['agent', 'kernel', 'agent']);
    running.dispose();
  });
});
