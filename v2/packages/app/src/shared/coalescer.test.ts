import { describe, expect, it } from 'vitest';
import { manualClock } from '@shepherd/sdk';
import { COALESCE } from './channels.ts';
import { OutputCoalescer } from './coalescer.ts';

describe('OutputCoalescer', () => {
  it('does not send a small chunk until the interval elapses', () => {
    const clock = manualClock();
    const sends: Uint8Array[] = [];
    const c = new OutputCoalescer({ clock, flush: (b) => sends.push(b) });

    c.push(new Uint8Array([1, 2, 3]));
    // The whole point: a send per onData is what this replaces.
    expect(sends).toHaveLength(0);

    clock.advance(COALESCE.intervalMs - 1);
    expect(sends).toHaveLength(0);

    clock.advance(1);
    expect(sends).toHaveLength(1);
    expect([...sends[0]!]).toEqual([1, 2, 3]);
  });

  it('coalesces many small chunks arriving inside one interval into one send', () => {
    const clock = manualClock();
    const sends: Uint8Array[] = [];
    const c = new OutputCoalescer({ clock, flush: (b) => sends.push(b) });

    for (let i = 0; i < 500; i += 1) c.push(new Uint8Array([i & 0xff]));
    expect(sends).toHaveLength(0);

    clock.advance(COALESCE.intervalMs);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.length).toBe(500);
  });

  it('flushes on the size budget without waiting for the timer', () => {
    const clock = manualClock();
    const sends: Uint8Array[] = [];
    const c = new OutputCoalescer({ clock, flush: (b) => sends.push(b) });

    c.push(new Uint8Array(COALESCE.maxBytes));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.length).toBe(COALESCE.maxBytes);
    expect(c.pendingBytes).toBe(0);
  });

  it('sends Uint8Array payloads, never strings', () => {
    const clock = manualClock();
    const sends: unknown[] = [];
    const c = new OutputCoalescer({ clock, flush: (b) => sends.push(b) });
    c.push(new TextEncoder().encode('hello'));
    clock.advance(COALESCE.intervalMs);
    expect(sends[0]).toBeInstanceOf(Uint8Array);
    expect(typeof sends[0]).not.toBe('string');
  });

  it('dispose flushes the tail rather than dropping it', () => {
    const clock = manualClock();
    const sends: Uint8Array[] = [];
    const c = new OutputCoalescer({ clock, flush: (b) => sends.push(b) });
    c.push(new Uint8Array([9]));
    c.dispose();
    expect(sends).toHaveLength(1);

    // …and accepts nothing afterwards.
    c.push(new Uint8Array([8]));
    clock.advance(1000);
    expect(sends).toHaveLength(1);
  });
});
