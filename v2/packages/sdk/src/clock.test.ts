import { describe, expect, it } from 'vitest';
import { manualClock, systemClock } from './clock.ts';

describe('manualClock', () => {
  it('starts where it is told and only moves when advanced', () => {
    const clock = manualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
  });

  it('fires a timer once its deadline passes, at the deadline time', () => {
    const clock = manualClock();
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(clock.now()), 100);

    clock.advance(99);
    expect(seen).toEqual([]);

    clock.advance(1);
    expect(seen).toEqual([100]);
    expect(clock.now()).toBe(100);
  });

  it('fires timers in deadline order, not registration order', () => {
    const clock = manualClock();
    const seen: string[] = [];
    clock.setTimeout(() => seen.push('late'), 50);
    clock.setTimeout(() => seen.push('early'), 10);

    clock.advance(100);
    expect(seen).toEqual(['early', 'late']);
  });

  it('does not fire a disposed timer', () => {
    const clock = manualClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 10);
    handle.dispose();

    clock.advance(1000);
    expect(fired).toBe(false);
  });

  it('runs a timer scheduled from inside a timer within the same advance', () => {
    const clock = manualClock();
    const seen: number[] = [];
    clock.setTimeout(() => {
      seen.push(clock.now());
      clock.setTimeout(() => seen.push(clock.now()), 5);
    }, 10);

    clock.advance(20);
    expect(seen).toEqual([10, 15]);
  });
});

describe('systemClock', () => {
  it('reports a plausible wall clock', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it('cancels through dispose', async () => {
    let fired = false;
    systemClock
      .setTimeout(() => {
        fired = true;
      }, 1)
      .dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).toBe(false);
  });
});
