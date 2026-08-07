import type { AttentionLevel } from '@shepherd/sdk';

/**
 * Where an attention transition goes — pure, no IO, ported from v1's
 * `NotificationRoutingPolicy`.
 *
 * `viewing` is threaded IN, never re-derived here: it is `ViewingResolver`'s
 * single value (ADR 0020), and a policy that recomputed it from its own idea of
 * focus is exactly the second visibility check that invariant forbids.
 *
 * The reason string is composed on **every** branch. v1's log line exists because
 * "I heard nothing on my phone" is otherwise unanswerable: push is deliberately
 * suppressed unless this Mac is away, and nothing recorded which branch ran.
 */

export interface RoutingInput {
  readonly level: AttentionLevel;
  /** From the one predicate. Never computed in this file. */
  readonly viewing: boolean;
  readonly appActive: boolean;
  /** Presence-sensed (v1: lid shut, no external display). Gates the phone. */
  readonly away: boolean;
  readonly turnFinished: boolean;
}

export interface RoutingDecision {
  readonly banner: boolean;
  readonly chime: boolean;
  readonly push: boolean;
  readonly badge: boolean;
  /** Why, for the log line. Never empty. */
  readonly reason: string;
}

/**
 * The ONE predicate for "this pane needs you" — shared by the dock badge and the
 * ⌘⇧A ring, deliberately, so a badge can never count a pane the ring cannot reach.
 *
 * `info` is out: CLAUDE.md's rule for v1's nudges is that a condition (a stopped
 * rebase, unresolved threads) is not an event and is always downstream of
 * something that already alerted. It reaches the dot via `AttentionStore.aggregate`
 * and nothing else. If that ever changes, it changes here, once.
 */
export function wantsAttention(level: AttentionLevel): boolean {
  return level === 'attention' || level === 'urgent';
}

const NOTHING = { banner: false, chime: false, push: false, badge: false } as const;

export function route(input: RoutingInput): RoutingDecision {
  const { level, viewing, appActive, away, turnFinished } = input;
  const turn = turnFinished ? 'a finished turn' : 'a state change';

  if (level === 'none') {
    return { ...NOTHING, reason: `level none: nothing to route (${turn})` };
  }

  // A shut lid is not a pair of eyes. In v1 this filter lived in `isViewing` AND
  // here; in v2 `Presence` carries no `away`, so this is the ONLY place it can
  // live. Without it: `appActive` and front-ness both stay true in clamshell, so a
  // turn finishing there suppresses the banner (right — nobody can see it) and the
  // phone push (wrong — that is the only surface left, and the one moment the
  // phone exists for).
  const seen = viewing && !away;
  if (seen) {
    return { ...NOTHING, reason: `viewing that pane: ${turn} under your eyes is not an event` };
  }

  if (!wantsAttention(level)) {
    // `info` is a condition, not an event: no banner, no chime, no push, no badge.
    return { ...NOTHING, reason: `level info: a condition, so the dot only (${turn})` };
  }

  if (away) {
    return {
      banner: false,
      chime: false,
      push: true,
      badge: true,
      reason: `away: ${level} on ${turn} goes to the phone`,
    };
  }

  // Present but not looking at that pane. Note `appActive` changes nothing here,
  // and that is deliberate rather than an oversight: a banner is what pulls you
  // back from another app, and it is also what you want when Shepherd is frontmost
  // but you are reading a different pane. It stays an input because the reason
  // string is the record of which situation produced the alert.
  return {
    banner: true,
    chime: true,
    push: false,
    badge: true,
    reason: `${appActive ? 'at the machine' : 'in another app'}, not viewing that pane: ${level} on ${turn} banners and chimes`,
  };
}
