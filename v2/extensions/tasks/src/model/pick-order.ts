/**
 * What order the picker offers rows in — the whole rule, and nothing that reads
 * a disk.
 *
 * It lives here because it has been wrong twice, both times invisibly: the field
 * draws the FIRST row and ⏎ takes it, so an ordering mistake is not a cosmetic
 * one — it is which repo your task gets built on. The handler that used to hold
 * this had no test of any kind.
 */

export interface Orderable {
  readonly path: string;
  /** The text drawn for this row. Ties break toward the shorter one. */
  readonly display: string;
  readonly isRepo: boolean;
}

export interface Scored<T> {
  readonly row: T;
  readonly score: number;
}

/**
 * Rank the rows that could have come from anywhere.
 *
 * Score first, then a repo over a directory, then the shorter text: `~/dev/shepherd`
 * and `~/dev/shepherd/.claude` score identically for `shep` — every character
 * matched in the same place — and the one that is a repo and says less is the
 * one that was meant. Without the tie-break the winner is whichever the history
 * happened to store first.
 */
export function rankScored<T extends Orderable>(rows: readonly Scored<T>[]): readonly T[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.row.isRepo) - Number(a.row.isRepo) ||
        a.row.display.length - b.row.display.length ||
        a.row.display.localeCompare(b.row.display),
    )
    .map((entry) => entry.row);
}

/**
 * The final order: the exact repo, then the disk, then history.
 *
 * **The disk beats history.** A filesystem row exists because you named its
 * parent directory, which is a statement about where you are looking; a history
 * hit could have come from anywhere on disk. Shipped the other way round, a
 * `.claude` that had found its way into history — through this picker's own
 * earlier bug — outranked the repo sitting beside it on disk, and the field drew
 * it as the answer.
 *
 * `exactPath` wins outright when it is present: it is the one input that cannot
 * be ambiguous, and completion answers it with its own CHILDREN, so without this
 * typing a repo's whole path picks something inside it.
 */
export function orderSuggestions<T extends Orderable>(
  filesystem: readonly T[],
  history: readonly T[],
  exactPath: string | null,
  limit: number,
): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const take = (row: T): void => {
    if (seen.has(row.path)) return;
    seen.add(row.path);
    out.push(row);
  };

  if (exactPath !== null) {
    const exact = [...filesystem, ...history].find((row) => row.path === exactPath);
    if (exact !== undefined) take(exact);
  }
  for (const row of filesystem) take(row);
  for (const row of history) take(row);
  return out.slice(0, limit);
}
