/**
 * Subsequence matching, ranked — the one matcher in the tree.
 *
 * **It lives in the sdk, and that is a move rather than a new file.** It was
 * `@shepherd/ui/fuzzy.ts`, written for the ⌘K palette, and `@shepherd/ui` is
 * importable from exactly two places (the renderer and an extension's `ui/`
 * half). The repo picker needs the same ranking in an extension's SERVICE half —
 * it is the side that holds the history and reads the directory, so it is the
 * side that must filter and cap before a few hundred entries cross a message
 * port. The sdk is the one floor both halves stand on, and "types + pure
 * helpers" is exactly what this is: no host, no clock, no IO.
 *
 * The alternative was a second matcher in the extension, which is the drift the
 * design system exists to prevent — two ideas about what a better match is, in
 * one app.
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

/**
 * One candidate's match: what it scored, and WHERE it matched.
 *
 * The positions are the half a highlighter needs and the reason this function
 * exists beside `fuzzyScore` — a view that re-derives them runs the matcher
 * twice and, worse, can disagree with the ranker about which characters were the
 * match. They are indices into the candidate as given (not the lowercased copy),
 * ascending, one per character of the query.
 */
export interface FuzzyMatch {
  readonly score: number;
  readonly positions: readonly number[];
}

/** A word starts after anything that is not a letter or a digit. */
const isBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const previous = text[index - 1] ?? '';
  return !/[a-z0-9]/i.test(previous);
};

/**
 * Score one candidate against one query, and say where it matched. `null` means
 * "not a match" — which is different from a score of zero, and conflating the
 * two is how an empty query ends up filtering everything out.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (query === '') return { score: 0, positions: [] };

  const needle = query.toLowerCase();
  const hay = candidate.toLowerCase();

  const positions: number[] = [];
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
    positions.push(found);
    cursor = found + 1;
  }

  // The whole match's position, once — not per character, which would punish a
  // long query for being long.
  const first = hay.indexOf(needle[0] ?? '');
  return { score: score - Math.min(first, 20), positions };
}

/** The score alone, for a caller that ranks and does not draw. */
export function fuzzyScore(query: string, candidate: string): number | null {
  return fuzzyMatch(query, candidate)?.score ?? null;
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
