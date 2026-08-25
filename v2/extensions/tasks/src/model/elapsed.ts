/**
 * `40s` / `14m` / `3h` / `2d` — how long a task has been in the state it is in.
 *
 * **Formatted on the WRITER's side, and that is load-bearing rather than
 * stylistic.** The row's payload used to carry the raw duration in milliseconds
 * and let the card format it, which meant the payload was a different value on
 * every single render — `now()` moves between one and the next. The renderer
 * diffs rows to decide what to redraw, so a field that never compares equal is
 * an infinite render loop, and it was one: `Maximum update depth exceeded`,
 * thousands of times a minute, for a number nobody could see moving.
 *
 * Sending the DRAWN STRING fixes it by construction. Two renders a second apart
 * inside the same minute carry the identical `14m` and compare equal, so the
 * rail redraws when the text changes and at no other time. The minute timer in
 * `index.ts` is what makes the text change at all.
 *
 * **One unit, never two.** `1h 14m` is a duration you read; this is a duration
 * you GLANCE at, and the second unit only ever refines a number whose precision
 * nobody is acting on. Nothing changes about what you do at 1h14 that was not
 * already true at 1h.
 *
 * **Floored, never rounded.** `2m` for 2m59s is the honest direction to be
 * wrong: a stamp that rounds up says a task has been waiting longer than it has,
 * and this number exists to make you feel the wait. It must not exaggerate it.
 *
 * **Nothing at all under a minute.** A row that says `0s` has spent a column to
 * report that no time has passed, which is the one thing the mark beside it
 * already implies — and it flickers `0s`/`3s`/`12s` through the span where you
 * are least likely to be the bottleneck. The number exists as a triage
 * tiebreaker between tasks that have been sitting a while; it has nothing to
 * contribute in the first minute.
 *
 * It also makes the granularity honest. The rail nudges itself once a minute, so
 * a seconds-precision number would be a stale seconds-precision number — right
 * only in the instant something else happened to redraw the row.
 */
export function formatElapsed(ms: number): string | undefined {
  // A negative duration means the clock moved backwards under us. There is no
  // honest rendering of that, so there is none.
  if (!Number.isFinite(ms) || ms < 0) return undefined;

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return undefined;

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}
