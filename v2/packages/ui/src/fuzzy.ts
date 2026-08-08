/**
 * The palette's filter — a pure function, and the whole reason the palette
 * needed no dependency.
 *
 * `cmdk` was the alternative and it was declined (the argument is in
 * `command-palette.tsx`); what it would have brought here is `command-score`, an
 * opaque ranking nobody in this repo could tune and nobody could test without
 * mounting a component. This is thirty lines and it is the half of a palette that
 * is actually a decision: which of two matches is the better one.
 *
 * **Subsequence matching, ranked.** Every character of the query must appear in
 * the candidate, in order, but not adjacently — so `lz` finds `layout.zoom` and
 * `tc` finds `Tasks: Create`. That is what makes a palette faster than a menu:
 * you type the shape of the thing rather than its prefix.
 *
 * The ranking is three bonuses and one penalty, and each one exists because of a
 * pair of results that would otherwise tie:
 *
 *   - **A word start scores double.** `tc` should find `Tasks: Create` before
 *     `Tasks: Archive`, whose `c` is buried inside `Archive`. Without this the
 *     two are the same match at the same distance.
 *   - **A run scores more the longer it gets.** `layo` in `layout.zoom` is one
 *     unbroken run and should beat four scattered letters that happen to line up.
 *   - **An earlier match wins the tie.** Between two candidates with identical
 *     structure, the one whose match starts nearer the front is the one you were
 *     more likely typing at.
 *   - **A gap costs**, mildly and with a floor, so a long name cannot be ranked
 *     out of existence by the distance between two of its letters.
 *
 * Ties break on the ORIGINAL ORDER, never on the title. The registry's order is
 * insertion order — the kernel's commands, then each extension's, in activation
 * order — which is a real grouping a user can learn, and alphabetising would
 * scatter `layout.*` through `tasks.*` for no gain.
 */

export interface FuzzyMatch<T> {
  readonly item: T;
  readonly score: number;
}

/** A word starts after anything that is not a letter or a digit. */
const isBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const previous = text[index - 1] ?? '';
  return !/[a-z0-9]/i.test(previous);
};

/**
 * Score one candidate against one query. `null` means "not a match" — which is
 * different from a score of zero, and conflating the two is how an empty query
 * ends up filtering everything out.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query === '') return 0;

  const needle = query.toLowerCase();
  const hay = candidate.toLowerCase();

  let score = 0;
  let cursor = 0;
  let run = 0;

  for (const character of needle) {
    const found = hay.indexOf(character, cursor);
    if (found === -1) return null;

    const gap = found - cursor;
    run = gap === 0 && cursor > 0 ? run + 1 : 0;

    // 10 for the match, +10 at a word start, +4 per character of an unbroken
    // run, and a gap penalty that never takes more than the match is worth.
    score += 10 + (isBoundary(hay, found) ? 10 : 0) + run * 4 - Math.min(gap, 8);
    cursor = found + 1;
  }

  // The whole match's position, once — not per character, which would punish a
  // long query for being long.
  const first = hay.indexOf(needle[0] ?? '');
  return score - Math.min(first, 20);
}

/**
 * Filter and rank. An empty query returns everything, in the order it arrived —
 * a palette that has just opened is a list, not a search result.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], textOf: (item: T) => string): readonly T[] {
  if (query.trim() === '') return items;

  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query.trim(), textOf(item));
    if (score !== null) scored.push({ item, score, index });
  });

  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
}
