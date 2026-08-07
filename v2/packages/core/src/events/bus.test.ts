import { describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  sessionId,
  type Caller,
  type Envelope,
  type LogRecord,
} from '@shepherd/sdk';
import { EventBus } from './bus.ts';

const TASKS: Caller = { kind: 'extension', id: extensionId('shepherd.tasks') };
const AGENT: Caller = { kind: 'agent', sessionId: sessionId('s-1') };

function build(startMs = 1_000) {
  const clock = manualClock(startMs);
  const records: LogRecord[] = [];
  const logger = createLogger({ clock, level: 'debug', sink: (_line, record) => records.push(record) });
  return { bus: new EventBus({ clock, logger }), clock, messages: () => records.map((r) => r.message) };
}

describe('emit / on', () => {
  it('delivers the payload and an envelope to exact subscribers', () => {
    const { bus, clock } = build(1_000);
    const seen: [unknown, Envelope][] = [];
    bus.on('claude.hook', (payload, envelope) => seen.push([payload, envelope]));

    clock.advance(5);
    bus.emit('claude.hook', { event: 'Stop' }, TASKS);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({ event: 'Stop' });
    expect(seen[0]?.[1]).toEqual({ seq: 1, ts: 1_005, source: TASKS });
  });

  it('does not deliver to a different topic', () => {
    const { bus } = build();
    let count = 0;
    bus.on('other.topic', () => count++);
    bus.emit('claude.hook', {}, TASKS);
    expect(count).toBe(0);
  });

  it('disposing unsubscribes', () => {
    const { bus } = build();
    let count = 0;
    const sub = bus.on('t', () => count++);
    bus.emit('t', {}, TASKS);
    sub.dispose();
    bus.emit('t', {}, TASKS);
    expect(count).toBe(1);
  });

  it('a listener unsubscribing mid-dispatch does not skip its siblings', () => {
    // Iterating the live set while a handler mutates it is how the second of
    // three subscribers silently stops receiving events.
    const { bus } = build();
    const seen: string[] = [];
    const first = bus.on('t', () => {
      seen.push('first');
      first.dispose();
    });
    bus.on('t', () => seen.push('second'));
    bus.emit('t', {}, TASKS);
    expect(seen).toEqual(['first', 'second']);
  });
});

describe('wildcards', () => {
  it('a prefix wildcard receives every topic under it', () => {
    const { bus } = build();
    const topics: string[] = [];
    bus.on('claude.*', (_p, _e) => topics.push('hit'));
    bus.emit('claude.hook', {}, TASKS);
    bus.emit('claude.session.start', {}, TASKS);
    bus.emit('tasks.created', {}, TASKS);
    expect(topics).toHaveLength(2);
  });

  it('`*` receives everything — what a debug log subscribes to', () => {
    const { bus } = build();
    let count = 0;
    bus.on('*', () => count++);
    bus.emit('a', {}, TASKS);
    bus.emit('b.c', {}, TASKS);
    expect(count).toBe(2);
  });

  it('a prefix wildcard does not match the bare prefix as a topic', () => {
    const { bus } = build();
    let count = 0;
    bus.on('claude.*', () => count++);
    bus.emit('claude', {}, TASKS);
    expect(count).toBe(0);
  });
});

describe('sequence numbers', () => {
  it('counts per source, not globally', () => {
    // Two sources emitting alternately must each see 1, 2, 3 — a global counter
    // would make every subscriber's gap check useless.
    const { bus } = build();
    const seqs: [string, number][] = [];
    bus.on('*', (_p, e) => seqs.push([e.source.kind, e.seq]));

    bus.emit('t', {}, TASKS);
    bus.emit('t', {}, AGENT);
    bus.emit('t', {}, TASKS);

    expect(seqs).toEqual([
      ['extension', 1],
      ['agent', 1],
      ['extension', 2],
    ]);
  });

  it('distinguishes two agents by their session id', () => {
    const { bus } = build();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));
    bus.emit('t', {}, { kind: 'agent', sessionId: sessionId('a') });
    bus.emit('t', {}, { kind: 'agent', sessionId: sessionId('b') });
    expect(seqs).toEqual([1, 1]);
  });
});

describe('a source that numbers its own events', () => {
  it('keeps the supplied seq rather than renumbering it', () => {
    // A hook process assigns its own per-session seq. Renumbering here would
    // discard exactly the ordering evidence the number exists to carry.
    const { bus } = build();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));
    bus.emit('claude.hook', {}, AGENT, 7);
    expect(seqs).toEqual([7]);
  });

  it('DELIVERS an out-of-order gap and logs it', () => {
    // The v1 failure this whole mechanism exists for: a `PreToolUse` arriving
    // after the `PermissionRequest` it precedes overwrote `blocked` with
    // `working`, silently, with no way to detect it had happened. Refusing the
    // event would turn one lost message into two — so it is delivered, loudly.
    const { bus, messages } = build();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));

    bus.emit('claude.hook', {}, AGENT, 1);
    bus.emit('claude.hook', {}, AGENT, 4);

    expect(seqs).toEqual([1, 4]);
    expect(messages().some((m) => /gap/i.test(m) && m.includes('agent:s-1'))).toBe(true);
  });

  it('DROPS a duplicate and logs it', () => {
    // A retry, not a race. Delivering it twice would double-apply a transition.
    const { bus, messages } = build();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));

    bus.emit('claude.hook', {}, AGENT, 3);
    bus.emit('claude.hook', {}, AGENT, 3);
    bus.emit('claude.hook', {}, AGENT, 2);

    expect(seqs).toEqual([3]);
    expect(messages().filter((m) => /duplicate/i.test(m))).toHaveLength(2);
  });

  it('tracks supplied sequences per source too', () => {
    const { bus } = build();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));
    bus.emit('t', {}, { kind: 'agent', sessionId: sessionId('a') }, 5);
    bus.emit('t', {}, { kind: 'agent', sessionId: sessionId('b') }, 1);
    expect(seqs).toEqual([5, 1]);
  });
});

describe('a bad listener', () => {
  it('cannot stop the others, and says who it was', () => {
    const { bus, messages } = build();
    const seen: string[] = [];
    bus.on('t', () => {
      throw new Error('listener exploded');
    });
    bus.on('t', () => seen.push('survivor'));

    expect(() => bus.emit('t', {}, TASKS)).not.toThrow();
    expect(seen).toEqual(['survivor']);
    expect(messages().some((m) => m.includes('listener exploded'))).toBe(true);
  });
});
