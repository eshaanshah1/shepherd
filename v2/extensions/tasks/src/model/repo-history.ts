/**
 * Which repos you actually pick, and how a picker should order them.
 *
 * The old built-in suggestion provider answered with the repos of the most
 * recent TASKS, which is a proxy for the question and a bad one: a repo you
 * added to nine tasks and a repo you added to one look identical, and a task
 * archived months ago keeps voting. This is the fact itself — one row per repo
 * path, a count and a timestamp, written when the user picks it.
 *
 * **The formula: `uses × 0.5 ^ (age / HALF_LIFE)`.**
 *
 * Frequency times a decaying recency, which is Firefox's frecency reduced to the
 * two terms that matter here. Each half of it earns its place:
 *
 *   - **Frequency alone** ranks a repo you worked in every day last year above
 *     the one you have been in all week, forever. A picker that does that is a
 *     picker you stop reading.
 *   - **Recency alone** is a most-recently-used list, which loses the whole
 *     point: the repo you touch every day drops below whatever you glanced at an
 *     hour ago.
 *
 * The **half-life is fourteen days**, and it is the one number with a choice in
 * it. It says a habit outlives a visit by about a fortnight: two picks a week ago
 * (`2 × 0.5^0.5 = 1.41`) still beat one pick yesterday (`1 × 0.5^0.07 = 0.95`),
 * and one pick a month ago (`0.27`) has effectively left the list. A day would
 * make this an MRU with extra steps; a year would make it a lifetime counter.
 *
 * Pure and clock-injected — `now` is a parameter, because nothing an extension
 * writes may call `Date.now()`.
 */

export interface RepoUse {
  /** Absolute, home already expanded — the path a task was actually given. */
  readonly path: string;
  readonly uses: number;
  readonly lastUsedAt: number;
}

/** Fourteen days. See the formula's argument above. */
export const HISTORY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How many rows the history keeps.
 *
 * `ctx.storage` is a write-through mirror the host ships across the port at
 * activation and keeps resident (see `store.ts`), so this value is carried in
 * memory for the life of the app. Fifty paths is a few kilobytes and is already
 * more repos than anyone has; past that the tail scores near zero anyway, so
 * keeping it would be paying rent on rows no ranking will ever surface.
 */
export const HISTORY_LIMIT = 50;

/** Frequency × recency. One number, so two candidates can always be compared. */
export function historyScore(use: RepoUse, now: number): number {
  // Clamped, because a record written by a clock that has since been set back
  // would otherwise score ABOVE everything by decaying upward.
  const age = Math.max(now - use.lastUsedAt, 0);
  return use.uses * 0.5 ** (age / HISTORY_HALF_LIFE_MS);
}

/**
 * Best first. Ties break on the path so the order is stable across calls — a
 * list that reshuffles between two keystrokes is a list you cannot aim at.
 */
export function rankHistory(uses: readonly RepoUse[], now: number): readonly RepoUse[] {
  return [...uses].sort(
    (a, b) => historyScore(b, now) - historyScore(a, now) || a.path.localeCompare(b.path),
  );
}

/**
 * The user picked this repo — count it.
 *
 * Returns a new list, ranked and capped, so the stored order is already the
 * order a picker wants and nothing has to re-rank on read. Trimming the tail at
 * WRITE time is what keeps the resident mirror bounded.
 */
export function recordUse(uses: readonly RepoUse[], path: string, now: number): readonly RepoUse[] {
  const existing = uses.find((use) => use.path === path);
  const updated: RepoUse = {
    path,
    uses: (existing?.uses ?? 0) + 1,
    lastUsedAt: now,
  };
  const rest = uses.filter((use) => use.path !== path);
  return rankHistory([...rest, updated], now).slice(0, HISTORY_LIMIT);
}
