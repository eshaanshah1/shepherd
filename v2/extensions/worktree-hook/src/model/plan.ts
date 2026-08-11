/**
 * What runs, in what order, and what a run's outcomes mean — with no filesystem
 * and no process anywhere in sight.
 *
 * The ordering rule is the only decision worth arguing about: the global hook
 * first, because it is machine setup a repo's own hook may depend on, and the
 * repo hook skipped entirely when the global one failed for exactly that reason.
 * Running it anyway produces a second failure caused by the first, and the
 * second is the one that ends up on the row.
 */

export type HookKind = 'global' | 'repo' | 'set';

export interface HookRun {
  readonly kind: HookKind;
  readonly script: string;
  /** The source repo paths a `set` run matched, in key order. Absent for the rest. */
  readonly paths?: readonly string[];
}

/** A `set` run, which always knows its repos — it was selected by them. */
export interface SetRun extends HookRun {
  readonly kind: 'set';
  readonly paths: readonly string[];
}

/** A stored set hook, as the store hands it over: paths already normalized and sorted. */
export interface HookSet {
  readonly paths: readonly string[];
  readonly script: string;
}

export interface HookOutcome {
  readonly kind: HookKind;
  readonly ok: boolean;
  /** Merged stdout+stderr, already tailed — or the wording for a hook that never ran. */
  readonly detail: string;
  /**
   * WHICH hook of this kind, when there can be several. A task fires as many set
   * hooks as it has matching subsets, and two failures both reading "the set
   * hook failed" name neither of them.
   */
  readonly scope?: string;
}

/**
 * v1's number, kept for v1's reason: enough to see what went wrong, short enough
 * to read where it is shown.
 */
export const TAIL_LINES = 20;

export function planHooks(scripts: { readonly global?: string; readonly repo?: string }): readonly HookRun[] {
  const runs: HookRun[] = [];
  // Whitespace is not a script. The store already refuses to save one, so this
  // is the second line of defence rather than the first — but it is the line
  // that holds when a script arrives from somewhere else, like `testRun`.
  if (scripts.global !== undefined && scripts.global.trim() !== '') {
    runs.push({ kind: 'global', script: scripts.global });
  }
  if (scripts.repo !== undefined && scripts.repo.trim() !== '') {
    runs.push({ kind: 'repo', script: scripts.repo });
  }
  return runs;
}

/**
 * Which set hooks a task fires, and in what order.
 *
 * **Subset, not exact match.** A set hook fires when every repo in it is ready,
 * whatever else is on the task — so wiring written for a pair stays valid when a
 * third repo joins, which an exact match would silently drop.
 *
 * **Size ascending, then key.** Set hooks share one cwd, the task root, so they
 * run sequentially and the order has to be somebody's decision: a smaller set is
 * the more basic wiring that a larger one plausibly builds on, and the key
 * tie-break makes the whole thing reproducible.
 *
 * `ready` is the SOURCE repo paths of the ready checkouts. It is the source path
 * and not the worktree because the source path is what a hook is keyed on — the
 * only stable identity a repo has in v2.
 *
 * A set with no paths is dropped. It would be a subset of every task, i.e. a
 * second global hook; the store refuses to write one and this is the line that
 * holds when a key arrives from another build.
 */
export function matchSets(sets: readonly HookSet[], ready: readonly string[]): readonly SetRun[] {
  const have = new Set(ready);
  const keyOf = (set: HookSet): string => set.paths.join('\n');
  return sets
    .filter((set) => set.paths.length > 0 && set.script.trim() !== '' && set.paths.every((path) => have.has(path)))
    .sort((a, b) => a.paths.length - b.paths.length || keyOf(a).localeCompare(keyOf(b)))
    .map((set) => ({ kind: 'set', script: set.script, paths: set.paths }));
}

export function describeOutcomes(
  outcomes: readonly HookOutcome[],
  opts: { readonly skippedRepoHook?: boolean } = {},
): { readonly ok: boolean; readonly message?: string } {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return { ok: true };

  const lines = failed.map(
    (outcome) =>
      `the ${outcome.kind} hook${outcome.scope === undefined ? '' : ` ${outcome.scope}`} failed — ${outcome.detail}`,
  );
  // Said explicitly, because a repo hook that was never run and a repo hook that
  // ran and did nothing are indistinguishable from the outside.
  if (opts.skippedRepoHook === true) lines.push('the repo hook was skipped because the global hook failed');
  return { ok: false, message: lines.join('\n') };
}

/**
 * The last N lines, with a count of what was dropped.
 *
 * The count is this version's addition to v1's plain `tail`: output that
 * silently begins mid-sentence reads as the whole failure, and the first thing
 * you do is go looking for a rest that was never kept.
 */
export function tail(text: string, lines: number): string {
  const all = text.split('\n');
  if (all.length <= lines) return text;
  const dropped = all.length - lines;
  return [`… ${dropped} earlier line(s)`, ...all.slice(-lines)].join('\n');
}
