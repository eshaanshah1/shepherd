import { describe, expect, it } from 'vitest';
import { collapseByTitle, dayLabel, groupByDay, shippedAt } from './shipped-days.ts';
import type { Shippable } from './shipped-days.ts';

/**
 * Every instant here is built from a LOCAL `Date`, never from epoch arithmetic.
 *
 * The functions under test are deliberately local-time (a day boundary the user
 * would recognise), so a fixture written as `4 * HOUR` asserts a UTC wall clock and
 * fails on any box in another zone — and on a half-hour zone it shifts the minutes
 * too, which is how this was found.
 */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

const shipped = (title: string, when: number, id = title): Shippable => ({
  id,
  title,
  createdAt: at(2026, 1, 1),
  archivedAt: when,
});

describe('shippedAt', () => {
  it('is when it was archived', () => {
    expect(shippedAt(shipped('a', at(2026, 8, 13, 16, 40)))).toBe(at(2026, 8, 13, 16, 40));
  });

  it('falls back to createdAt for a record written before archivedAt existed', () => {
    /*
     * Safe here in a way it was not for the expiry sweep this replaced: that one fed
     * a DELETE, where dating a shelving to when the work started would have
     * destroyed the oldest snapshots first. The worst this can do is file one old
     * record under the wrong day.
     */
    const legacy: Shippable = { id: 'x', title: 'x', createdAt: at(2026, 7, 1, 9, 30) };
    expect(shippedAt(legacy)).toBe(at(2026, 7, 1, 9, 30));
  });
});

describe('dayLabel', () => {
  const now = at(2026, 8, 13, 18, 0);

  it('names today and yesterday, and dates everything older', () => {
    expect(dayLabel(at(2026, 8, 13, 9, 0), now)).toBe('Today');
    expect(dayLabel(at(2026, 8, 12, 23, 59), now)).toBe('Yesterday');
    expect(dayLabel(at(2026, 8, 11, 12, 0), now)).toBe('11 Aug');
  });

  it('reads midnight as today and one minute before it as yesterday', () => {
    // The boundary is the local calendar day, not a 24-hour window from `now` —
    // work shipped at 00:05 is today's whatever time you look.
    expect(dayLabel(at(2026, 8, 13, 0, 0), now)).toBe('Today');
    expect(dayLabel(at(2026, 8, 12, 23, 59), now)).toBe('Yesterday');
  });

  it('crosses a month boundary without arithmetic on it', () => {
    expect(dayLabel(at(2026, 7, 31, 14, 0), at(2026, 8, 1, 10, 0))).toBe('Yesterday');
    expect(dayLabel(at(2026, 7, 30, 14, 0), at(2026, 8, 1, 10, 0))).toBe('30 Jul');
  });

  it('treats work shipped later today as today rather than as the future', () => {
    /*
     * A clock that went backwards — an NTP correction, a record written on another
     * machine. The honest answer is the one that does not invent a category, and
     * there is no `Tomorrow` in this vocabulary.
     */
    expect(dayLabel(at(2026, 8, 13, 23, 0), at(2026, 8, 13, 9, 0))).toBe('Today');
  });
});

describe('collapseByTitle', () => {
  it('leaves distinct titles alone, each counting one', () => {
    const rows = collapseByTitle([shipped('a', at(2026, 8, 13, 16, 0)), shipped('b', at(2026, 8, 13, 15, 0))]);
    expect(rows.map((row) => [row.task.id, row.count])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('folds repeats into the FIRST occurrence, so nothing already drawn moves', () => {
    /*
     * Position is held by the first occurrence, which given a newest-first input
     * means the row opens the most recent of the group — and means introducing the
     * collapse can never reorder the region.
     */
    const rows = collapseByTitle([
      shipped('dup', at(2026, 8, 13, 16, 0), 'newer'),
      shipped('other', at(2026, 8, 13, 15, 0), 'other'),
      shipped('dup', at(2026, 8, 13, 9, 14), 'older'),
    ]);
    expect(rows.map((row) => [row.task.id, row.count])).toEqual([
      ['newer', 2],
      ['other', 1],
    ]);
    // …and it is the newest that survives, which given a newest-first input is
    // what "opens the most recent of them" means.
    expect(rows[0]?.task.archivedAt).toBe(at(2026, 8, 13, 16, 0));
  });

  it('counts three of a kind as three', () => {
    const rows = collapseByTitle([
      shipped('dup', at(2026, 8, 13, 16, 0), 'a'),
      shipped('dup', at(2026, 8, 13, 15, 0), 'b'),
      shipped('dup', at(2026, 8, 13, 14, 0), 'c'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it('is empty for an empty region', () => {
    expect(collapseByTitle([])).toEqual([]);
  });
});

describe('groupByDay', () => {
  const now = at(2026, 8, 13, 18, 0);

  it('labels each day once and keeps the order it was handed', () => {
    const days = groupByDay(
      [
        shipped('d', at(2026, 8, 13, 16, 40), 'd'),
        shipped('c', at(2026, 8, 13, 12, 14), 'c'),
        shipped('b', at(2026, 8, 12, 16, 48), 'b'),
        shipped('a', at(2026, 8, 10, 9, 0), 'a'),
      ],
      now,
    );
    expect(days.map((day) => [day.label, day.rows.map((row) => row.task.id)])).toEqual([
      ['Today', ['d', 'c']],
      ['Yesterday', ['b']],
      ['10 Aug', ['a']],
    ]);
  });

  it('collapses within a day and NOT across days', () => {
    /*
     * The bound that makes the collapse safe. Two identical lines an hour apart are
     * one line of the record; the same two a fortnight apart are two different
     * afternoons, and merging them destroys what the archive is for.
     */
    const days = groupByDay(
      [
        shipped('same', at(2026, 8, 13, 16, 0), 'today-a'),
        shipped('same', at(2026, 8, 13, 10, 0), 'today-b'),
        shipped('same', at(2026, 8, 12, 16, 0), 'yesterday'),
      ],
      now,
    );
    expect(days.map((day) => [day.label, day.rows.map((row) => [row.task.id, row.count])])).toEqual([
      ['Today', [['today-a', 2]]],
      ['Yesterday', [['yesterday', 1]]],
    ]);
  });

  it('opens a second bucket rather than reordering, if a day ever repeats', () => {
    /*
     * Cannot happen with a sorted input, and the point is what it does if it ever
     * does: stays faithful to the order it was given instead of pulling a row
     * backwards to make the grouping tidy. A function that silently reordered here
     * would be a function that can move a row, which is the one thing the rail's
     * ordering exists to prevent.
     */
    const days = groupByDay(
      [
        shipped('x', at(2026, 8, 13, 16, 0), 'x'),
        shipped('y', at(2026, 8, 12, 16, 0), 'y'),
        shipped('z', at(2026, 8, 13, 9, 0), 'z'),
      ],
      now,
    );
    expect(days.map((day) => [day.label, day.rows.map((row) => row.task.id)])).toEqual([
      ['Today', ['x']],
      ['Yesterday', ['y']],
      ['Today', ['z']],
    ]);
  });

  it('draws nothing for an empty region', () => {
    expect(groupByDay([], now)).toEqual([]);
  });

  it('groups a legacy record by when it was created', () => {
    const legacy: Shippable = { id: 'old', title: 'old', createdAt: at(2026, 8, 12, 11, 0) };
    expect(groupByDay([legacy], now).map((day) => day.label)).toEqual(['Yesterday']);
  });
});
