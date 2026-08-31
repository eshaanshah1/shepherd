import { describe, expect, it } from 'vitest';
import { hasWoken, nextMorning, parseWhen, readUntil, snoozeFor } from './snooze.ts';

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

/**
 * The fourth form: a time you name.
 *
 * The three presets are the whens worth one keypress. Everything here is a when
 * that had to be rounded to whichever preset was least wrong, which is how a row
 * came back at a moment nobody chose.
 */
describe('parseWhen', () => {
  const at = (text: string, now = WED_14): Date | undefined => {
    const ms = parseWhen(text, now);
    return ms === undefined ? undefined : new Date(ms);
  };

  it('reads a duration from now, the one form that does not care what day it is', () => {
    expect(parseWhen('2h', WED_14)).toBe(WED_14 + 2 * 3_600_000);
    expect(parseWhen('45m', WED_14)).toBe(WED_14 + 45 * 60_000);
    expect(parseWhen('3d', WED_14)).toBe(WED_14 + 3 * 86_400_000);
    // The long spellings, because people type them.
    expect(parseWhen('2 hours', WED_14)).toBe(parseWhen('2h', WED_14));
    expect(parseWhen('45 mins', WED_14)).toBe(parseWhen('45m', WED_14));
  });

  it('rolls a clock time forward only once it has gone', () => {
    // 14:00 on the Wednesday: 4pm is still ahead, 9am is not.
    expect(at('4pm')?.getDate()).toBe(26);
    expect(at('4pm')?.getHours()).toBe(16);
    expect(at('9am')?.getDate()).toBe(27);
    expect(at('16:30')?.getMinutes()).toBe(30);
  });

  it('gets noon and midnight right, which is the pair a modulo gets wrong', () => {
    expect(at('12pm', WED_14)?.getHours()).toBe(12);
    expect(at('12am', WED_14)?.getHours()).toBe(0);
  });

  it('reads the NEXT weekday, so naming today means a week and not a moment gone', () => {
    // Wednesday. `friday` is two days out; `wednesday` is seven, never zero.
    expect(at('friday')?.getDate()).toBe(28);
    expect(at('fri')?.getDate()).toBe(28);
    expect(at('wednesday')?.getDate()).toBe(2);
    // At the working morning hour, unless a time comes with it.
    expect(at('friday')?.getHours()).toBe(9);
    expect(at('friday 2pm')?.getHours()).toBe(14);
  });

  it('refuses rather than guessing, because a wrong day still leaves Home', () => {
    /*
     * Both outcomes take the row off the screen and only one of them says it did
     * the wrong thing. So an unreadable half refuses the whole phrase — `friday
     * afternon` must not quietly become Friday at 09:00.
     */
    for (const bad of ['', 'soon', 'next tuesdya', 'friday afternon', '25:00', '13pm', '4:99', '0h']) {
      expect(parseWhen(bad, WED_14), bad).toBeUndefined();
    }
  });
});

describe('readUntil', () => {
  it('lets a preset word through as itself, so one verb serves both callers', () => {
    expect(readUntil('today', WED_14)).toBe('today');
    expect(readUntil('quiet', WED_14)).toBe('quiet');
  });

  it('keeps `tomorrow` the PRESET, which is the next WORKING morning', () => {
    // Typed on the Friday, the preset says Monday and a bare date parse would
    // say Saturday. The preset is the one that means what people mean.
    expect(readUntil('tomorrow', FRI_18)).toBe('tomorrow');
    expect(snoozeFor(readUntil('tomorrow', FRI_18) ?? 'today', FRI_18).wakeAt).toBe(nextMorning(FRI_18));
  });

  it('turns anything else into the moment it names, or nothing', () => {
    expect(readUntil('2h', WED_14)).toEqual({ at: WED_14 + 2 * 3_600_000 });
    expect(readUntil('not a time', WED_14)).toBeUndefined();
  });
});

describe('the label a named time wears', () => {
  it('drops the day when the wake is today, because the clock is unambiguous', () => {
    expect(snoozeFor({ at: new Date('2026-08-26T16:00:00').getTime() }, WED_14).label).toBe('16:00');
  });

  it('adds the day when it is not, because `16:00` on Friday is a riddle', () => {
    expect(snoozeFor({ at: new Date('2026-08-27T09:00:00').getTime() }, WED_14).label).toBe('tomorrow 09:00');
    expect(snoozeFor({ at: new Date('2026-08-28T14:00:00').getTime() }, WED_14).label).toBe('Friday 14:00');
  });

  it('takes a date past a week, since a weekday nine days out names the wrong one', () => {
    expect(snoozeFor({ at: new Date('2026-09-04T09:00:00').getTime() }, WED_14).label).toBe('4 Sep 09:00');
  });

  it('wakes on the moment it was given, with no rounding of its own', () => {
    const moment = new Date('2026-08-28T14:00:00').getTime();
    const snooze = snoozeFor({ at: moment }, WED_14);
    expect(snooze.wakeAt).toBe(moment);
    expect(hasWoken(snooze, moment - 1, false)).toBe(false);
    expect(hasWoken(snooze, moment, false)).toBe(true);
  });
});
