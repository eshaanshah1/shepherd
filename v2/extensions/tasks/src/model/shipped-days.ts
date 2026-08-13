/**
 * How the Shipped region is partitioned — day buckets, and the one row that stands
 * for more than one task.
 *
 * Pure, and separate from `order.ts` for the same reason that file is separate
 * from the tree: `order.ts` answers "which row sits where", and this answers
 * "which rows are one group". A reader asking why finished work is grouped at all
 * reads this file rather than 300 lines of `getChildren`.
 *
 * **Everything here takes `now` rather than reading a clock**, so a test can state
 * the case instead of mocking one.
 *
 * ── why a day header, and why NO time on the row ─────────────────────────────
 *
 * A task row used to carry an age (`2h`), which under `Shipped` reported how old
 * the TASK was rather than when it shipped — work begun three weeks ago and
 * finished ten minutes ago read `21d`. The obvious repair was a ship clock, and it
 * was tried: `16:40`, off `archivedAt`, correct about the right event.
 *
 * It came out again, and that is the position this file now holds. The question the
 * archive is asked is "what did I finish today", and a day header answers it once
 * for a whole group — where a per-row minute stamp answers a question nobody asked
 * and puts a number beside every title you are trying to read. So the grouping is
 * all that survives, and the row says only what it is.
 */

/**
 * A shipped task, as this file needs it.
 *
 * `archivedAt` is optional because records written before the field existed do not
 * carry one. It falls back to `createdAt` throughout — the same fallback
 * `shippedOrder` makes, and safe for the same reason: the worst it can do is file
 * one old record under the wrong day, where the sweep this replaced would have
 * deleted the oldest snapshots first.
 */
export interface Shippable {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly archivedAt?: number;
}

/** When a task was shipped, as far as the record can say. */
export const shippedAt = (task: Shippable): number => task.archivedAt ?? task.createdAt;

/**
 * One row of the Shipped region, which may stand for more than one task.
 *
 * `count` is how many tasks share this row's title within its day. It is `1` for
 * almost every row, and the row draws a badge only above that.
 *
 * `task` is the one the row OPENS — the most recently shipped of the group.
 * Deliberately singular: a row has one command, and "open all of them" is not a
 * gesture the layout has.
 */
export interface ShippedRow<T extends Shippable = Shippable> {
  readonly task: T;
  readonly count: number;
}

/** A day's worth of shipped rows, under the label that names the day. */
export interface ShippedDay<T extends Shippable = Shippable> {
  readonly label: string;
  readonly rows: readonly ShippedRow<T>[];
}

const HOUR = 60 * 60_000;

/**
 * Midnight at the start of the local day containing `at`.
 *
 * Local, and via the Date constructor rather than by flooring the epoch to a
 * multiple of `DAY`: an epoch floor is midnight UTC, so for anyone west of it
 * "today" would start mid-afternoon the day before. It also handles the two days a
 * year that are 23 or 25 hours long, which arithmetic on `DAY` cannot.
 */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The label for the day containing `at`.
 *
 * `Today` and `Yesterday` are named, and everything older is dated. Named relative
 * days are what the region is mostly asked about and they need no decoding; a third
 * relative name (`2 days ago`) would be arithmetic wearing a word, which is the
 * thing being removed.
 *
 * A date carries no year, because the rail is 332px and the archive is read from
 * the top. A task shipped in a previous year reads `12 Aug`, which is wrong by a
 * year and unambiguous in practice — and the honest fix if it ever matters is a
 * year on the older labels, not a longer format on all of them.
 */
export function dayLabel(at: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day >= today) return 'Today';
  if (day >= startOfDay(today - HOUR)) return 'Yesterday';
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * Collapse tasks that share a title, most-recently-shipped first.
 *
 * **Within one day only** — the caller groups first, and that is the whole reason
 * the collapse is safe to do at all. Two tasks called `Update Shepherd with
 * Shepherd-design` shipped an hour apart are one line of the record; the same two
 * shipped a fortnight apart are two different afternoons, and merging them would
 * lose the fact the region exists to keep.
 *
 * The input's order is preserved: the first occurrence of a title holds the group's
 * position, so collapsing never moves a row that was already drawn. Its `task` is
 * therefore the newest of the group, given a newest-first input.
 */
export function collapseByTitle<T extends Shippable>(tasks: readonly T[]): readonly ShippedRow<T>[] {
  const byTitle = new Map<string, { task: T; count: number }>();
  const order: string[] = [];
  for (const task of tasks) {
    const seen = byTitle.get(task.title);
    if (seen === undefined) {
      byTitle.set(task.title, { task, count: 1 });
      order.push(task.title);
      continue;
    }
    byTitle.set(task.title, { task: seen.task, count: seen.count + 1 });
  }
  return order.map((title) => {
    // Non-null by construction: `order` only holds keys just written to the map.
    const group = byTitle.get(title) as { task: T; count: number };
    return { task: group.task, count: group.count };
  });
}

/**
 * The Shipped region: day buckets, in the order given, each holding collapsed rows.
 *
 * `tasks` must arrive in the order they should be drawn (`shippedOrder` —
 * most-recently-shipped first). Buckets are emitted in first-appearance order
 * rather than re-sorted, so this function cannot move a row: it only decides where
 * the labels go.
 *
 * Consecutive runs, not a groupBy: a task whose day repeats after another day has
 * intervened gets its own bucket rather than being pulled back into the earlier
 * one. That cannot happen with a sorted input, and if it ever does the drawing
 * stays faithful to the order instead of silently reordering to make the grouping
 * tidy.
 */
export function groupByDay<T extends Shippable>(tasks: readonly T[], now: number): readonly ShippedDay<T>[] {
  const days: { label: string; tasks: T[] }[] = [];
  for (const task of tasks) {
    const label = dayLabel(shippedAt(task), now);
    const open = days[days.length - 1];
    if (open !== undefined && open.label === label) open.tasks.push(task);
    else days.push({ label, tasks: [task] });
  }
  return days.map((day) => ({ label: day.label, rows: collapseByTitle(day.tasks) }));
}
