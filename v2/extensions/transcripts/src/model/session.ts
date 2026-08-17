import type { UsageRollup } from './usage.ts';

/**
 * One session, reduced to what a search and a result row need.
 *
 * **This is a projection now, not a parser.** `parse/digest.ts` is its only
 * producer, and it derives this from the full `ParsedSession`. Two readers over
 * one file format drift, and the drift is invisible: search would quietly stop
 * agreeing with a rendered transcript about what a session says.
 *
 * What stays out of here is the 97% — tool calls, tool output, thinking. The
 * index writes this shape to disk, and `tasks/store.ts`'s rule is absolute: no
 * transcripts, no diffs, no file contents, ever.
 */

export interface Turn {
  readonly source: 'user' | 'assistant' | 'recap';
  readonly ts: number | null;
  readonly text: string;
  /** The record's position in the file — what puts a recap back among the turns. */
  readonly seq: number;
}

export interface SessionDigest {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly aiTitle: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  readonly recap: string | null;
  /** When the kept recap was written — so a later chunk cannot lose to an older one. */
  readonly recapTs: number | null;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly turns: readonly Turn[];
  /** Which models answered — a badge for a hit row, at no extra read. */
  readonly models: readonly string[];
  /**
   * Deduped token totals.
   *
   * Four numbers per model, so it is small enough to cache — which is what lets
   * `transcripts.usage` answer from the index instead of re-reading 469 MB.
   */
  readonly usage: UsageRollup;
}

export function bestTitle(digest: SessionDigest): string | null {
  return digest.customTitle ?? digest.aiTitle;
}

/** Nothing was said and nothing was named — recall.py drops such a file entirely. */
export function isEmptyDigest(digest: SessionDigest): boolean {
  return (
    digest.turns.length === 0 &&
    digest.aiTitle === null &&
    digest.customTitle === null &&
    digest.recap === null
  );
}
