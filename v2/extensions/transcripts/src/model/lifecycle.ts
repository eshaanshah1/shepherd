import { toMessage } from './message.ts';
import { asRecord, parseIsoTs, stringOrNull } from './record.ts';

/**
 * The transcript's own account of whether a turn is running.
 *
 * A second opinion on agent state, independent of hooks — which matters because
 * `CLAUDE.md` says of the daemon's sweep: "the sweep detects *claude exited*,
 * not *the turn ended* … Do not reach for it as a corrector."
 *
 * This file produces the signal and takes NO position on whether it outranks a
 * hook. That precedence question belongs beside ADR 0004's ordering guard.
 */

export type LifecycleState = 'working' | 'completed' | 'interrupted';

export interface Lifecycle {
  readonly state: LifecycleState;
  readonly turnId: string;
  readonly ts: number | null;
}

const TERMINAL = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']);

const INTERRUPT_PREFIX = '[request interrupted';

function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_use');
}

function hasRenderable(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const rec = asRecord(block);
    if (rec === null) return false;
    if (rec.type === 'thinking' || rec.type === 'redacted_thinking') return true;
    return rec.type === 'text' && typeof rec.text === 'string' && rec.text.trim() !== '';
  });
}

export function lifecycleOf(rec: unknown, seq: number): Lifecycle | null {
  const record = asRecord(rec);
  if (record === null) return null;

  const ts = parseIsoTs(record.timestamp);
  const message = asRecord(record.message);

  if (record.type === 'assistant') {
    const stop = message?.stop_reason;
    /**
     * The backup clause is the load-bearing half.
     *
     * Rows that omit `stop_reason` do occur, so "no reason" cannot mean "not
     * done" outright. But a row carrying a `tool_use` is mid-turn whatever else
     * it says — reading it as finished settles the indicator before the tool has
     * even run, and the next tool result then reopens a turn that never closed.
     */
    const terminal =
      (typeof stop === 'string' && TERMINAL.has(stop)) ||
      ((stop === undefined || stop === null) &&
        hasRenderable(message?.content) &&
        !hasToolUse(message?.content));
    if (!terminal) return null;

    return {
      state: 'completed',
      turnId: stringOrNull(record.uuid) ?? stringOrNull(message?.id) ?? `#${seq}`,
      ts,
    };
  }

  if (record.type !== 'user') return null;

  // Decoded rather than read raw, so a tool-result row is already role `tool`
  // and cannot be mistaken for somebody starting a turn.
  const decoded = toMessage(rec, seq);
  if (decoded === null || decoded.role !== 'user') return null;

  const text = decoded.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trimStart()
    .toLowerCase();

  if (text.startsWith(INTERRUPT_PREFIX)) {
    return { state: 'interrupted', turnId: decoded.uuid, ts };
  }
  // Harness noise fires a user turn without being one. Treating it as working
  // overwrites a real terminal marker and re-sticks the spinner.
  if (decoded.isHarnessNoise) return null;

  return { state: 'working', turnId: decoded.uuid, ts };
}
