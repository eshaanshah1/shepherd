/**
 * What order the rail draws tasks in, and how much of the shipped list it shows.
 *
 * Pure, and separate from the tree, because "which row sits where" is the whole
 * of the design's claim about attention: the rail used to sort live tasks into
 * `Waiting on you` / `In flight` / `Resting`, which is a machine's opinion about
 * what matters, and it is now a list you append to. A reader who wants to know
 * whether a row can move reads this file rather than 300 lines of `getChildren`.
 */

/**
 * How many shipped rows are drawn before the rest go behind `Show all`.
 *
 * A number rather than a setting: shipped work is a record, not a workspace, and
 * a preference for how much of it to show is a contract nobody has asked for.
 */
export const SHIPPED_CAP = 8;

export interface Ordered {
  readonly createdAt: number;
  /**
   * When the task last entered the active list — written on un-ship and nowhere
   * else, so it is absent on every record that has never left it.
   */
  readonly activatedAt?: number;
  readonly archivedAt?: number;
}

/**
 * Live tasks, oldest first.
 *
 * **A new task is appended and nothing above it moves**, which is the property
 * the whole ordering exists for: a rail sorted newest-first shifts every row
 * down by one each time a task is created, so the thing under your cursor is not
 * the thing you were about to click.
 *
 * The key is `activatedAt ?? createdAt` because un-shipping is a re-entry: work
 * from three weeks ago that you have just pulled back is the newest thing in the
 * list by intent, and sorting it by `createdAt` would file it above everything
 * current and shift the rest of the rail to make room.
 */
export function activeOrder<T extends Ordered>(tasks: readonly T[]): readonly T[] {
  return [...tasks].sort((a, b) => (a.activatedAt ?? a.createdAt) - (b.activatedAt ?? b.createdAt));
}

/**
 * Shipped tasks, most recently shipped first — the opposite direction from the
 * active list, and deliberately: this is a record you read from the top, and the
 * cap below only means anything if the rows it keeps are the recent ones.
 *
 * `archivedAt ?? createdAt`, so a record written before that field existed still
 * lands somewhere sensible. The fallback is safe here in a way it was not for the
 * expiry sweep this replaced: that one fed a delete, where dating a shelving to
 * when the work STARTED would have destroyed the oldest snapshots first. The
 * worst this can do is draw one old record out of turn.
 */
export function shippedOrder<T extends Ordered>(tasks: readonly T[]): readonly T[] {
  return [...tasks].sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));
}

/**
 * The shipped rows to draw, and how many are being held back.
 *
 * `hidden` is `0` whenever everything is on screen — including at exactly the
 * cap — so the caller's "draw a `Show all` row" test is `hidden > 0` and never
 * needs to re-derive the arithmetic.
 */
export function capShipped<T>(
  tasks: readonly T[],
  cap: number,
  all: boolean,
): { readonly shown: readonly T[]; readonly hidden: number } {
  if (all || tasks.length <= cap) return { shown: tasks, hidden: 0 };
  return { shown: tasks.slice(0, cap), hidden: tasks.length - cap };
}
