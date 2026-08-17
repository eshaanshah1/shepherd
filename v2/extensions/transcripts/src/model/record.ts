/**
 * One JSONL record → the text a person actually said or read.
 *
 * Ported from `recall.py`'s record filters, and the filtering IS the feature:
 * measured on a real corpus, 481 MB of session files hold 14.8 MB of
 * conversation — tool calls and tool output are the other 97%. Everything
 * downstream of this file operates on the 3%.
 *
 * Every function takes `unknown`. A record is a line of somebody else's file
 * format, so a cast here would be a promise this code cannot keep.
 */

const RECAP_TAIL = /\s*\(disable recaps in \/config\)\s*$/;

/** A well-formed record's `type`, or null for anything that is not an object. */
export function recordType(rec: unknown): string | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const type = (rec as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function messageOf(rec: unknown): Record<string, unknown> | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const message = (rec as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  return message as Record<string, unknown>;
}

/**
 * The user's typed text, or null if this is not a real user turn.
 *
 * Three things wear the `user` type and are not: a tool_result record (whose
 * `content` is a LIST of blocks rather than a string — which is the whole test),
 * a hook or system-reminder stub, and the echo of a slash command's output.
 */
export function userText(rec: unknown): string | null {
  if (recordType(rec) !== 'user') return null;
  const message = messageOf(rec);
  if (message === null || message.role !== 'user') return null;
  const content = message.content;
  if (typeof content !== 'string') return null;

  const text = content.trim();
  if (text === '') return null;

  // A record whose every character sits inside a tag pair is machinery. One that
  // merely CONTAINS a tag is a person who pasted something, and is kept whole.
  const withoutTags = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
  if (withoutTags === '') return null;

  if (text.startsWith('<local-command-stdout>') && text.includes('</local-command-stdout>')) {
    return null;
  }
  return text;
}

/** Every `text` block of an assistant turn, joined. Thinking is not text. */
export function assistantText(rec: unknown): string | null {
  if (recordType(rec) !== 'assistant') return null;
  const message = messageOf(rec);
  if (message === null || !Array.isArray(message.content)) return null;

  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== 'text' || typeof typed.text !== 'string') continue;
    const text = typed.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** A `/recap` away-summary, with the UI trailer removed. */
export function awaySummaryText(rec: unknown): string | null {
  if (recordType(rec) !== 'system') return null;
  const typed = rec as { subtype?: unknown; content?: unknown };
  if (typed.subtype !== 'away_summary' || typeof typed.content !== 'string') return null;
  const text = typed.content.replace(RECAP_TAIL, '').trim();
  return text === '' ? null : text;
}

/** An ISO stamp → epoch ms. Null rather than NaN, so a caller cannot compare junk. */
export function parseIsoTs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
