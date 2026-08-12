/**
 * How long a task has been going, as the shortest true thing.
 *
 * Shepherd UI puts this at the end of a card's title line in mono 10.5 tabular,
 * beside a name that can be any length — so it has to be NARROW and it has to be
 * a fixed number of characters as it grows, or the title reflows every minute.
 * `4m` / `2h` / `3d`, one unit, never `2h 14m`.
 *
 * **It rounds DOWN, always.** A task that started 119 seconds ago reads `1m`,
 * not `2m`. Rounding to nearest would let a card claim more elapsed time than
 * has actually passed, and "it has been an hour" when it has been 51 minutes is
 * the kind of small lie that makes someone distrust the whole row.
 *
 * Pure and total: it takes both times rather than reading a clock, so a test can
 * state the case instead of mocking one — the same shape as every other model
 * file here.
 */

/** Below this, there is no useful number to show — the task just started. */
export const JUST_NOW = 'now';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatElapsed(createdAt: number, now: number): string {
  const ms = now - createdAt;

  // A clock that went backwards — an NTP correction, a record written on another
  // machine, a restored archive. `now` is the honest answer: the alternative is
  // a negative duration, and `-3m` on a card is a bug report waiting to happen.
  if (!Number.isFinite(ms) || ms < MINUTE) return JUST_NOW;

  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}
