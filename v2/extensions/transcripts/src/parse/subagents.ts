/**
 * Where a session's subagent transcripts live.
 *
 * Claude writes them to a sibling directory named for the session file:
 * `<enc>/<uuid>.jsonl` → `<enc>/<uuid>/subagents/agent-<id>.jsonl`. Confirmed on
 * a real corpus — 29 such directories, 146 files.
 *
 * **Discovery is by PATH, never by a record flag.** `isSidechain` is true in 145
 * of those 146 files and in 0 of 720 parents: it labels a subagent transcript
 * from the inside, so it can confirm one but can never find one. A reader
 * expecting the parent to point at its children finds nothing and concludes
 * there are none.
 *
 * The predicate is exact so a count and a listing cannot disagree — a stray
 * `.jsonl`, or a directory whose name ends in `.jsonl`, would otherwise inflate
 * a badge past what expanding it shows.
 */

export const SUBAGENT_DIR = 'subagents';
export const SUBAGENT_PREFIX = 'agent-';

const JSONL = /\.jsonl$/i;

export function subagentDirFor(sessionPath: string): string {
  return `${sessionPath.replace(JSONL, '')}/${SUBAGENT_DIR}`;
}

export function isSubagentFileName(name: string): boolean {
  if (!name.startsWith(SUBAGENT_PREFIX)) return false;
  if (!JSONL.test(name)) return false;
  // `agent-.jsonl` names no agent; it is not one of these files.
  return name.length > SUBAGENT_PREFIX.length + '.jsonl'.length;
}
