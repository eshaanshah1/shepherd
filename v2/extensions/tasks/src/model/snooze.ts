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
 * Three presets, and each is a different SHAPE of later rather than three
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
 * Plus a fourth form that is not a preset at all: **a time you name**. The three
 * above are the whens worth one keypress, and every other when was unsayable —
 * "until Thursday", "until this afternoon", "for twenty minutes" all had to be
 * rounded to whichever preset was least wrong. `parseWhen` reads those, and a
 * `{ at }` is what the verb takes once something has.
 *
 * Pure, and separate from the store for the usual reason: waking is a decision
 * about time and about what the agents are doing, and a decision that reads a
 * clock has to be testable without one.
 */

/**
 * `{ at }` carries epoch ms because the PARSE has already happened by then.
 *
 * The extension parses, not the shell — see the `later` options in `index.ts`.
 * What "4pm" means is a question about this task's clock, and the takeover has
 * spent real effort not knowing what a task is.
 */
export type SnoozeUntil = 'today' | 'quiet' | 'tomorrow' | { readonly at: number };

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
 * What the record stores for one of the four forms.
 *
 * `now` is passed rather than read, so a test can put the clock at Friday
 * 18:00 and assert Monday — which is the one case in here that a duration gets
 * wrong.
 */
export function snoozeFor(until: SnoozeUntil, now: number, was?: string): Snooze {
  const carry = was === undefined ? {} : { was };
  if (typeof until === 'object') return { label: stampOf(until.at, now), wakeAt: until.at, ...carry };
  if (until === 'quiet') return { label: 'when agents finish', wakeOnQuiet: true, ...carry };
  if (until === 'today') return { label: 'later today', wakeAt: now + LATER_TODAY_MS, ...carry };
  return { label: 'tomorrow', wakeAt: nextMorning(now), ...carry };
}

/**
 * How a named time reads back on the row, as `until <this>`.
 *
 * The DAY is dropped when the wake is today and added when it is not, because
 * `until 16:00` is unambiguous this afternoon and a riddle on Tuesday. Past a
 * week it takes a date instead of a weekday, for the same reason: `until Thu`
 * nine days out names the wrong Thursday to every reader.
 *
 * Rendered here rather than in the card so it matches the three presets, whose
 * labels are also the extension's own words.
 */
function stampOf(at: number, now: number): string {
  const when = new Date(at);
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((at - midnight.getTime()) / DAY_MS);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${WEEKDAYS[when.getDay()] ?? ''} ${clock}`;
  return `${when.getDate()} ${MONTHS[when.getMonth()] ?? ''} ${clock}`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * What the verb was handed → the form `snoozeFor` takes, or nothing.
 *
 * One door for both kinds of caller. A preset arrives as its own word from a
 * numbered menu entry, and anything else is what somebody typed — so the verb
 * takes a plain string and this decides which it was, rather than the caller
 * declaring a kind it might get wrong.
 */
export function readUntil(said: string, now: number): SnoozeUntil | undefined {
  const word = said.trim().toLowerCase();
  if (word === 'today' || word === 'quiet') return word;
  // `tomorrow` is the preset AND a thing people type, and the preset wins: bare,
  // it means the next WORKING morning, which `parseWhen` deliberately does not.
  if (word === 'tomorrow') return 'tomorrow';
  const at = parseWhen(said, now);
  return at === undefined ? undefined : { at };
}

/**
 * A typed "when" → the moment it names, or nothing.
 *
 * **Nothing rather than a guess.** A snooze that lands on the wrong day is worse
 * than a snooze that refused: the row leaves Home either way, and only one of
 * those tells you it did the wrong thing. So every branch here is a shape this
 * function can name exactly, and anything else is the caller's problem to report.
 *
 * Four shapes, and they cover what a person types when a preset is not the
 * moment they mean:
 *
 *   - **A duration** — `2h`, `45m`, `3d`. From now, the only form that does not
 *     care what day it is.
 *   - **A clock time** — `4pm`, `16:00`, `9`. Today if it is still ahead, else
 *     tomorrow, because a time already past is never the time you meant.
 *   - **A weekday** — `friday`, `fri`. The NEXT one at the working morning hour,
 *     and naming today's weekday means a week out rather than a moment gone.
 *   - **`tomorrow`** — the preset's own answer, spelled, because a field that
 *     rejects the word above the field it sits under is a field that looks broken.
 *
 * A weekday or `tomorrow` may carry a time (`friday 2pm`), which is the whole
 * reason the two halves parse separately rather than as one pattern per phrase.
 *
 * `now` is passed for the reason it is passed everywhere else in this file.
 */
export function parseWhen(text: string, now: number): number | undefined {
  const said = text.trim().toLowerCase();
  if (said === '') return undefined;

  const duration = /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(said);
  if (duration !== null) {
    const size = Number(duration[1]);
    const unit = duration[2] ?? '';
    if (size === 0) return undefined;
    const ms = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : DAY_MS;
    return now + size * ms;
  }

  // A bare clock time, before the day forms: `4pm` names no day, so it resolves
  // against today and rolls forward only if today's has gone.
  const bare = clockOf(said);
  if (bare !== undefined) {
    const at = atClock(now, 0, bare);
    return at > now ? at : atClock(now, 1, bare);
  }

  const [head = '', ...rest] = said.split(/\s+/);
  const tail = rest.join(' ');
  // An unreadable time beside a readable day is a refusal, not a day at 09:00 —
  // `friday afternon` must not silently become Friday morning.
  const clock = tail === '' ? { hour: MORNING_HOUR, minute: 0 } : clockOf(tail);
  if (clock === undefined) return undefined;

  if (head === 'tomorrow') return atClock(now, 1, clock);

  const day = WEEKDAYS.findIndex((name) => name.toLowerCase() === head || name.slice(0, 3).toLowerCase() === head);
  if (day === -1) return undefined;
  // `1 + ((day - today + 6) % 7)` is 1..7 and never 0: naming today's weekday
  // means the next one, a week out, rather than a moment that has already gone.
  const ahead = 1 + ((day - new Date(now).getDay() + 6) % 7);
  return atClock(now, ahead, clock);
}

interface Clock {
  readonly hour: number;
  readonly minute: number;
}

/** `4pm` / `16:00` / `9:30am` / `9` → the hour and minute it names, or nothing. */
function clockOf(said: string): Clock | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(said.trim());
  if (match === null) return undefined;
  const raw = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const half = match[3];
  if (minute > 59) return undefined;
  if (half === undefined) return raw > 23 ? undefined : { hour: raw, minute };
  // 12-hour input, so `13pm` is a typo rather than a time. `12am` is midnight
  // and `12pm` is noon, which is the one pair the modulo below has to get right.
  if (raw < 1 || raw > 12) return undefined;
  return { hour: (raw % 12) + (half === 'pm' ? 12 : 0), minute };
}

/** `days` from now, at that clock — local, and via `setDate` so DST is the platform's. */
function atClock(now: number, days: number, clock: Clock): number {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(clock.hour, clock.minute, 0, 0);
  return at.getTime();
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
