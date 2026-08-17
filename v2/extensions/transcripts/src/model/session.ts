import { assistantText, awaySummaryText, parseIsoTs, recordType, userText } from './record.ts';

/**
 * One session, reduced to what a search and a result row need.
 *
 * **`absorbLines` is a fold, and that is the whole design.** Session files are
 * append-only, so re-reading one that gained 3 KB should cost 3 KB — and the way
 * to guarantee the incremental path agrees with the cold path is to have only one
 * path. There is no `parseWholeFile` beside this; a cold parse is a fold over an
 * empty digest.
 */

export interface Turn {
  readonly source: 'user' | 'assistant' | 'recap';
  readonly ts: number | null;
  readonly text: string;
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
}

export function emptyDigest(sessionId: string): SessionDigest {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    recap: null,
    recapTs: null,
    firstTs: null,
    lastTs: null,
    userTurns: 0,
    assistantTurns: 0,
    turns: [],
  };
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

/** A record's string field, or null — the shape every optional field here has. */
function stringField(rec: unknown, key: string): string | null {
  const value = (rec as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Fold a chunk of JSONL text into a digest.
 *
 * **A trailing partial line is dropped, not parsed.** The caller may hand us
 * bytes from a file an agent is writing to right now, so the last line can be
 * half a record; only a terminating newline says a line is complete. Those bytes
 * are re-read next time because the caller's offset advances only past what was
 * consumed — see `completeBytes` in `store.ts`, which is the other half of this
 * contract.
 */
export function absorbLines(base: SessionDigest, chunk: string): SessionDigest {
  let cwd = base.cwd;
  let gitBranch = base.gitBranch;
  let aiTitle = base.aiTitle;
  let customTitle = base.customTitle;
  let agentName = base.agentName;
  let recap = base.recap;
  let recapTs = base.recapTs;
  let firstTs = base.firstTs;
  let lastTs = base.lastTs;
  let userTurns = base.userTurns;
  let assistantTurns = base.assistantTurns;
  const turns: Turn[] = [...base.turns];

  const lines = chunk.split('\n');
  // The tail after the final newline is incomplete by definition. A chunk that
  // ends ON a newline leaves an empty final element, which this also drops.
  lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const type = recordType(rec);
    if (type === 'ai-title') {
      aiTitle = stringField(rec, 'aiTitle') ?? aiTitle;
      continue;
    }
    if (type === 'custom-title') {
      customTitle = stringField(rec, 'customTitle') ?? customTitle;
      continue;
    }
    if (type === 'agent-name') {
      agentName = stringField(rec, 'agentName') ?? agentName;
      continue;
    }

    const ts = parseIsoTs((rec as { timestamp?: unknown }).timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    const summary = awaySummaryText(rec);
    if (summary !== null) {
      if (recapTs === null || (ts !== null && ts >= recapTs)) {
        recap = summary;
        recapTs = ts;
      }
      turns.push({ source: 'recap', ts, text: summary });
      continue;
    }

    cwd ??= stringField(rec, 'cwd');
    gitBranch ??= stringField(rec, 'gitBranch');

    const asUser = userText(rec);
    if (asUser !== null) {
      userTurns += 1;
      turns.push({ source: 'user', ts, text: asUser });
      continue;
    }

    const asAssistant = assistantText(rec);
    if (asAssistant !== null) {
      assistantTurns += 1;
      turns.push({ source: 'assistant', ts, text: asAssistant });
    }
  }

  return {
    sessionId: base.sessionId,
    cwd,
    gitBranch,
    aiTitle,
    customTitle,
    agentName,
    recap,
    recapTs,
    firstTs,
    lastTs,
    userTurns,
    assistantTurns,
    turns,
  };
}
