import { lifecycleOf, type Lifecycle } from '../model/lifecycle.ts';
import { toMessage, type TranscriptMessage, type Usage } from '../model/message.ts';
import { asRecord, awaySummaryText, parseIsoTs, recordType, stringOrNull } from '../model/record.ts';
import {
  dedupeKeyOf,
  emptyRollup,
  maxUsage,
  subtractUsage,
  withUsage,
  type UsageRollup,
} from '../model/usage.ts';

/**
 * The one fold. A cold parse is a fold over an empty session.
 *
 * There is deliberately no `parseWholeFile` beside this: the way to guarantee
 * the incremental path agrees with the cold path is to have only one path.
 *
 * **A trailing partial line is dropped, not parsed.** The caller may hand over
 * bytes an agent is writing right now, so the last line can be half a record;
 * only a terminating newline says a line is complete. `completeBytes` is the
 * other half of that contract, and a caller whose offset advances past it will
 * skip those bytes forever rather than re-read them once the rest lands.
 */

export interface Recap {
  readonly seq: number;
  readonly ts: number | null;
  readonly text: string;
}

export interface UnknownRecord {
  readonly seq: number;
  readonly type: string;
}

export interface ParsedSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly aiTitle: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  readonly messages: readonly TranscriptMessage[];
  readonly recaps: readonly Recap[];
  /**
   * Types this parser does not decode, kept rather than discarded.
   *
   * Thirteen record types occur in a real corpus and this understands six.
   * Silently dropping the rest is how a format parser rots: the next Claude Code
   * release adds a type and nothing anywhere says so. One object each, invisible
   * to any consumer that does not ask.
   */
  readonly unknown: readonly UnknownRecord[];
  readonly lifecycle: Lifecycle | null;
  readonly usage: UsageRollup;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly records: number;
  /**
   * The dedupe group still open at the end of the chunk.
   *
   * ONE slot, not a map: measured across twelve large sessions, duplicate
   * `message.id` rows are always CONSECUTIVE — zero non-adjacent repeats. A
   * group therefore closes the moment a different key arrives, and nothing has
   * to carry a per-key table.
   *
   * Its contribution IS already folded into `usage`, so a reader between chunks
   * sees a true total. A chunk that continues the group backs it out first.
   */
  readonly pendingKey: string | null;
  readonly pendingUsage: Usage | null;
  readonly pendingModel: string | null;
}

/** The six types this decodes. Anything else is recorded as unknown. */
const KNOWN_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'ai-title',
  'custom-title',
  'agent-name',
]);

export function emptySession(sessionId: string, filePath: string): ParsedSession {
  return {
    sessionId,
    filePath,
    cwd: null,
    gitBranch: null,
    version: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    messages: [],
    recaps: [],
    unknown: [],
    lifecycle: null,
    usage: emptyRollup(),
    firstTs: null,
    lastTs: null,
    records: 0,
    pendingKey: null,
    pendingUsage: null,
    pendingModel: null,
  };
}

/**
 * How many bytes of `chunk` end in a complete line.
 *
 * `absorb` drops the tail after the last newline, so a caller's offset must stop
 * there too.
 */
export function completeBytes(chunk: string): number {
  const lastBreak = chunk.lastIndexOf('\n');
  return lastBreak === -1 ? 0 : Buffer.byteLength(chunk.slice(0, lastBreak + 1));
}

export function absorb(base: ParsedSession, chunk: string): ParsedSession {
  let { cwd, gitBranch, version, aiTitle, customTitle, agentName } = base;
  let { lifecycle, firstTs, lastTs, records } = base;
  let usage = base.usage;
  let pendingKey = base.pendingKey;
  let pendingUsage = base.pendingUsage;
  let pendingModel = base.pendingModel;

  const messages: TranscriptMessage[] = [...base.messages];
  const recaps: Recap[] = [...base.recaps];
  const unknown: UnknownRecord[] = [...base.unknown];

  // The previous chunk settled its open group so a reader between chunks saw a
  // true total. Back that contribution out now; if this chunk continues the
  // group it is re-folded at its new maximum, and if it does not, the settle at
  // the end puts back exactly what was removed.
  if (pendingKey !== null && pendingUsage !== null) {
    usage = subtractUsage(usage, pendingModel, pendingUsage);
  }

  /** Fold the open group's final (maximal) usage into the rollup. */
  const settle = (): void => {
    if (pendingKey === null || pendingUsage === null) return;
    usage = withUsage(usage, pendingModel, pendingUsage);
  };

  const lines = chunk.split('\n');
  // The tail after the final newline is incomplete by definition. A chunk that
  // ends ON a newline leaves an empty final element, which this also drops.
  lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    const seq = records;
    records += 1;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const type = recordType(rec);
    const record = asRecord(rec);

    if (type === 'ai-title') {
      aiTitle = stringOrNull(record?.aiTitle) ?? aiTitle;
      continue;
    }
    if (type === 'custom-title') {
      customTitle = stringOrNull(record?.customTitle) ?? customTitle;
      continue;
    }
    if (type === 'agent-name') {
      agentName = stringOrNull(record?.agentName) ?? agentName;
      continue;
    }

    const ts = parseIsoTs(record?.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    cwd ??= stringOrNull(record?.cwd);
    gitBranch ??= stringOrNull(record?.gitBranch);
    version ??= stringOrNull(record?.version);

    const summary = awaySummaryText(rec);
    if (summary !== null) {
      recaps.push({ seq, ts, text: summary });
      continue;
    }

    if (type !== null && !KNOWN_TYPES.has(type)) {
      unknown.push({ seq, type });
      continue;
    }

    const next = lifecycleOf(rec, seq);
    if (next !== null) lifecycle = next;

    const message = toMessage(rec, seq);
    if (message === null) continue;
    messages.push(message);

    if (message.usage === null) continue;

    const key = dedupeKeyOf(message);
    if (key !== pendingKey) {
      settle();
      pendingKey = key;
      pendingModel = message.model;
      pendingUsage = message.usage;
      continue;
    }
    pendingUsage = pendingUsage === null ? message.usage : maxUsage(pendingUsage, message.usage);
  }

  // Settle before returning, so `usage` is true for anyone reading between
  // chunks. The next call backs this out before continuing the group.
  settle();

  return {
    sessionId: base.sessionId,
    filePath: base.filePath,
    cwd,
    gitBranch,
    version,
    aiTitle,
    customTitle,
    agentName,
    messages,
    recaps,
    unknown,
    lifecycle,
    usage,
    firstTs,
    lastTs,
    records,
    pendingKey,
    pendingUsage,
    pendingModel,
  };
}
