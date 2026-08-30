import { describe, expect, it } from 'vitest';
import { KERNEL } from '@shepherd/sdk';
import { MAX_NUDGE_KEYS, SubscriptionState } from './subscription.ts';

const ENVELOPE = { topic: 't', seq: 1, ts: 0, source: KERNEL };

describe('snapshot-then-delta', () => {
  it('opens with the snapshot frame for a stateful topic', () => {
    // `PtyFanout`'s rule on the control plane: snapshot, register and replay are
    // ONE step, so a reconnecting client never folds deltas onto nothing.
    const sub = new SubscriptionState({ topic: 'agents.indicators', delivery: 'push' });
    expect(sub.open({ has: true, value: [{ id: 'a' }] })).toEqual([
      { kind: 'snapshot', topic: 'agents.indicators', seq: 0, value: [{ id: 'a' }] },
    ]);
  });

  it('opens with NOTHING for a topic that has no state to snapshot', () => {
    // A stateless topic is an event stream. A snapshot frame carrying
    // `undefined` would make a client that folds it start from a value nobody
    // published.
    const sub = new SubscriptionState({ topic: 'claude.hook', delivery: 'push' });
    expect(sub.open({ has: false })).toEqual([]);
  });

  it('numbers the deltas after the snapshot, so a gap is visible', () => {
    const sub = new SubscriptionState({ topic: 't', delivery: 'push' });
    sub.open({ has: true, value: 0 });
    expect(sub.receive(1, ENVELOPE)).toEqual([
      { kind: 'event', topic: 't', seq: 1, payload: 1, envelope: ENVELOPE },
    ]);
    expect(sub.receive(2, ENVELOPE)[0]).toMatchObject({ seq: 2 });
  });

  it('starts deltas at 1 even when there was no snapshot', () => {
    const sub = new SubscriptionState({ topic: 't', delivery: 'push' });
    sub.open({ has: false });
    expect(sub.receive(1, ENVELOPE)[0]).toMatchObject({ seq: 1 });
  });
});

describe('pull-with-nudge back-pressure', () => {
  it('sends ONE nudge and then goes quiet until the reader pulls', () => {
    // ADR 0031's rule, on the control plane: the change signal is a nudge, the
    // reader reads when it wants, and a chatty extension cannot flood anyone.
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    sub.open({ has: false });

    expect(sub.receive('tasks.tree', ENVELOPE)).toEqual([
      { kind: 'nudge', topic: 'views.changed', seq: 1, coalesced: 0 },
    ]);
    expect(sub.receive('tasks.tree', ENVELOPE)).toEqual([]);
    expect(sub.receive('tasks.tree', ENVELOPE)).toEqual([]);
  });

  it('nudges again after a pull, carrying how many it swallowed', () => {
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    sub.open({ has: false });
    sub.receive('a', ENVELOPE);
    sub.receive('b', ENVELOPE);
    sub.receive('c', ENVELOPE);

    expect(sub.pulled()).toEqual([
      { kind: 'nudge', topic: 'views.changed', seq: 2, coalesced: 2 },
    ]);
  });

  it('says nothing on a pull that had nothing waiting', () => {
    // The steady state. A pull that always answered would turn the reader's own
    // read into the next nudge and spin.
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    sub.open({ has: false });
    sub.receive('a', ENVELOPE);
    expect(sub.pulled()).toEqual([]);
    expect(sub.pulled()).toEqual([]);
  });

  it('carries no payload — a nudge is a signal, never data', () => {
    // The half that makes it back-pressure rather than batching: nothing is
    // drawn from a snapshot the reader did not request.
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    sub.open({ has: false });
    const [frame] = sub.receive({ secret: 'a whole tree' }, ENVELOPE);
    expect(frame).not.toHaveProperty('payload');
    expect(frame).not.toHaveProperty('value');
  });

  it('still opens with a snapshot when a nudge topic has one', () => {
    // The two are orthogonal: the snapshot is how a reader starts, the nudge is
    // how it learns to read again.
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    expect(sub.open({ has: true, value: ['tasks.tree'] })).toEqual([
      { kind: 'snapshot', topic: 'views.changed', seq: 0, value: ['tasks.tree'] },
    ]);
  });

  it('a pull before anything happened is not a nudge', () => {
    const sub = new SubscriptionState({ topic: 'views.changed', delivery: 'nudge' });
    sub.open({ has: false });
    expect(sub.pulled()).toEqual([]);
  });
});

describe('push delivery', () => {
  it('never coalesces — every event is delivered', () => {
    const sub = new SubscriptionState({ topic: 't', delivery: 'push' });
    sub.open({ has: false });
    expect(sub.receive(1, ENVELOPE)).toHaveLength(1);
    expect(sub.receive(2, ENVELOPE)).toHaveLength(1);
    expect(sub.pulled()).toEqual([]);
  });
});

describe('a nudge names what changed', () => {
  const views = () =>
    new SubscriptionState({
      topic: 'views.changed',
      delivery: 'nudge',
      key: (payload) => (typeof payload === 'string' && payload !== '' ? payload : undefined),
    });

  it('names the subject of the first change', () => {
    // Without this, back-pressure on the view topic trades one flood for
    // another: every nudge fans out into a read per contributed tree, each of
    // which crosses a process boundary.
    const sub = views();
    sub.open({ has: false });
    expect(sub.receive('tasks.tree', ENVELOPE)).toEqual([
      { kind: 'nudge', topic: 'views.changed', seq: 1, coalesced: 0, keys: ['tasks.tree'] },
    ]);
  });

  it('collects the distinct subjects it swallowed, each named once', () => {
    const sub = views();
    sub.open({ has: false });
    sub.receive('tasks.tree', ENVELOPE);
    sub.receive('github.tree', ENVELOPE);
    sub.receive('github.tree', ENVELOPE);
    sub.receive('shell.tree', ENVELOPE);

    expect(sub.pulled()).toEqual([
      {
        kind: 'nudge',
        topic: 'views.changed',
        seq: 2,
        coalesced: 3,
        keys: ['github.tree', 'shell.tree'],
      },
    ]);
  });

  it('names nothing at all once one change has no subject', () => {
    // A payload with no subject means the whole topic moved — main sends `''`
    // when the SET of views changes rather than one of them. Naming the others
    // would tell the reader to re-read a strict subset of what changed.
    const sub = views();
    sub.open({ has: false });
    sub.receive('tasks.tree', ENVELOPE);
    sub.receive('github.tree', ENVELOPE);
    sub.receive('', ENVELOPE);

    expect(sub.pulled()[0]).not.toHaveProperty('keys');
  });

  it('gives up naming past the cap rather than handing over a work queue', () => {
    const sub = views();
    sub.open({ has: false });
    sub.receive('first', ENVELOPE);
    for (let i = 0; i < MAX_NUDGE_KEYS + 5; i++) sub.receive(`view-${i}`, ENVELOPE);
    expect(sub.pulled()[0]).not.toHaveProperty('keys');
  });

  it('forgets the subjects it already reported', () => {
    const sub = views();
    sub.open({ has: false });
    sub.receive('a', ENVELOPE);
    sub.receive('b', ENVELOPE);
    sub.pulled();
    sub.receive('c', ENVELOPE);
    expect(sub.pulled()[0]).toMatchObject({ keys: ['c'] });
  });

  it('names nothing when the topic declares no subjects', () => {
    const sub = new SubscriptionState({ topic: 'plain', delivery: 'nudge' });
    sub.open({ has: false });
    expect(sub.receive('anything', ENVELOPE)[0]).not.toHaveProperty('keys');
  });
});
