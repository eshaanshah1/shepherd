/**
 * **The triage screen's one decision: which region a row belongs in.**
 *
 * Home is not a list with headings — it is an ordering of ATTENTION, and the
 * order is the whole design. `Needs you` is first because it is the only region
 * whose rows cost you something to ignore; `Shipped` is last because it is a
 * record rather than a queue. Everything between is sorted by how much of your
 * attention it is entitled to.
 *
 * Three properties this file exists to hold:
 *
 *   - **The shell groups; the extension declares.** A row arrives with a mark
 *     (`tint`, or a `mark` in its facts) and, if it is snoozed, a reason. Those
 *     are facts about the row's subject. Which REGION they land in is the
 *     takeover's vocabulary, and an extension that could name one would be
 *     deciding this screen's shape from outside it — the same argument ADR 0031
 *     makes for a row's verbs, pointed the other way.
 *   - **Nothing is ever dropped.** Every entry lands in exactly one region,
 *     including the ones that are asleep. A snoozed task is in `Later` with its
 *     reason next to it, never gone: "comes back on Home — never lost" is the
 *     promise the snooze verb makes, and a filter would break it silently.
 *   - **An empty region does not exist.** A heading over nothing is a heading
 *     that says the app is idle in six different ways.
 */

import type { MarkState } from '@shepherd/ui';
import type { RowFacts } from './row-facts.ts';

export type TriageGroup = 'needs' | 'running' | 'ship' | 'later' | 'resting' | 'shells' | 'shipped';

/**
 * Top to bottom, and it is the design rather than a preference.
 *
 * `later` sits BELOW `resting`, which reads backwards until you remember what
 * snoozing is: an answer. A resting task is unanswered — you have not said when
 * you will look at it — so it is still yours to place. A snoozed one has a date
 * on it and is the only region on this screen you have already dealt with, so it
 * ranks under the work you have not.
 *
 * `shells` sits between the work and the record deliberately: a loose terminal
 * is a PLACE, not a task — it has no lifecycle and never enters the queue — so
 * it belongs below everything that can ask for you and above what is finished.
 */
export const TRIAGE_ORDER: readonly TriageGroup[] = [
  'needs',
  'running',
  'ship',
  'resting',
  'later',
  'shells',
  'shipped',
];

export const TRIAGE_LABELS: Readonly<Record<TriageGroup, string>> = {
  needs: 'Needs you',
  running: 'Running',
  ship: 'Ready to ship',
  later: 'Later',
  resting: 'Resting',
  shells: 'Shells',
  shipped: 'Shipped',
};

/** The one region drawn loud, because it is the only one that costs you to ignore. */
export const LOUD_GROUP: TriageGroup = 'needs';

export interface TriageEntry {
  /**
   * Stable across pushes, and unique across TREES — `<view type>:<row id>`.
   *
   * Qualified because two extensions may both call a row `main`, and this is the
   * key the toast queue, the switcher and the nav stack are all held by.
   */
  readonly id: string;
  /**
   * The row's OWN id, unqualified — what the extension calls this thing.
   *
   * The subject a face is handed (ADR 0051). The qualified id above is the
   * shell's bookkeeping and means nothing to the extension being asked about
   * its own task, which is exactly the confusion a single id would invite.
   */
  readonly rowId: string;
  readonly label: string;
  readonly description?: string;
  readonly mark: MarkState;
  /**
   * This row stands for a PLACE rather than a task: a loose terminal, with no
   * lifecycle and no claim on your attention.
   *
   * The shell decides it structurally — a root in the home group (ADR 0047) —
   * rather than believing a flag, because "is this one of the loose shells" is a
   * fact about the LAYOUT and the layout is the shell's own.
   */
  readonly place: boolean;
  /** The layout root this row stands for, when it stands for one. */
  readonly root?: string;
  readonly facts: RowFacts;
  /** Which contributed view this row came from — the verb funnel needs it. */
  readonly viewType: string;
  /** The verb a click runs, as declared by the row. */
  readonly command?: { readonly id: string; readonly args?: unknown };
  /**
   * The ONE thing this row is ready for, in the extension's own words.
   *
   * Drawn as the task band's primary button. The shell never learns what it
   * does — "ship" is a `tasks` idea and this file has no opinion about whether
   * a task can be shipped, only about where the button goes.
   *
   * `leaves` is the one thing the shell DOES read: the extension saying that
   * running this verb ends the screen, so the takeover goes back to the overview
   * instead of holding you on a task whose panes are being closed.
   */
  readonly primaryAction?: {
    readonly id: string;
    readonly label: string;
    readonly args?: unknown;
    readonly leaves?: boolean;
  };
}

