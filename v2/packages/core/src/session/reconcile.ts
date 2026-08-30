import type { SessionID } from '@shepherd/sdk';

/**
 * Claim-and-verify (ADR 0036), as a **client's connect ritual** rather than a
 * startup special case (ADR 0052).
 *
 * 0036's insight was that a restored pane's `sessionId` is a *claim*, settled by
 * the process that actually holds the ptys. It implemented that inside the
 * layout's restore, which was the only client and the only moment. Both of those
 * stopped being true: a second client has bindings of its own, and it arrives
 * whenever it arrives — a phone waking up, a TUI started an hour later, this app
 * relaunching. So the check is a verb any client runs when it connects, and the
 * three answers 0036 named are the three fields below.
 *
 * Pure, and it takes the authority's answer rather than asking: the caller knows
 * whether "live" means a local `SessionHost` or a daemon a socket away, and this
 * file must not learn.
 */

export interface SessionClaim {
  /** The client's own name for where it is showing the session. Opaque here. */
  readonly pane: string;
  readonly session: SessionID;
}

export interface ReconcileInput {
  /** What the connecting client believes it is showing. */
  readonly claims: readonly SessionClaim[];
  /** Every session the authority says is alive. */
  readonly live: readonly SessionID[];
  /**
   * Sessions somebody ELSE already holds.
   *
   * Without it every session another client is showing would come back as an
   * orphan, and an orphan is a thing something is expected to adopt or reap —
   * so the omission would be a licence to kill another client's agent.
   */
  readonly held: readonly SessionID[];
}

export interface ReconcileOutcome {
  /** Claims the authority confirmed. The client may attach to these. */
  readonly adopted: readonly SessionClaim[];
  /** Claims that named a session which is gone. The client creates instead. */
  readonly dropped: readonly SessionClaim[];
  /**
   * Live sessions nobody claims — ADR 0036's third case, listed rather than
   * leaked. Nothing here reaps one: what to do about an orphan is a decision
   * with a UI attached, and inventing it ahead of a caller is what ADR 0031
   * declines to do.
   */
  readonly orphans: readonly SessionID[];
}

export function reconcile(input: ReconcileInput): ReconcileOutcome {
  const live = new Set(input.live);
  const adopted: SessionClaim[] = [];
  const dropped: SessionClaim[] = [];
  const taken = new Set<SessionID>();

  for (const claim of input.claims) {
    // A second pane claiming a session the first already got is dropped, not
    // adopted: two views on one pty with neither knowing is the defect
    // `pane-sessions.ts` records, arriving through the front door.
    if (!live.has(claim.session) || taken.has(claim.session)) {
      dropped.push(claim);
      continue;
    }
    taken.add(claim.session);
    adopted.push(claim);
  }

  const spokenFor = new Set<SessionID>([...taken, ...input.held]);
  return {
    adopted,
    dropped,
    orphans: input.live.filter((session) => !spokenFor.has(session)),
  };
}
