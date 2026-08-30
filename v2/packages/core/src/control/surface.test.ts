import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, manualClock, s, type Caller, type Logger } from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants } from '../commands/authorize.ts';
import { EventBus } from '../events/bus.ts';
import { ControlSurface } from './surface.ts';
import { TopicRegistry } from './topics.ts';
import type { ControlFrame } from './subscription.ts';

const USER: Caller = { kind: 'user' };
const KERNEL: Caller = { kind: 'kernel' };

let logger: Logger;
let registry: CommandRegistry;
let bus: EventBus;
let topics: TopicRegistry;
let surface: ControlSurface;

beforeEach(() => {
  const clock = manualClock(0);
  logger = createLogger({ clock, level: 'debug', sink: () => {} });
  registry = new CommandRegistry({ logger, grants: () => emptyGrants() });
  bus = new EventBus({ clock, logger });
  topics = new TopicRegistry();
  surface = new ControlSurface({ commands: registry, bus, logger, topics });
});

describe('invoke', () => {
  it('is a pass-through to the one verb table — the surface owns no verbs', () => {
    registry.register('demo.echo', { schema: s.object({ x: s.int() }), handler: (a) => a.x * 2 });
    return expect(surface.invoke('demo.echo', { x: 21 }, USER)).resolves.toEqual({ ok: true, value: 42 });
  });

  it('reports a failure as a value, exactly as the registry does', async () => {
    const answer = await surface.invoke('nope', {}, USER);
    expect(answer).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
  });
});

describe('subscribe: snapshot then delta', () => {
  it('hands a stateful topic\'s current value first, then the changes', () => {
    let current = ['a'];
    topics.declare({ topic: 'demo.list', delivery: 'push', snapshot: () => current });
    const seen: ControlFrame[] = [];

    const subscription = surface.subscribe('demo.list', (frame) => seen.push(frame));
    current = ['a', 'b'];
    bus.emit('demo.list', { added: 'b' }, KERNEL);

    expect(seen[0]).toEqual({ kind: 'snapshot', topic: 'demo.list', seq: 0, value: ['a'] });
    expect(seen[1]).toMatchObject({ kind: 'event', seq: 1, payload: { added: 'b' } });
    subscription.dispose();
  });

  it('takes the snapshot and registers in ONE step, so nothing lands in the gap', () => {
    // The invariant `PtyFanout` states on the data plane. A client that read and
    // then subscribed would miss an event; one that subscribed and then read
    // would apply it twice. It cannot be tested by racing, so it is tested by
    // emitting from inside the snapshot provider — the only moment a gap could
    // exist if there were one.
    const delivered: ControlFrame[] = [];
    topics.declare({
      topic: 'demo.list',
      delivery: 'push',
      snapshot: () => {
        bus.emit('demo.list', 'during-the-snapshot', KERNEL);
        return 'the snapshot';
      },
    });

    const subscription = surface.subscribe('demo.list', (frame) => delivered.push(frame));

    // The event fired while the snapshot was being taken reached no listener —
    // which is correct, because the snapshot it is folded into came after it.
    expect(delivered).toEqual([
      { kind: 'snapshot', topic: 'demo.list', seq: 0, value: 'the snapshot' },
    ]);
    subscription.dispose();
  });

  it('subscribes an undeclared topic as a stateless push stream', () => {
    // `shepherd wait` follows `*`, and refusing it would break the CLI for a
    // guarantee the socket cannot give anyway.
    const seen: ControlFrame[] = [];
    const subscription = surface.subscribe('claude.hook', (frame) => seen.push(frame));
    bus.emit('claude.hook', { event: 'Stop' }, KERNEL);
    expect(seen).toEqual([
      { kind: 'event', topic: 'claude.hook', seq: 1, payload: { event: 'Stop' }, envelope: expect.anything() },
    ]);
    subscription.dispose();
  });

  it('starts a subscriber empty when the snapshot provider throws, rather than refusing', () => {
    topics.declare({
      topic: 'demo.list',
      delivery: 'push',
      snapshot: () => {
        throw new Error('provider bug');
      },
    });
    const seen: ControlFrame[] = [];
    const subscription = surface.subscribe('demo.list', (frame) => seen.push(frame));
    bus.emit('demo.list', 'later', KERNEL);
    expect(seen).toEqual([{ kind: 'event', topic: 'demo.list', seq: 1, payload: 'later', envelope: expect.anything() }]);
    subscription.dispose();
  });

  it('stops delivering once disposed', () => {
    const seen: ControlFrame[] = [];
    const subscription = surface.subscribe('demo.list', (frame) => seen.push(frame));
    subscription.dispose();
    bus.emit('demo.list', 'after', KERNEL);
    expect(seen).toEqual([]);
  });
});

describe('subscribe: pull with nudge', () => {
  it('nudges once and stays quiet until the reader pulls', () => {
    topics.declare({ topic: 'views.changed', delivery: 'nudge' });
    const seen: ControlFrame[] = [];
    const subscription = surface.subscribe('views.changed', (frame) => seen.push(frame));

    for (let i = 0; i < 50; i++) bus.emit('views.changed', 'tasks.tree', KERNEL);

    expect(seen).toEqual([{ kind: 'nudge', topic: 'views.changed', seq: 1, coalesced: 0 }]);

    subscription.pull();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ kind: 'nudge', topic: 'views.changed', seq: 2, coalesced: 49 });
    subscription.dispose();
  });

  it('a chatty topic costs one frame per read, not one per change', () => {
    // The claim in ADR 0031, measured: a tree cannot be made to re-read per row.
    topics.declare({ topic: 'views.changed', delivery: 'nudge' });
    let frames = 0;
    const subscription = surface.subscribe('views.changed', () => frames++);
    for (let i = 0; i < 1000; i++) {
      bus.emit('views.changed', 'tasks.tree', KERNEL);
      if (i % 100 === 0) subscription.pull();
    }
    expect(frames).toBeLessThanOrEqual(11);
    subscription.dispose();
  });

  it('gives each subscriber its own back-pressure', () => {
    // One slow reader must not throttle a fast one, and a fast one must not
    // clear a slow one's outstanding nudge.
    topics.declare({ topic: 'views.changed', delivery: 'nudge' });
    const fast: ControlFrame[] = [];
    const slow: ControlFrame[] = [];
    const a = surface.subscribe('views.changed', (f) => fast.push(f));
    const b = surface.subscribe('views.changed', (f) => slow.push(f));

    bus.emit('views.changed', 'x', KERNEL);
    a.pull();
    bus.emit('views.changed', 'x', KERNEL);

    expect(fast).toHaveLength(2);
    expect(slow).toHaveLength(1);
    a.dispose();
    b.dispose();
  });
});

describe('the topic list', () => {
  it('is self-describing, like the verb list', () => {
    topics.declare({ topic: 'a', delivery: 'nudge' });
    topics.declare({ topic: 'b', delivery: 'push', snapshot: () => 1 });
    expect(surface.topics.list()).toEqual([
      { topic: 'a', delivery: 'nudge', stateful: false },
      { topic: 'b', delivery: 'push', stateful: true },
    ]);
  });
});
