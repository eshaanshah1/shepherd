import { describe, expect, it } from 'vitest';
import { hasWoken, nextMorning, snoozeFor } from './snooze.ts';

/** 2026-08-26 is a Wednesday; 2026-08-28 a Friday. */
const WED_14 = new Date('2026-08-26T14:00:00').getTime();
const FRI_18 = new Date('2026-08-28T18:00:00').getTime();

describe('snoozeFor', () => {
  it('gives every option a reason in words, because "not now" needs a "then"', () => {
    for (const until of ['today', 'quiet', 'tomorrow'] as const) {
      expect(snoozeFor(until, WED_14).label.length, until).toBeGreaterThan(0);
    }
    expect(snoozeFor('today', WED_14).label).toBe('later today');
    expect(snoozeFor('quiet', WED_14).label).toBe('when agents finish');
    expect(snoozeFor('tomorrow', WED_14).label).toBe('tomorrow');
  });

  it('makes "when agents finish" a CONDITION, not a duration', () => {
    /*
     * The option worth having. The reason you defer a question is usually that
     * three other things are mid-turn, and no number of minutes names the
     * moment you actually wanted.
     */
    const quiet = snoozeFor('quiet', WED_14);
    expect(quiet.wakeOnQuiet).toBe(true);
    expect(quiet.wakeAt).toBeUndefined();
  });

  it('carries what it was, so a wake can say why it is back', () => {
    expect(snoozeFor('today', WED_14, 'Plan approval').was).toBe('Plan approval');
    expect(snoozeFor('today', WED_14).was).toBeUndefined();
  });
});

describe('tomorrow', () => {
  it('is the next MORNING, not twenty-four hours', () => {
    const at = new Date(nextMorning(WED_14));
    expect(at.getDate()).toBe(27);
    expect(at.getHours()).toBe(9);
  });

  it('is still the next morning when it is already before nine', () => {
    // Snoozing at 07:00 means tomorrow, not in two hours.
    const early = new Date('2026-08-26T07:00:00').getTime();
    expect(new Date(nextMorning(early)).getDate()).toBe(27);
  });

  it('skips the weekend, because Saturday is not a working morning', () => {
    /*
     * A task put off on Friday evening and resurfaced on Saturday is a
     * notification nobody asked for — and not being interrupted is the whole
     * verb.
     */
    const back = new Date(nextMorning(FRI_18));
    expect(back.getDay()).toBe(1);
    expect(back.getDate()).toBe(31);
  });
});

describe('hasWoken', () => {
  it('waits for the clock, then stops waiting', () => {
    const later = snoozeFor('today', WED_14);
    expect(hasWoken(later, WED_14 + 60_000, true)).toBe(false);
    expect(hasWoken(later, WED_14 + 4 * 60 * 60 * 1000, true)).toBe(true);
  });

  it('waits for the ROOM, and ignores the clock entirely', () => {
    const quiet = snoozeFor('quiet', WED_14);
    expect(hasWoken(quiet, WED_14 + 10 * 24 * 60 * 60 * 1000, true)).toBe(false);
    expect(hasWoken(quiet, WED_14, false)).toBe(true);
  });

  it('never wakes on a record that says neither', () => {
    // Reachable from a build that knew a fourth option. A snooze with no way to
    // end is better answered "not yet" than "now" — the row stays in `Later`
    // where the user can wake it by hand, rather than resurfacing forever.
    expect(hasWoken({ label: 'sometime' }, Number.MAX_SAFE_INTEGER, false)).toBe(false);
  });
});
