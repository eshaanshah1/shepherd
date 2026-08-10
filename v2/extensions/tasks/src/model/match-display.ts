import { collapseHome } from './repo-path.ts';

/**
 * How a matched path is drawn: the text, and which characters the query hit.
 *
 * The repo field shows the MATCH rather than the keystrokes — you type `shpd`
 * and the field reads `~/Home/dev/shepherd`, with the four characters you
 * actually typed picked out of it. That is fzf's contract, and the reason it
 * works is that the highlight explains *why* this row won: without it the field
 * is asserting a match you have no way to check.
 *
 * Both halves are computed HERE, on the extension's side, and cross the port
 * ready to draw. The view is deliberately not allowed to re-derive them (see
 * `composer.tsx`): it has no home directory to collapse against and no matcher,
 * and a second matcher is a second chance to disagree with whatever did the
 * ordering.
 */

export interface DisplaySegment {
  readonly text: string;
  /** Whether the query hit these characters — the run to paint. */
  readonly matched: boolean;
}

export interface MatchDisplay {
  /** The path as a person writes it: home collapsed to `~`. */
  readonly text: string;
  /** `text`, cut into alternating unmatched/matched runs. Concatenates back. */
  readonly segments: readonly DisplaySegment[];
}

/**
 * Cut `text` into runs, merging adjacent hits so `shep` is one span and not four.
 *
 * Out-of-range and duplicate positions are dropped rather than trusted: they
 * arrive from a suggestion provider this code has never seen, and an index past
 * the end would otherwise slice an empty span into the middle of the path.
 */
export function segmentsOf(text: string, positions: readonly number[]): readonly DisplaySegment[] {
  const hit = new Set(positions.filter((at) => Number.isInteger(at) && at >= 0 && at < text.length));
  if (hit.size === 0) return text === '' ? [] : [{ text, matched: false }];

  const segments: DisplaySegment[] = [];
  let start = 0;
  for (let at = 1; at <= text.length; at++) {
    if (at < text.length && hit.has(at) === hit.has(start)) continue;
    segments.push({ text: text.slice(start, at), matched: hit.has(start) });
    start = at;
  }
  return segments;
}

/**
 * A candidate and the positions the matcher hit in it → what the field draws.
 *
 * Collapsing home moves every position left by the length it removed. A position
 * that fell INSIDE the home prefix has nowhere to land — those characters are no
 * longer on screen — so it is folded onto the `~` that replaced them rather than
 * dropped, which is what keeps a query typed as `/Users/…` from rendering with
 * no highlight at all.
 */
export function displayMatch(path: string, positions: readonly number[], home: string): MatchDisplay {
  const text = collapseHome(path, home);
  const removed = path.length - text.length;
  const moved =
    removed === 0
      ? positions
      : positions.map((at) => (at < removed + 1 ? 0 : at - removed));
  return { text, segments: segmentsOf(text, moved) };
}
