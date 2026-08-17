import type { SessionDigest, Turn } from '../model/session.ts';
import type { ParsedSession } from './session.ts';

/**
 * The search projection — and the ONLY producer of a digest.
 *
 * Search used to be its own reader of the file format. It is a derivation now,
 * which is what makes it impossible for a search result and a rendered
 * transcript to disagree about what a session says.
 *
 * **Tool calls and tool output are excluded.** That is the 97% the index exists
 * not to hold: 469 MB of session files reduce to about 15 MB of conversation,
 * and the digest is what gets written to `ctx.dataDir`.
 */
export function digestOf(session: ParsedSession): SessionDigest {
  const turns: Turn[] = [];

  for (const message of session.messages) {
    // Machinery is marked on the message and dropped HERE — the parser keeps it
    // so a consumer that wants it can have it.
    if (message.isHarnessNoise) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    if (text === '') continue;

    /**
     * A compact summary files as a recap, not as a user turn.
     *
     * Nobody typed it, so calling it `user` misattributes it — but it is the
     * same kind of thing a `/recap` away-summary is, a model-written précis of
     * earlier conversation, and after a compaction it is the only copy of that
     * conversation left. Searchable, and honestly labelled.
     */
    const source = message.isCompactSummary ? 'recap' : message.role;
    turns.push({ source, ts: message.ts, text, seq: message.seq });
  }

  for (const recap of session.recaps) {
    turns.push({ source: 'recap', ts: recap.ts, text: recap.text, seq: recap.seq });
  }

  // File order, because that is the order a person read them in — and a recap
  // belongs where it was written, not appended after every turn.
  turns.sort((a, b) => a.seq - b.seq);

  const latest = session.recaps.at(-1) ?? null;

  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    aiTitle: session.aiTitle,
    customTitle: session.customTitle,
    agentName: session.agentName,
    recap: latest?.text ?? null,
    recapTs: latest?.ts ?? null,
    firstTs: session.firstTs,
    lastTs: session.lastTs,
    userTurns: turns.filter((turn) => turn.source === 'user').length,
    assistantTurns: turns.filter((turn) => turn.source === 'assistant').length,
    turns,
    models: Object.keys(session.usage.byModel).filter((model) => model !== 'unknown'),
    usage: session.usage,
  };
}
