/**
 * **"Not now" — with a "then" attached.**
 *
 * The takeover's promise is that nothing is ever lost by not answering it
 * immediately. Snooze is how that promise is kept: a task that wants you and is
 * put off does not leave the list — it moves to `Later`, wearing the reason, and
 * it comes back on its own.
 *
 * That is why it is a REASON rather than a flag. "Not now" with no "then" is
 * indistinguishable from "gone", and a person who cannot tell those apart stops
 * using the verb — which is the failure this whole surface is built against.
 *
 * Three options, and each is a different SHAPE of later rather than three
 * durations:
 *
 *   - **Later today** — a wall-clock delay. You will be at this desk.
 *   - **When agents finish** — a CONDITION, not a time. This is the one worth
 *     having: the reason you are deferring a question is usually that three
 *     other things are mid-turn, and "when the room goes quiet" is the moment
 *     you actually wanted, which no duration can name.
 *   - **Tomorrow** — the next working morning, not 24 hours. A thing put off on
 *     Friday evening should be waiting on Monday, not at midnight.
 *
 * Pure, and separate from the store for the usual reason: waking is a decision
 * about time and about what the agents are doing, and a decision that reads a
 * clock has to be testable without one.
 */

export type SnoozeUntil = 'today' | 'quiet' | 'tomorrow';

export interface Snooze {
  /** The extension's own words, drawn by the shell as `until <label>`. */
  readonly label: string;
  /** Epoch ms. Absent when the reason is a condition rather than a time. */
  readonly wakeAt?: number;
  /** Wake when nothing in this task is working. Absent when the reason is a time. */
  readonly wakeOnQuiet?: true;
  /**
   * What it was doing when it was put off.
   *
   * Kept so a wake can say WHY it is back — a question that was snoozed comes
   * back as a question. Without it the resurfaced row says "back from later",
   * which is a fact about the snooze rather than about the work.
   */
  readonly was?: string;
}

/** Three hours, which is "later today" without pretending to be precise. */
const LATER_TODAY_MS = 3 * 60 * 60 * 1000;

/** The working morning a thing put off "tomorrow" comes back on. */
const MORNING_HOUR = 9;

/**
 * What the record stores for one of the three options.
 *
 * `now` is passed rather than read, so a test can put the clock at Friday
 * 18:00 and assert Monday — which is the one case in here that a duration gets
 * wrong.
 */
export function snoozeFor(until: SnoozeUntil, now: number, was?: string): Snooze {
  const carry = was === undefined ? {} : { was };
  if (until === 'quiet') return { label: 'when agents finish', wakeOnQuiet: true, ...carry };
  if (until === 'today') return { label: 'later today', wakeAt: now + LATER_TODAY_MS, ...carry };
  return { label: 'tomorrow', wakeAt: nextMorning(now), ...carry };
}

/**
 * The next working morning at 09:00, local time.
 *
 * **Working**, so Friday evening lands on Monday. A task put off on Friday and
 * resurfaced on Saturday morning is a notification nobody asked for, and the
 * whole verb is about not being interrupted.
 */
export function nextMorning(now: number): number {
  const at = new Date(now);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  // Always the NEXT one: snoozing at 07:00 means tomorrow, not in two hours.
  do {
    at.setDate(at.getDate() + 1);
  } while (at.getDay() === 0 || at.getDay() === 6);
  return at.getTime();
}

/**
 * Is it time?
 *
 * `working` is whether any agent of this task is mid-turn. It is the input the
 * condition form reads, and it is passed in for the same reason `now` is —
 * this decision is made in one place and asserted without a clock or a session.
 */
export function hasWoken(snooze: Snooze, now: number, working: boolean): boolean {
  if (snooze.wakeOnQuiet === true) return !working;
  return snooze.wakeAt !== undefined && now >= snooze.wakeAt;
}
