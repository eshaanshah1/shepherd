import { describe, expect, it } from 'vitest';
import { JUST_NOW, formatElapsed } from './elapsed.ts';

const T = 1_700_000_000_000;
const at = (ms: number): string => formatElapsed(T, T + ms);

describe('formatElapsed', () => {
  it('says `now` below a minute, because there is no useful number yet', () => {
    expect(at(0)).toBe(JUST_NOW);
    expect(at(59_999)).toBe(JUST_NOW);
  });

  it('shows ONE unit, never two', () => {
    // It sits beside a title that can be any length, in a fixed slot. `2h 14m`
    // reflows the line every minute.
    expect(at(60_000)).toBe('1m');
    expect(at(45 * 60_000)).toBe('45m');
    expect(at(2 * 3_600_000 + 14 * 60_000)).toBe('2h');
    expect(at(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d');
  });

  it('rounds DOWN, so a card never claims time that has not passed', () => {
    // "It has been an hour" when it has been 51 minutes is the small lie that
    // makes someone distrust the whole row.
    expect(at(119_000)).toBe('1m');
    expect(at(59 * 60_000 + 59_000)).toBe('59m');
    expect(at(23 * 3_600_000 + 59 * 60_000)).toBe('23h');
  });

  it('crosses each boundary exactly once', () => {
    expect(at(3_600_000 - 1)).toBe('59m');
    expect(at(3_600_000)).toBe('1h');
    expect(at(86_400_000 - 1)).toBe('23h');
    expect(at(86_400_000)).toBe('1d');
  });

  it('never renders a negative duration when the clock went backwards', () => {
    // An NTP correction, a record written on another machine, a restored
    // archive. `-3m` on a card is a bug report waiting to happen.
    expect(at(-5_000)).toBe(JUST_NOW);
    expect(at(-86_400_000)).toBe(JUST_NOW);
  });

  it('is total — a nonsense timestamp does not throw', () => {
    expect(formatElapsed(Number.NaN, T)).toBe(JUST_NOW);
    expect(formatElapsed(T, Number.NaN)).toBe(JUST_NOW);
  });

  it('stays short as it grows, so the slot does not resize', () => {
    for (const ms of [60_000, 3_600_000, 86_400_000, 400 * 86_400_000]) {
      expect(formatElapsed(T, T + ms).length).toBeLessThanOrEqual(4);
    }
  });
});
