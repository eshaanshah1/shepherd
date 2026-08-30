import { describe, expect, it } from 'vitest';
import { EventBus, ViewerRegistry, ViewingResolver } from '@shepherd/core';
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
import { VIEWING_TOPIC, publishViewingEdges, type ViewingChanged } from './viewing-topic.ts';

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
  readonly viewers: ViewerRegistry;
  /** Payloads seen on `session.viewing`, in arrival order. */
  readonly seen: ViewingChanged[];
  readonly pane: PaneID;
}

function harness(appActive = true): Harness {
  const layout = new LayoutStore({
    logger: nullLogger,
    clock: systemClock,
    sessions: { release: () => undefined, isLive: () => true },
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
  return { layout, viewing, bus, viewers: new ViewerRegistry(), seen, pane: pane as PaneID };
}

function publisher(h: Harness): ReturnType<typeof publishViewingEdges> {
  return publishViewingEdges({
    viewing: h.viewing,
    layout: h.layout,
    bus: h.bus,
    logger: nullLogger,
    viewers: h.viewers,
    principal: 'app',
  });
}

describe('publishViewingEdges', () => {
  it('publishes one event per edge for a bound pane', () => {
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);
    const running = publisher(h);

    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });
    h.viewing.setPresence({ appActive: true, focusedRoot: ROOT, overlay: false });

    expect(h.seen).toEqual([
      { sessionId: session, paneId: h.pane, viewing: false, viewers: [] },
      { sessionId: session, paneId: h.pane, viewing: true, viewers: ['app'] },
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

    expect(h.seen).toEqual([{ sessionId: session, paneId: h.pane, viewing: true, viewers: ['app'] }]);
    running.dispose();
  });

  it('announces a definite false for a pane nobody is looking at', () => {
    // A seed of `false` is not the same as no seed: a subscriber can tell "not
    // viewed" from "never heard of", and only one of the two is an answer.
    const h = harness(false);
    const running = publisher(h);
    h.layout.bindSession(h.pane, sessionId('sess-1'));
    running.announce(h.pane);

    expect(h.seen).toEqual([{ sessionId: 'sess-1', paneId: h.pane, viewing: false, viewers: [] }]);
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


describe('the closing edge', () => {
  it('publishes viewing=false for a pane whose binding the close already removed', () => {
    // `LayoutStore.close` unbinds SYNCHRONOUSLY and announces afterwards, so the
    // resolver's `(pane, false)` — the edge it fires precisely so subscribers
    // stop suppressing alerts for a pane that is gone — arrives when
    // `sessionFor` is already empty. Dropped, a subscriber holds "they are
    // looking at it" forever for a session that no longer exists.
    const h = harness();
    const live = publisher(h);

    // Split first, so closing is not "the root ran out of panes" — and take the
    // NEW pane, which the split focuses. Closing the focused, bound pane is the
    // case that matters, because it is the one being viewed.
    const split = h.layout.split(ROOT, 'row');
    if (!split.ok) throw new Error('split failed');
    const pane = split.value;

    const session = sessionId('session-1');
    h.layout.bindSession(pane, session);
    live.announce(pane);
    expect(h.seen).toContainEqual({ sessionId: session, paneId: pane, viewing: true, viewers: ['app'] });
    h.seen.length = 0;

    h.layout.close(pane);

    const closing = h.seen.filter((event) => event.sessionId === session);
    expect(closing, 'the closing edge was dropped').toHaveLength(1);
    expect(closing[0]?.viewing).toBe(false);
    live.dispose();
  });

  it('says nothing twice for the same closed pane', () => {
    // The last-known entry is consumed when it is used, so a later edge for the
    // same pane cannot resurrect a session id that is already gone.
    const h = harness();
    const live = publisher(h);
    h.layout.bindSession(h.pane, sessionId('session-1'));
    live.announce(h.pane);
    h.layout.unbindSession(sessionId('session-1'));
    h.seen.length = 0;

    live.announce(h.pane);
    live.announce(h.pane);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.viewing).toBe(false);
    live.dispose();
  });
});


describe('the viewer set', () => {
  it('keeps a session viewed while ANOTHER client is looking, after this window looks away', () => {
    // The Stage 1 promise: nothing may push for a session another client is
    // looking at. The phone reports through `sessions.viewing`, which lands in
    // the same registry.
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);
    const running = publisher(h);
    h.viewers.report('device:phone', session, true);
    h.seen.length = 0;

    h.viewing.setPresence({ appActive: false, focusedRoot: null, overlay: false });

    expect(h.seen).toEqual([
      { sessionId: session, paneId: h.pane, viewing: true, viewers: ['device:phone'] },
    ]);
    running.dispose();
  });

  it('publishes another client\'s edge even though no pane of this window changed', () => {
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);
    const running = publisher(h);
    h.seen.length = 0;

    h.viewers.report('device:phone', session, true);

    expect(h.seen).toEqual([
      { sessionId: session, paneId: h.pane, viewing: true, viewers: ['app', 'device:phone'] },
    ]);
    running.dispose();
  });

  it('seeds the registry from the resolver, so the first edge is not swallowed', () => {
    // The resolver only fires on a CHANGE, and the change it fires is away from
    // a value a publisher that started empty never heard. `PtyFanout`'s rule:
    // snapshot and register are one step.
    const h = harness();
    const session = sessionId('sess-1');
    h.layout.bindSession(h.pane, session);

    const running = publisher(h);

    expect(h.viewers.viewersOf(session)).toEqual(['app']);
    running.dispose();
  });
});
