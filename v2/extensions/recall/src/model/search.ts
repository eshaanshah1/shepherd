import { bestTitle, type SessionDigest } from './session.ts';

/**
 * Matching a query against a digest — case-insensitive LITERAL substring.
 *
 * Not fuzzy, deliberately. Fuzzy is right for a title, where you are aiming at a
 * name you half remember; over prose it matches almost everything, because any
 * five letters appear in order somewhere in a paragraph. recall's own contract is
 * a grep and this keeps it.
 *
 * Not regex either, for now: the box is one a person types a phrase into, and a
 * stray `(` would otherwise throw on a keystroke. A `/pattern` mode is recorded
 * as a follow-up in the design doc.
 */

export type MatchSource = 'user' | 'assistant' | 'recap' | 'title' | 'agent';

export interface SessionMatch {
  readonly source: MatchSource;
  /** The snippet, already windowed and flattened to one line. */
  readonly text: string;
  /** The run to highlight, as offsets into `text`. */
  readonly at: readonly [number, number];
}

/** recall's own window: 60 characters each side of the hit. */
export const SNIPPET_RADIUS = 60;

/** recall's own `--matches-per-session` default. */
export const DEFAULT_MATCHES_PER_SESSION = 3;

/**
 * A window around a hit, flattened to one line, with the range moved to match.
 *
 * **The flattening happens BEFORE the window is cut**, so the returned offsets
 * index the string that is actually drawn. Collapsing whitespace afterwards would
 * shift every character left by an unknown amount and put the highlight on the
 * wrong word — the one bug a highlighter must not have, because it reads as a
 * wrong search result rather than a wrong offset.
 */
export function snippetAround(
  text: string,
  start: number,
  end: number,
  radius: number = SNIPPET_RADIUS,
): { readonly text: string; readonly at: readonly [number, number] } {
  // Flatten each part separately, so the hit's new bounds are recomputed from
  // the flattened halves rather than adjusted by a guessed delta.
  const before = text.slice(0, start).replace(/\s+/g, ' ');
  const hit = text.slice(start, end).replace(/\s+/g, ' ');
  const after = text.slice(end).replace(/\s+/g, ' ');

  const head = before.slice(Math.max(0, before.length - radius));
  const tail = after.slice(0, radius);

  return { text: `${head}${hit}${tail}`, at: [head.length, head.length + hit.length] };
}

function firstIndex(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle);
}

/**
 * Every field this searches, in the order recall prints them: the side fields
 * that describe the session, then the body.
 *
 * A session found by its title should say so first — that is why it matched, and
 * a body snippet above it would be answering a question nobody asked.
 */
function sideFields(
  digest: SessionDigest,
): readonly { readonly source: MatchSource; readonly text: string }[] {
  const fields: { readonly source: MatchSource; readonly text: string }[] = [];
  if (digest.recap !== null) fields.push({ source: 'recap', text: digest.recap });
  const title = bestTitle(digest);
  if (title !== null) fields.push({ source: 'title', text: title });
  if (digest.agentName !== null) fields.push({ source: 'agent', text: digest.agentName });
  return fields;
}

/**
 * Up to `max` matches, side fields first.
 *
 * **One match per turn.** A turn that says `recall` four times is one place you
 * would go to read it, so four rows would be four ways to open the same session
 * at the same moment — and they would crowd out the other sessions the cap exists
 * to make room for.
 */
export function matchesIn(
  digest: SessionDigest,
  query: string,
  max: number = DEFAULT_MATCHES_PER_SESSION,
): readonly SessionMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || max <= 0) return [];

  const out: SessionMatch[] = [];

  const push = (source: MatchSource, text: string): void => {
    const at = firstIndex(text, needle);
    if (at === -1) return;
    const window = snippetAround(text, at, at + needle.length);
    out.push({ source, text: window.text, at: window.at });
  };

  for (const field of sideFields(digest)) {
    if (out.length >= max) return out;
    push(field.source, field.text);
  }

  for (const turn of digest.turns) {
    if (out.length >= max) return out;
    push(turn.source, turn.text);
  }

  return out;
}

/**
 * How many places in this session match — uncapped.
 *
 * The rail's `n in transcripts` row is a claim about what EXISTS, so it counts
 * past the display cap. Capping it would make the row agree with the overlay's
 * row count and disagree with the truth.
 */
export function countMatches(digest: SessionDigest, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;

  let count = 0;
  for (const field of sideFields(digest)) {
    if (firstIndex(field.text, needle) !== -1) count += 1;
  }
  for (const turn of digest.turns) {
    if (firstIndex(turn.text, needle) !== -1) count += 1;
  }
  return count;
}
