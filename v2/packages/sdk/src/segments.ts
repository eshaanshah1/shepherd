/**
 * Text cut into alternating unmatched/matched runs — what a highlighter draws.
 *
 * It lives in the sdk for `fuzzy.ts`'s reason, and this is the same move: it was
 * `extensions/tasks/src/model/match-display.ts`, written for the repo picker's
 * field, and the palette's transcript rows now need the identical treatment from
 * `packages/ui` — which may not import an extension. A second implementation
 * would be a second opinion about which characters were the match.
 */

export interface DisplaySegment {
  readonly text: string;
  /** Whether the query hit these characters — the run to paint. */
  readonly matched: boolean;
}

/**
 * Cut `text` into runs, merging adjacent hits so `shep` is one span and not four.
 *
 * Out-of-range and duplicate positions are dropped rather than trusted: they
 * arrive from a suggestion provider this code has never seen, and an index past
 * the end would otherwise slice an empty span into the middle of the text.
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
 * One CONTIGUOUS run, as a substring match produces — `[start, end)`.
 *
 * Separate from `segmentsOf` rather than expressed through it: a transcript hit
 * knows its own bounds, and expanding them into a list of every index in between
 * only to have the merge loop collapse them again is work that can disagree with
 * itself at the edges.
 *
 * A range that is inverted or entirely past the end yields one unmatched run —
 * the same answer as "no match", because a highlight nobody can place is not one
 * to invent.
 */
export function segmentsOfRange(
  text: string,
  at: readonly [number, number],
): readonly DisplaySegment[] {
  if (text === '') return [];
  const start = Math.max(0, Math.min(at[0], text.length));
  const end = Math.max(start, Math.min(at[1], text.length));
  if (start >= end) return [{ text, matched: false }];

  const segments: DisplaySegment[] = [];
  if (start > 0) segments.push({ text: text.slice(0, start), matched: false });
  segments.push({ text: text.slice(start, end), matched: true });
  if (end < text.length) segments.push({ text: text.slice(end), matched: false });
  return segments;
}
