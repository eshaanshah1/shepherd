/**
 * What a pill reads, for each vendor and for each way of not knowing.
 *
 * Pure, and separate from the resolver, because these are the strings a person
 * looks at — the one part of this extension whose correctness is a judgement
 * about reading rather than about a protocol.
 */

/** Room for a summary beside a key, before the pill stops reading as a word. */
export const SUMMARY_MAX = 60;

export function jiraLabel(key: string, summary?: string): string {
  const collapsed = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return key;
  const short =
    collapsed.length <= SUMMARY_MAX
      ? collapsed
      : `${collapsed.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  return `${key} ${short}`;
}

/**
 * What a Slack pill reads, which is a constant.
 *
 * The permalink does carry a timestamp — `p1724500000123456` is epoch seconds
 * and microseconds — and an earlier version put its date here. It came out as
 * `Slack thread · 24 Aug`, and the date read as though something had been looked
 * up when nothing had: it says when the message was posted and NOTHING about
 * which message, in which channel, from whom. A fact that specific, offered
 * alone, invites you to trust the rest of the pill more than it has earned.
 *
 * The channel id and the timestamp are still parsed and still on `ParsedLink`.
 * They cost nothing, and they are exactly what a real resolver would need.
 */
export function slackLabel(): string {
  return 'Slack thread';
}
