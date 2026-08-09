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

export type HookKind = 'global' | 'repo';

export interface HookRun {
  readonly kind: HookKind;
  readonly script: string;
}

export interface HookOutcome {
  readonly kind: HookKind;
  readonly ok: boolean;
  /** Merged stdout+stderr, already tailed — or the wording for a hook that never ran. */
  readonly detail: string;
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

export function describeOutcomes(
  outcomes: readonly HookOutcome[],
  opts: { readonly skippedRepoHook?: boolean } = {},
): { readonly ok: boolean; readonly message?: string } {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return { ok: true };

  const lines = failed.map((outcome) => `the ${outcome.kind} hook failed — ${outcome.detail}`);
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
