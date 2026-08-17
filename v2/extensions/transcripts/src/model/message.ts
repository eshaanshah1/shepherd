import { contentBlocks, type Block } from './blocks.ts';
import { isHarnessInjectedText } from './noise.ts';
import { asRecord, parseIsoTs, stringOrNull } from './record.ts';

/**
 * One record → one message.
 *
 * The whole conversation, not the 3% search keeps. What this refuses is only
 * what is not a turn at all; everything a turn contains is carried, and the
 * judgements a consumer might disagree with are exposed as flags rather than
 * applied here.
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TranscriptMessage {
  /** Position of the record in the file. Stable ordering, and the fallback id. */
  readonly seq: number;
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly role: Role;
  readonly blocks: readonly Block[];
  readonly ts: number | null;
  readonly model: string | null;
  readonly messageId: string | null;
  readonly requestId: string | null;
  readonly usage: Usage | null;
  readonly isMeta: boolean;
  readonly isCompactSummary: boolean;
  /**
   * True on records inside a subagent transcript. Read, never relied on to
   * FIND one: measured, it is true in 145 of 146 subagent files and 0 of 720
   * parents, so it labels a sidechain from the inside and points at nothing.
   */
  readonly isSidechain: boolean;
  /**
   * Harness machinery wearing a user turn.
   *
   * Marked rather than dropped: a consumer rendering a conversation wants it
   * hidden, a consumer debugging one wants it shown, and the parser has no
   * business picking. `digestOf` is where search makes its choice.
   */
  readonly isHarnessNoise: boolean;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function usageOf(message: unknown): Usage | null {
  const usage = asRecord(asRecord(message)?.usage);
  if (usage === null) return null;

  const out: Usage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  // All-zero is not usage. A row reporting nothing would otherwise open a dedupe
  // group and hold it against the row that actually carries the numbers.
  return out.input + out.output + out.cacheRead + out.cacheWrite === 0 ? null : out;
}

function textOf(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function toMessage(rec: unknown, seq: number): TranscriptMessage | null {
  const record = asRecord(rec);
  if (record === null) return null;
  if (record.type !== 'user' && record.type !== 'assistant') return null;

  const message = asRecord(record.message);
  const isMeta = record.isMeta === true || record.isSynthetic === true;
  const isCompactSummary = record.isCompactSummary === true;

  const decoded = contentBlocks(message?.content);
  // An injected turn's prose is machinery, but a tool result inside one is
  // genuine output — dropping the whole record loses real work.
  const blocks =
    record.type === 'user' && (isMeta || isCompactSummary)
      ? decoded.filter((block) => block.type === 'tool-result')
      : decoded;
  if (blocks.length === 0) return null;

  // The harness handing output back to the model is not a person speaking.
  const onlyToolResults = blocks.every((block) => block.type === 'tool-result');
  const role: Role = record.type === 'assistant' ? 'assistant' : onlyToolResults ? 'tool' : 'user';

  return {
    seq,
    uuid: stringOrNull(record.uuid) ?? `#${seq}`,
    parentUuid: stringOrNull(record.parentUuid),
    role,
    blocks,
    ts: parseIsoTs(record.timestamp),
    model: stringOrNull(message?.model),
    messageId: stringOrNull(message?.id),
    requestId: stringOrNull(record.requestId),
    usage: usageOf(message),
    isMeta,
    isCompactSummary,
    isSidechain: record.isSidechain === true,
    isHarnessNoise: role === 'user' && isHarnessInjectedText(textOf(blocks)),
  };
}
