/**
 * What an agent session can be, and what folding one event into it produces.
 *
 * **Vendor-blind on purpose.** No Claude event name appears in this file, and no
 * other vendor's either: a kind maps its own protocol onto these states, which is
 * what lets `codex` or `opencode` be a third-party extension rather than a fork
 * (sketch §7c). The Claude half lives in `claude-code`'s `stop-policy.ts`.
 *
 * This is also deliberately NOT `AttentionLevel`. Core's attention channel is
 * `none | info | attention | urgent` — it has no `working` and no `idle`, because
 * it answers "how much do you need the user" rather than "what is this agent
 * doing". Conflating them would put `working` on the dock badge. The mapping
 * between the two is one function, and it lives with the registry that owns it.
 */

/**
 * A union over a frozen array rather than an `enum`: `erasableSyntaxOnly` is on
 * (Electron type-strips the main entry, and stripping can only erase), so an
 * `enum` here is a *launch* failure that a passing test suite would not catch.
 */
export const AGENT_STATES = ['shell', 'idle', 'working', 'blocked', 'needsCheck', 'error'] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/**
 * The result of folding one event into a session's state.
 *
 * `applied: false` means the event was **ignored**, and the caller must leave the
 * state alone rather than writing `state` back — that is how the ordering guard
 * survives (see `applyEvent`).
 */
export interface StateTransition {
  readonly state: AgentState;
  /** Shown to the user: "answer needed", never "state 3". */
  readonly reason?: string;
  /** Drop a shell-set title so the agent's own can replace it. */
  readonly clearTitle: boolean;
  /** False = this event changed nothing and the state must not be written. */
  readonly applied: boolean;
  /**
   * A turn-ending event was held at `working` because background work it is
   * paused on is still in flight (ADR 0015). Drives a log line only.
   */
  readonly heldForBackground: boolean;
  /**
   * **The turn actually ended here** — whether that reads as `needsCheck` or, when
   * the user was already watching, as `idle`.
   *
   * Anything keyed off "a turn finished" must read this and never
   * `state === 'needsCheck'`, which misses the viewing landing entirely. v1
   * records this twice in CLAUDE.md because it was got wrong twice.
   */
  readonly turnFinished: boolean;
}

/**
 * Pulls the user in: the ⌘⇧A ring, the dock badge, an alert.
 *
 * Note this is the *agent-state* predicate and core has a same-named one over
 * `AttentionLevel`. They are different questions in different domains, and the
 * function that maps this onto that is the only place they meet.
 */
export function wantsAttention(state: AgentState): boolean {
  return state === 'blocked' || state === 'needsCheck' || state === 'error';
}

/** Actively working, or waiting on you. An acknowledged idle agent is neither. */
export function isBusy(state: AgentState): boolean {
  return state === 'working' || wantsAttention(state);
}

/** A plain terminal is not an agent. Everything else is one. */
export function isAgent(state: AgentState): boolean {
  return state !== 'shell';
}

/**
 * The rollup dot for a set of sessions — a tab, a task, a window.
 *
 * Priority is `blocked > error > needsCheck > working > idle > shell`: a question
 * you have not answered outranks a failure you cannot act on, and both outrank
 * work still in progress.
 */
export function rollUp(states: Iterable<AgentState>): AgentState {
  const present = new Set(states);
  const order: readonly AgentState[] = ['blocked', 'error', 'needsCheck', 'working', 'idle'];
  return order.find((state) => present.has(state)) ?? 'shell';
}
