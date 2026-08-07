import type { Caller } from './caller.ts';

/**
 * The metadata every event carries beside its payload.
 *
 * `seq` is **per source**, and it is the whole reason this type exists. v1's
 * hook channel had no sequence number, so a `PreToolUse` arriving after the
 * `PermissionRequest` it precedes would overwrite `blocked` with `working` —
 * silently, with no re-notification and, worse, **no way to detect that it had
 * happened**. A per-source counter does not prevent reordering; it makes
 * reordering *visible*, which is the part that was missing.
 */
export interface Envelope {
  /** Monotonic per source, starting at 1. A gap or a repeat is a real finding. */
  readonly seq: number;
  /** Injected clock, never `Date.now()`. */
  readonly ts: number;
  readonly source: Caller;
}

/**
 * What a subscriber can conclude about ordering, given the last seq it saw.
 * `duplicate` and `gap` are separate answers because they need different
 * responses: a duplicate is dropped, a gap is *logged* and processed anyway
 * (refusing the event would turn a lost message into two lost messages).
 */
export type SeqVerdict = 'in-order' | 'duplicate' | 'gap';

export function seqVerdict(lastSeen: number | undefined, seq: number): SeqVerdict {
  if (lastSeen === undefined) return 'in-order';
  if (seq <= lastSeen) return 'duplicate';
  return seq === lastSeen + 1 ? 'in-order' : 'gap';
}
