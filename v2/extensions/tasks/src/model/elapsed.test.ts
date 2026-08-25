import { describe, expect, it } from 'vitest';
import { formatElapsed } from './elapsed.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the elapsed stamp', () => {
  it('says NOTHING for the first minute', () => {
    /*
     * `0s` spends a column to report that no time has passed — the one thing the
     * mark beside it already implies — and flickers through the span where you
     * are least likely to be the bottleneck. The number is a triage tiebreaker
     * between tasks that have been sitting a while.
     *
     * It also keeps the granularity honest: the rail nudges itself once a
     * minute, so a seconds-precision number would be a stale one.
     */
    expect(formatElapsed(0)).toBeUndefined();
    expect(formatElapsed(40 * SECOND)).toBeUndefined();
    expect(formatElapsed(59 * SECOND + 999)).toBeUndefined();
  });

  it('steps up one unit at a time, and only ever shows one', () => {
    // `1h 14m` is a duration you read; this is one you glance at, and the second
    // unit refines a number nobody acts on.
    expect(formatElapsed(MINUTE)).toBe('1m');
    expect(formatElapsed(14 * MINUTE)).toBe('14m');
    expect(formatElapsed(HOUR)).toBe('1h');
    expect(formatElapsed(HOUR + 14 * MINUTE)).toBe('1h');
    expect(formatElapsed(23 * HOUR)).toBe('23h');
    expect(formatElapsed(DAY)).toBe('1d');
    expect(formatElapsed(9 * DAY)).toBe('9d');
  });

  it('FLOORS rather than rounds, so it never exaggerates a wait', () => {
    /*
     * The honest direction to be wrong. This number exists to make a long wait
     * itch, so a stamp that rounded up would manufacture the very feeling it is
     * meant to report.
     */
    expect(formatElapsed(2 * MINUTE + 59 * SECOND)).toBe('2m');
    expect(formatElapsed(59 * SECOND)).toBeUndefined();
    expect(formatElapsed(HOUR + 59 * MINUTE)).toBe('1h');
    expect(formatElapsed(DAY + 23 * HOUR)).toBe('1d');
  });

  it('draws nothing for a duration that cannot be true', () => {
    // The clock moved backwards under us. There is no honest rendering of that.
    expect(formatElapsed(-1)).toBeUndefined();
    expect(formatElapsed(Number.NaN)).toBeUndefined();
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
