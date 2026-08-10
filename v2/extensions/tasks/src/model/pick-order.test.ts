import { describe, expect, it } from 'vitest';
import { orderSuggestions, rankScored, type Orderable } from './pick-order.ts';

const row = (display: string, isRepo = true): Orderable => ({ path: `/Users/e${display.slice(1)}`, display, isRepo });

const paths = (rows: readonly Orderable[]): readonly string[] => rows.map((r) => r.display);

describe('rankScored', () => {
  it('breaks a tie toward the repo, then the shorter path', () => {
    // The shipped defect, exactly: `shep` matches the same characters in the same
    // places in both, so the scores are equal and the winner was whichever the
    // history stored first — which was the `.claude` inside it.
    const repo = row('~/dev/shepherd');
    const inside = row('~/dev/shepherd/.claude', false);
    expect(
      paths(rankScored([{ row: inside, score: 40 }, { row: repo, score: 40 }])),
    ).toEqual(['~/dev/shepherd', '~/dev/shepherd/.claude']);
  });

  it('still puts a better score first, tie-breaks or not', () => {
    const near = row('~/dev/shepherd');
    const far = row('~/other/s-h-e-p');
    expect(paths(rankScored([{ row: far, score: 10 }, { row: near, score: 90 }]))).toEqual([
      '~/dev/shepherd',
      '~/other/s-h-e-p',
    ]);
  });

  it('does not mutate what it was handed', () => {
    const rows = [{ row: row('~/b'), score: 1 }, { row: row('~/a'), score: 9 }];
    rankScored(rows);
    expect(rows[0]?.row.display).toBe('~/b');
  });
});

describe('orderSuggestions', () => {
  const disk = [row('~/dev/shepherd'), row('~/dev/shepherd-ios')];
  const seen = [row('~/dev/shepherd/.claude', false), row('~/old/api')];

  it('puts the disk before history', () => {
    // A filesystem row exists because you named its parent; a history hit could
    // have come from anywhere. The other way round, `.claude` — in history only
    // because this picker's own bug put it there — was drawn as the answer.
    expect(paths(orderSuggestions(disk, seen, null, 10))[0]).toBe('~/dev/shepherd');
  });

  it('lets the exact repo win outright, from either list', () => {
    const exact = seen[1]!;
    expect(paths(orderSuggestions(disk, seen, exact.path, 10))[0]).toBe('~/old/api');
  });

  it('ignores an exact path that is in neither list rather than inventing a row', () => {
    expect(paths(orderSuggestions(disk, seen, '/nowhere', 10))[0]).toBe('~/dev/shepherd');
  });

  it('offers a path once, however many lists carry it', () => {
    const shared = row('~/dev/shepherd');
    const ordered = paths(orderSuggestions(disk, [shared, ...seen], null, 10));
    expect(ordered.filter((p) => p === '~/dev/shepherd')).toHaveLength(1);
  });

  it('caps the answer — it is a field, not a scroll', () => {
    expect(orderSuggestions(disk, seen, null, 2)).toHaveLength(2);
  });
});
