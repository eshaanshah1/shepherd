import type { TranscriptHit } from '../manifest.ts';

/**
 * Turning a flat list of hits into the two things the rail needs: one number, and
 * a grouping by task.
 *
 * Pure, and separate from `index.ts`, because both answers are easy to get subtly
 * wrong — the count must ignore the display cap, and the grouping must not invent
 * a bucket for a hit whose task has been forgotten.
 */

/**
 * Every match that exists, across every session — the `n in transcripts` number.
 *
 * `hit.total`, not `hit.matches.length`: the provider caps what it *draws* at
 * three per session, and a row claiming `3 in transcripts` when twelve exist is
 * the row lying about the one thing it was added to report.
 */
export function totalMatches(hits: readonly TranscriptHit[]): number {
  return hits.reduce((sum, hit) => sum + hit.total, 0);
}

/** Is `dir` the same directory as `base`, or inside it? Segment-boundary exact. */
function isUnder(dir: string, base: string): boolean {
  const root = base.replace(/\/+$/, '');
  return dir === root || dir.startsWith(`${root}/`);
}

/**
 * Group hits by task id, given each task's directories.
 *
 * A hit whose `dir` no task claims is **dropped**. That happens when a task was
 * deleted between the search being issued and its answer arriving, and a bucket
 * keyed on a task nobody can look up would draw a row that cannot be clicked.
 *
 * The **longest** matching dir wins, so a worktree nested inside another task's
 * root is attributed to the worktree's own task rather than to whichever entry
 * the map happened to yield first.
 */
export function hitsByTask(
  hits: readonly TranscriptHit[],
  dirsOf: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly TranscriptHit[]> {
  const grouped = new Map<string, TranscriptHit[]>();

  for (const hit of hits) {
    let bestTask: string | undefined;
    let bestLength = -1;
    for (const [task, dirs] of dirsOf) {
      for (const dir of dirs) {
        const base = dir.replace(/\/+$/, '');
        if (!isUnder(hit.dir, base)) continue;
        if (base.length > bestLength) {
          bestLength = base.length;
          bestTask = task;
        }
      }
    }
    if (bestTask === undefined) continue;

    const list = grouped.get(bestTask);
    if (list === undefined) grouped.set(bestTask, [hit]);
    else list.push(hit);
  }

  return grouped;
}
