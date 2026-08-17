import type { TranscriptMessage, Usage } from './message.ts';

/**
 * Tokens, counted once.
 *
 * **Claude re-streams an assistant row under the same `message.id`.** Measured
 * on one real session: 434 assistant records, 203 distinct message ids. Summing
 * every row gives 732,808 output tokens where the deduped total is 273,005 —
 * an over-count of 2.7x. A usage number produced without this is not
 * approximately right, it is fiction.
 *
 * The later row wins PER FIELD rather than wholesale, because a duplicate can
 * carry a fuller `usage` than the one before it while omitting another field
 * entirely, and an omission reads as 0.
 */

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface UsageRollup {
  readonly byModel: Readonly<Record<string, Usage>>;
  readonly total: Usage;
}

/**
 * The strongest stable identity the row carries.
 *
 * A fork rewrites `sessionId` but keeps the message and request ids, so this
 * ordering is also what keeps a forked history from double-counting.
 */
export function dedupeKeyOf(message: TranscriptMessage): string | null {
  if (message.messageId !== null && message.requestId !== null) {
    return `${message.messageId}:${message.requestId}`;
  }
  if (message.messageId !== null) return `msg:${message.messageId}`;
  return `uuid:${message.uuid}`;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function maxUsage(a: Usage, b: Usage): Usage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  };
}

export function emptyRollup(): UsageRollup {
  return { byModel: {}, total: ZERO_USAGE };
}

export function withUsage(rollup: UsageRollup, model: string | null, usage: Usage): UsageRollup {
  const key = model ?? 'unknown';
  return {
    byModel: { ...rollup.byModel, [key]: addUsage(rollup.byModel[key] ?? ZERO_USAGE, usage) },
    total: addUsage(rollup.total, usage),
  };
}

/**
 * The exact inverse of `withUsage`.
 *
 * It exists for one caller: a chunk boundary. `absorb` settles its open dedupe
 * group so a reader between chunks sees a true total, and the next chunk backs
 * that contribution out before re-folding the group it continues. Without the
 * inverse, a group split across chunks would be counted twice.
 */
export function subtractUsage(rollup: UsageRollup, model: string | null, usage: Usage): UsageRollup {
  const key = model ?? 'unknown';
  const less = (a: Usage, b: Usage): Usage => ({
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
  });
  return {
    byModel: { ...rollup.byModel, [key]: less(rollup.byModel[key] ?? ZERO_USAGE, usage) },
    total: less(rollup.total, usage),
  };
}
