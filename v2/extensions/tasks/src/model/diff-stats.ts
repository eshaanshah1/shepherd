/**
 * What a task has CHANGED, as three numbers.
 *
 * Shepherd UI draws this as `+142 −38 · 7 files` on a task card — and it draws
 * NUMBERS, not a bar. A stacked +/− bar encodes the same three facts as a ratio,
 * which answers "was it mostly additions" (a question nobody asks) while making
 * "how big is this" (the one they do) something you have to estimate from a
 * width. The numbers are also tabular, so a column of tasks reads down.
 *
 * Pure and total, the same shape as `agent-rollup.ts` and `tab-rows.ts` beside
 * it: no git, no store, no running app. The process half lives in the collector,
 * so the parsing — which is where the surprises are — is testable without one.
 */

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

export const NO_DIFF: DiffStats = { added: 0, removed: 0, files: 0 };

/**
 * `git diff --numstat`, parsed.
 *
 * The format is `<added>\t<removed>\t<path>` per line, and three things about it
 * are easy to get wrong:
 *
 *   - **A binary file reports `-\t-\t<path>`.** Not zero — *unknown*. It counts
 *     as a changed FILE and contributes nothing to either line count, which is
 *     the only honest reading: a 4MB PNG did not add 4 million lines and it did
 *     not add zero either.
 *   - **A rename reports `0\t0\t<old> => <new>`** (or a `{a => b}/c` form with
 *     `-z` off). It is one file and no lines, and it must not be dropped: a task
 *     that only moved files has changed something, and `0 files` would say it
 *     had not.
 *   - **The path can contain tabs**, so the split is bounded to two — anything
 *     after the second tab is the path, whatever is in it.
 *
 * Anything it cannot read it skips rather than throwing. This runs on output
 * from a git that may be newer than this code, and a card that cannot draw its
 * diff line is a smaller problem than a sidebar that will not render.
 */
export function parseNumstat(stdout: string): DiffStats {
  let added = 0;
  let removed = 0;
  let files = 0;

  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;

    const a = line.slice(0, firstTab);
    const r = line.slice(firstTab + 1, secondTab);
    const path = line.slice(secondTab + 1);
    if (path === '') continue;

    files += 1;
    // `-` is git's "binary, no line count". `Number('-')` is NaN, which would
    // poison the sum — so both sides are checked rather than coerced.
    const addedN = Number.parseInt(a, 10);
    const removedN = Number.parseInt(r, 10);
    if (Number.isFinite(addedN)) added += addedN;
    if (Number.isFinite(removedN)) removed += removedN;
  }

  return { added, removed, files };
}

/**
 * Two readings of one repo, combined: what is committed on the branch, and what
 * is not committed at all.
 *
 * They are two `git diff` calls because git has no single one that answers both
 * — and summing them is right for lines but WRONG for files, because a file that
 * was committed and then edited again appears in both. So the caller passes the
 * file PATHS it saw, and this counts the union.
 *
 * That is the whole reason this takes path sets rather than two `DiffStats`.
 */
export function combineRepoDiff(
  committed: DiffStats,
  uncommitted: DiffStats,
  paths: ReadonlySet<string>,
): DiffStats {
  return {
    added: committed.added + uncommitted.added,
    removed: committed.removed + uncommitted.removed,
    files: paths.size,
  };
}

/** The paths a numstat mentions, for the union above. */
export function numstatPaths(stdout: string): readonly string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const path = line.slice(secondTab + 1);
    if (path !== '') paths.push(path);
  }
  return paths;
}

/**
 * Every repo a task touches, as one line.
 *
 * A task is the unit the card draws, and a task spans repos — so the card says
 * what the TASK changed, and the per-repo split lives in the pane heads where
 * you can see which tree you are in. Summing files across repos is safe in a way
 * summing within one is not: two repos cannot contain the same working-tree
 * path.
 */
export function sumDiff(perRepo: readonly DiffStats[]): DiffStats {
  return perRepo.reduce<DiffStats>(
    (total, repo) => ({
      added: total.added + repo.added,
      removed: total.removed + repo.removed,
      files: total.files + repo.files,
    }),
    NO_DIFF,
  );
}

/** Nothing changed — so the card draws no diff line at all rather than `+0 −0`. */
export function isEmptyDiff(stats: DiffStats): boolean {
  return stats.files === 0 && stats.added === 0 && stats.removed === 0;
}
