import { describe, expect, it } from 'vitest';
import { HISTORY_HALF_LIFE_MS, HISTORY_LIMIT, historyScore, rankHistory, recordUse } from './repo-history.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const use = (path: string, uses: number, daysAgo: number) => ({
  path,
  uses,
  lastUsedAt: NOW - daysAgo * DAY,
});

const order = (uses: readonly { path: string }[]): readonly string[] => uses.map((entry) => entry.path);

describe('historyScore', () => {
  /**
   * MUTATION TARGET (the frequency half). Drop `uses` from the formula — score
   * the decay alone — and this fails: two repos last touched at the same moment
   * become indistinguishable.
   */
  it('ranks the repo picked more often above the one picked once, at equal recency', () => {
    expect(historyScore(use('/a', 9, 3), NOW)).toBeGreaterThan(historyScore(use('/b', 1, 3), NOW));
  });

  /**
   * MUTATION TARGET (the recency half). Drop the decay — score the count alone —
   * and this fails: a repo abandoned a year ago keeps its place forever.
   */
  it('ranks the repo picked more recently above the stale one, at equal frequency', () => {
    expect(historyScore(use('/a', 3, 1), NOW)).toBeGreaterThan(historyScore(use('/b', 3, 60), NOW));
  });

  /**
   * MUTATION TARGET (the half-life). This is the number the formula's comment
   * argues for, and it is the one with a choice in it. Shorten it to a day and
   * the habit collapses (`2 × 0.5^7 = 0.03`) while the visit barely moves
   * (`1 × 0.5^1 = 0.5`), so the visit wins and this fails.
   */
  it('a habit outlasts a visit: twice last week beats once yesterday', () => {
    expect(historyScore(use('/habit', 2, 7), NOW)).toBeGreaterThan(historyScore(use('/visit', 1, 1), NOW));
  });

  it('halves the score over one half-life', () => {
    const fresh = historyScore({ path: '/a', uses: 4, lastUsedAt: NOW }, NOW);
    const aged = historyScore({ path: '/a', uses: 4, lastUsedAt: NOW - HISTORY_HALF_LIFE_MS }, NOW);
    expect(aged).toBeCloseTo(fresh / 2, 10);
  });

  it('does not let a clock set backwards score above everything', () => {
    // A record stamped in the future would otherwise decay UPWARD.
    const future = historyScore({ path: '/a', uses: 1, lastUsedAt: NOW + 30 * DAY }, NOW);
    expect(future).toBe(1);
  });
});

describe('rankHistory', () => {
  it('puts the best first', () => {
    const ranked = rankHistory([use('/stale', 3, 90), use('/hot', 3, 1), use('/mid', 3, 14)], NOW);
    expect(order(ranked)).toEqual(['/hot', '/mid', '/stale']);
  });

  it('breaks a tie on the path, so two calls agree', () => {
    const ranked = rankHistory([use('/z', 1, 1), use('/a', 1, 1)], NOW);
    expect(order(ranked)).toEqual(['/a', '/z']);
  });
});

describe('recordUse', () => {
  it('counts a repo the first time it is picked', () => {
    expect(recordUse([], '/repos/api', NOW)).toEqual([{ path: '/repos/api', uses: 1, lastUsedAt: NOW }]);
  });

  it('increments the count and restamps the time, never duplicating the path', () => {
    const once = recordUse([], '/repos/api', NOW - 5 * DAY);
    const twice = recordUse(once, '/repos/api', NOW);
    expect(twice).toEqual([{ path: '/repos/api', uses: 2, lastUsedAt: NOW }]);
  });

  it('returns the list already ranked, so nothing has to re-rank on read', () => {
    const seeded = [use('/old', 1, 60)];
    expect(order(recordUse(seeded, '/new', NOW))).toEqual(['/new', '/old']);
  });

  it('caps the list at write time, dropping the worst', () => {
    // The mirror is resident for the life of the app, so the tail is trimmed
    // where it is written rather than where it is read.
    let history = Array.from({ length: HISTORY_LIMIT }, (_, index) => use(`/repo-${index}`, 1, index + 1));
    history = [...recordUse(history, '/repos/newest', NOW)];
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(order(history)[0]).toBe('/repos/newest');
    expect(order(history)).not.toContain(`/repo-${HISTORY_LIMIT - 1}`);
  });
});