export interface TriageSection {
  readonly group: TriageGroup;
  readonly label: string;
  readonly loud: boolean;
  readonly entries: readonly TriageEntry[];
}

/**
 * One entry → one region.
 *
 * The two splits worth reading twice:
 *
 * **`ready` is `Needs you`, not `Ready to ship`.** The `ready` mark means a turn
 * finished and nobody has read it — it is a request, which is why §3 draws it as
 * a square. Filing it under finished work would put the one thing that just
 * changed into the region you scan last.
 *
 * **`Ready to ship` is a resting task that CHANGED something.** There is no
 * `done` state to read: `tasks`' lifecycle declares one and nothing anywhere
 * writes it (`lifecycle.ts` says so). But the distinction is real and already
 * derivable — a task with no agent running and a diff behind it is waiting on a
 * ship decision, and one with neither is simply asleep. That is exactly what the
 * two regions mean, computed from facts that exist rather than from a state that
 * does not.
 */
export function triageOf(entry: TriageEntry): TriageGroup {
  if (entry.place) return 'shells';
  if (entry.mark === 'shipped') return 'shipped';
  // Before the marks: a snoozed row has said "not now" about whatever it would
  // otherwise be, and that answer outranks the state it is sleeping on.
  if (entry.facts.snooze !== undefined) return 'later';
  if (entry.mark === 'waiting' || entry.mark === 'failed' || entry.mark === 'ready') return 'needs';
  if (entry.mark === 'working') return 'running';
  return entry.facts.diff === undefined ? 'resting' : 'ship';
}

/** The regions that have anything in them, in order. */
export function triage(entries: readonly TriageEntry[]): readonly TriageSection[] {
  const buckets = new Map<TriageGroup, TriageEntry[]>();
  for (const entry of entries) {
    const group = triageOf(entry);
    const bucket = buckets.get(group);
    if (bucket === undefined) buckets.set(group, [entry]);
    else bucket.push(entry);
  }
  return TRIAGE_ORDER.flatMap((group) => {
    const bucket = buckets.get(group);
    if (bucket === undefined || bucket.length === 0) return [];
    return [{ group, label: TRIAGE_LABELS[group], loud: group === LOUD_GROUP, entries: bucket }];
  });
}

/**
 * Everything asking for you, in the order Home draws it.
 *
 * The input to two things at once — the header's live count and `J`, which is
 * "the next one of these" — and they must not be able to disagree about what
 * counts, which is why neither computes its own.
 */
export function needsYou(entries: readonly TriageEntry[]): readonly TriageEntry[] {
  return entries.filter((entry) => triageOf(entry) === 'needs');
}

/**
 * What the header counts as LIVE.
 *
 * Everything that is not a finished record and not a place: the things that can
 * still change while you are looking somewhere else. A shell is excluded for the
 * same reason it has its own region — it is not work, it is where you do work.
 */
export function liveCount(entries: readonly TriageEntry[]): number {
  return entries.filter((entry) => {
    const group = triageOf(entry);
    return group !== 'shipped' && group !== 'shells';
  }).length;
}

/**
 * The next thing to look at, from wherever you are.
 *
 * `J` cycles rather than sticking: passing the id you are already on skips it,
 * so pressing it twice on a two-task morning moves rather than re-opening what
 * is already in front of you.
 */
export function nextNeeding(entries: readonly TriageEntry[], currentId?: string): TriageEntry | undefined {
  const queue = needsYou(entries);
  return queue.find((entry) => entry.id !== currentId) ?? undefined;
}
