import { triageOf, type TriageEntry } from './triage.ts';
import type { Place } from './nav.ts';

/**
 * **The push half: when a change is allowed to interrupt you.**
 *
 * Home is a screen you look at; this is the app tapping your shoulder. The bar
 * for that is high and the rule is one sentence — **something started needing
 * you, and you cannot see it** — with the two halves doing very different work.
 *
 * "Started" is an EDGE, not a state. A task sitting in `Needs you` for twenty
 * minutes has not become more urgent, and re-raising it on every push would turn
 * a tree that re-reads whole (the view mechanism's design) into a notification
 * loop. So this compares two snapshots and fires on the crossing.
 *
 * "Cannot see it" has two cases and the second is the interesting one. Being IN
 * the task is obvious. Being on **Home** is the other: the picture updating is
 * the notification — the row appears in `Needs you` under your eyes — and a
 * toast over a screen that just drew the same fact is the app saying it twice.
 * That is the same predicate v1 spent an ADR on (0020, "is the user looking at
 * this"), and it is one predicate here for the same reason.
 *
 * Nothing here dequeues. A dismissed toast is a toast; the task stays exactly
 * where it is, in `Needs you`, because the promise the whole surface makes is
 * that nothing is lost by not answering it now.
 */

/** What Home would file each entry under, keyed by id — the input to an edge. */
export type Standing = ReadonlyMap<string, string>;

export function standingOf(entries: readonly TriageEntry[]): Standing {
  return new Map(entries.map((entry) => [entry.id, triageOf(entry)]));
}

/**
 * The ids that just crossed INTO `needs`, in the order Home draws them.
 *
 * A row that did not exist before does not count as a crossing: the first push
 * after launch carries every task at once, and treating that as news would raise
 * a toast per blocked task at startup — which is the app shouting at a person
 * who has not done anything yet.
 */
export function crossings(before: Standing, entries: readonly TriageEntry[]): readonly TriageEntry[] {
  return entries.filter((entry) => {
    const was = before.get(entry.id);
    if (was === undefined) return false;
    return was !== 'needs' && triageOf(entry) === 'needs';
  });
}

/**
 * Can the user already see this one?
 *
 * `home` is deliberately as visible as the task itself. It is the whole reason
 * this takes a `Place` rather than a boolean: "not on screen" is a fact about
 * WHERE you are, and the two places that count are the two the router can be in.
 */
export function visible(at: Place, entry: TriageEntry): boolean {
  if (at.kind === 'home') return true;
  return at.kind === 'task' && at.id === entry.id;
}

/** The subset of a set of crossings that is worth interrupting for. */
export function toRaise(at: Place, crossed: readonly TriageEntry[]): readonly TriageEntry[] {
  return crossed.filter((entry) => !visible(at, entry));
}

/**
 * The toast queue: one on screen, the rest behind it.
 *
 * A stack of toasts is a wall, and a wall is dismissed as one gesture without
 * being read — so they arrive one at a time and the next takes the place of the
 * one you answered. Duplicates collapse: a task that crosses twice while its
 * toast is still up has nothing new to say.
 */
export interface ToastQueue {
  readonly showing: string | null;
  readonly waiting: readonly string[];
}

export const NO_TOASTS: ToastQueue = { showing: null, waiting: [] };

export function enqueue(queue: ToastQueue, ids: readonly string[]): ToastQueue {
  let showing = queue.showing;
  const waiting = [...queue.waiting];
  for (const id of ids) {
    if (showing === id || waiting.includes(id)) continue;
    if (showing === null) showing = id;
    else waiting.push(id);
  }
  return { showing, waiting };
}

/**
 * Take this one off the screen — because it was answered, dismissed, or opened.
 *
 * It removes the id from the QUEUE as well as from the slot, which is not the
 * same as dequeuing the task: the task's place in `Needs you` is a fact about
 * the task and nothing here can touch it.
 */
export function dismiss(queue: ToastQueue, id: string): ToastQueue {
  if (queue.showing !== id) {
    return { showing: queue.showing, waiting: queue.waiting.filter((each) => each !== id) };
  }
  const [next, ...rest] = queue.waiting;
  return { showing: next ?? null, waiting: rest };
}

/**
 * Drop anything that is no longer asking.
 *
 * A toast whose task was answered from Home, or in another window, or which
 * simply finished, has to go — a card offering to take you to a question that
 * has already been answered is worse than no card.
 */
export function prune(queue: ToastQueue, entries: readonly TriageEntry[]): ToastQueue {
  const asking = new Set(entries.filter((entry) => triageOf(entry) === 'needs').map((entry) => entry.id));
  const waiting = queue.waiting.filter((id) => asking.has(id));
  if (queue.showing !== null && !asking.has(queue.showing)) {
    const [next, ...rest] = waiting;
    return { showing: next ?? null, waiting: rest };
  }
  return { showing: queue.showing, waiting };
}
