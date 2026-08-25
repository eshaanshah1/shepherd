/**
 * The last thing an agent SAID, out of the tail of its transcript.
 *
 * This is the read half of the task rail's second line — the one that finishes
 * the sentence its state mark starts (ready → *with what result*, failed →
 * *why*). The write half is the instruction Shepherd puts in every task root's
 * generated `CLAUDE.md`, asking for a closing summary sentence.
 *
 * It lives in the VENDOR's extension because everything about it is vendor
 * knowledge: that a transcript is JSONL, that a record has a `type`, that an
 * assistant message's content is an array of typed blocks. `tasks` asks
 * `agents.lastSaid` and never learns any of it (D11).
 *
 * Pure — a string in, a string or null out. The IO around it is `kind.ts`'s.
 */

/**
 * How much of the tail is worth reading.
 *
 * A transcript grows without bound and the answer is always in the last record,
 * so the read is a bounded window rather than a parse of the file. 64KB is far
 * more than one assistant turn and far less than a file anyone would notice
 * reading — and a window that lands mid-record costs nothing, because the walk
 * below discards any line it cannot parse.
 */
export const TAIL_BYTES = 64 * 1024;

/**
 * The last assistant message's text, from a chunk of transcript JSONL.
 *
 * Walks BACKWARDS and stops at the first hit: the answer is at the end by
 * construction, and a forward walk would parse the whole window to reach it.
 *
 * The first line of a tail-read window is usually a fragment, so an unparseable
 * line is skipped rather than treated as the end of the data. That is also what
 * makes this safe against a record written while we were reading it.
 */
export function lastAssistantText(chunk: string): string | null {
  const lines = chunk.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === '' || !line.startsWith('{')) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantTextOf(record);
    if (text !== null) return text;
  }
  return null;
}

/** One record's assistant text, or null if it is not an assistant message. */
function assistantTextOf(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const rec = record as Record<string, unknown>;
  if (rec['type'] !== 'assistant') return null;

  const message = rec['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];

  // A string content is the older shape and still appears in exports.
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (!Array.isArray(content)) return null;

  /*
   * TEXT blocks only. A turn that ended in a tool call has `tool_use` blocks
   * after its prose, and thinking blocks are not something the agent said to
   * anyone — surfacing either on a task row would be showing the machinery.
   */
  const parts = content
    .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
    .filter((block) => block['type'] === 'text')
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((text) => text.trim() !== '');

  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * The longest a closing sentence may be before it stops being one.
 *
 * Generous, because the gate below is meant to reject the WRONG SHAPE rather
 * than to enforce brevity — a long sentence is a bad summary, but a paragraph is
 * not a summary at all, and the row truncates what it cannot fit anyway.
 */
export const MAX_SUMMARY = 200;

/**
 * The closing summary sentence, or null if the last line is not one.
 *
 * **The gate exists because the instruction can lapse.** It is written into the
 * task root's `CLAUDE.md`, which is read into the system prompt once at session
 * start — so on a long session, or after a compaction, an agent will sometimes
 * end a turn the way it would have anyway. The rail must then say NOTHING rather
 * than show whatever was at the bottom.
 *
 * That is the whole reason this is shape-checked rather than taken as-is. The
 * alternative was asking for a `TL;DR:` marker, which is unambiguous and reads
 * as a machine affordance in every response a human sees in the terminal — so
 * the cost of not having one is paid here instead.
 *
 * A line is rejected when it is structure rather than prose: a heading, a list
 * item, a table row, a code fence, a quote. Also when it ends in a colon (that
 * is a line introducing something that follows) or a question mark — a question
 * is the agent needing you, and that is what the WAITING mark and the card's own
 * question block are for, so answering it here would say it twice.
 */
export function summaryOf(text: string | null): string | null {
  if (text === null) return null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;

  // Structure, not prose.
  if (/^([#>|]|[-*+]\s|\d+[.)]\s|```|---|===)/.test(last)) return null;
  if (last.endsWith(':')) return null;
  if (last.endsWith('?')) return null;
  if (last.length > MAX_SUMMARY) return null;

  /*
   * Emphasis stripped, not because it is wrong to write but because the row
   * draws text and would show the asterisks. Inline code keeps its content and
   * loses its backticks for the same reason.
   */
  const plain = last
    .replaceAll(/\*\*(.+?)\*\*/g, '$1')
    .replaceAll(/\*(.+?)\*/g, '$1')
    .replaceAll(/`(.+?)`/g, '$1')
    .trim();

  /*
   * A line with no letter and no digit is not a sentence, whatever is left of
   * it. Checked rather than testing for empty, because stripping paired markers
   * out of an unpaired run (`***`) leaves a stray marker rather than nothing.
   */
  return /[\p{L}\p{N}]/u.test(plain) ? plain : null;
}

/** The whole read, as one pure step: transcript tail → what to draw. */
export const lastSaid = (chunk: string): string | null => summaryOf(lastAssistantText(chunk));
