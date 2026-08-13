import { describe, expect, it } from 'vitest';
import { SHIPPED_CAP, activeOrder, capShipped, shippedOrder } from './order.ts';

/** A record with only the fields the ordering reads. */
const task = (
  id: string,
  fields: { createdAt: number; activatedAt?: number; archivedAt?: number },
): { id: string } & typeof fields => ({ id, ...fields });

const ids = (tasks: readonly { id: string }[]): readonly string[] => tasks.map((entry) => entry.id);

describe('activeOrder', () => {
  it('puts the oldest first, so a new task is appended below what is already there', () => {
    const rows = activeOrder([
      task('new', { createdAt: 300 }),
      task('old', { createdAt: 100 }),
      task('mid', { createdAt: 200 }),
    ]);
    expect(ids(rows)).toEqual(['old', 'mid', 'new']);
  });

  it('sorts an un-shipped task by when it came back, not by when it was created', () => {
    /*
     * The whole reason `activatedAt` exists: un-shipping three-week-old work
     * must put it at the BOTTOM of the list, not above everything current.
     */
    const rows = activeOrder([
      task('recent', { createdAt: 200 }),
      task('ancient-but-unshipped', { createdAt: 1, activatedAt: 500 }),
    ]);
    expect(ids(rows)).toEqual(['recent', 'ancient-but-unshipped']);
  });

  it('falls back to createdAt for every record written before activatedAt existed', () => {
    const rows = activeOrder([task('b', { createdAt: 200 }), task('a', { createdAt: 100 })]);
    expect(ids(rows)).toEqual(['a', 'b']);
  });

  it('keeps the input order for a tie', () => {
    /*
     * An unstable sort would let two same-instant tasks swap places on an
     * unrelated refresh — which is exactly the "rows never move" promise the
     * append order is here to make.
     */
    const rows = activeOrder([
      task('first', { createdAt: 100 }),
      task('second', { createdAt: 100 }),
      task('third', { createdAt: 100 }),
    ]);
    expect(ids(rows)).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate what it was given', () => {
    const input = [task('b', { createdAt: 200 }), task('a', { createdAt: 100 })];
    activeOrder(input);
    expect(ids(input)).toEqual(['b', 'a']);
  });
});

describe('shippedOrder', () => {
  it('puts the most recently shipped first', () => {
    const rows = shippedOrder([
      task('older', { createdAt: 1, archivedAt: 100 }),
      task('newest', { createdAt: 1, archivedAt: 300 }),
      task('middle', { createdAt: 1, archivedAt: 200 }),
    ]);
    expect(ids(rows)).toEqual(['newest', 'middle', 'older']);
  });

  it('falls back to createdAt for a record written before archivedAt existed', () => {
    /*
     * The removed expiry sweep deliberately refused this same fallback, and the
     * two were never inconsistent: dating a SHELVING to when the work started
     * would have deleted the oldest snapshots first, where here the worst case
     * is one row in the wrong place.
     */
    const rows = shippedOrder([task('no-stamp', { createdAt: 500 }), task('stamped', { createdAt: 1, archivedAt: 100 })]);
    expect(ids(rows)).toEqual(['no-stamp', 'stamped']);
  });

  it('keeps the input order for a tie', () => {
    const rows = shippedOrder([
      task('first', { createdAt: 1, archivedAt: 100 }),
      task('second', { createdAt: 1, archivedAt: 100 }),
    ]);
    expect(ids(rows)).toEqual(['first', 'second']);
  });
});

describe('capShipped', () => {
  const many = Array.from({ length: 20 }, (_, index) => task(`t${index}`, { createdAt: index }));

  it('draws every row and hides nothing when there are fewer than the cap', () => {
    const few = many.slice(0, 3);
    expect(capShipped(few, SHIPPED_CAP, false)).toEqual({ shown: few, hidden: 0 });
  });

  it('draws exactly the cap and reports the remainder', () => {
    const { shown, hidden } = capShipped(many, 8, false);
    expect(shown).toHaveLength(8);
    expect(ids(shown)).toEqual(ids(many.slice(0, 8)));
    expect(hidden).toBe(12);
  });

  it('draws everything when asked for all of it', () => {
    expect(capShipped(many, 8, true)).toEqual({ shown: many, hidden: 0 });
  });

  it('hides nothing at exactly the cap, so no Show all row is drawn for a list that is fully visible', () => {
    const exact = many.slice(0, 8);
    expect(capShipped(exact, 8, false)).toEqual({ shown: exact, hidden: 0 });
  });

  it('handles an empty list', () => {
    expect(capShipped([], 8, false)).toEqual({ shown: [], hidden: 0 });
  });
});
