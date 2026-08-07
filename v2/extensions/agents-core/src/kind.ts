import type { AgentState, StateTransition } from './state.ts';

/**
 * What a vendor plugs in — the seam that makes `codex` or `opencode` a
 * third-party extension rather than a fork (sketch §7c).
 *
 * The shape is decided by one constraint: **`agents-core` may not understand any
 * vendor's payload**, and `claude-code` needs a field out of that payload (the
 * Claude `session_id`, for its ownership lock) before its reducer can run. So
 * nothing here pre-filters, pre-parses or pre-validates. The raw payload goes
 * over; a decision comes back.
 */

/**
 * Declared per kind, because asking a vendor for something it cannot do must be
 * a typed error rather than a hang on a pipe that will never produce the format
 * the caller is parsing for (§7c).
 *
 * Consumed by the headless seam, which is **not** in M2 — the field is here so
 * kinds declare against a stable shape from the start rather than gaining one
 * later and invalidating every manifest written before it.
 */
export interface AgentCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly resume: boolean;
  readonly structuredOutput: boolean;
}

/**
 * A kind's own per-session state, created when it first adopts a session and
 * dropped when that session exits.
 *
 * Lifecycle-scoped on purpose. `claude-code` keeps an ownership lock and a resume
 * id per session; given nowhere to put them it would keep a module-level map,
 * which leaks an entry for every session that ever ran — v1's `locatePane` sprawl
 * one layer in. Untyped by `agents-core` because its contents are the vendor's
 * business; a kind casts it to its own shape.
 */
export type AgentSlot = Record<string, unknown>;

export interface AgentEventInput {
  /** Which ingress topic this arrived on. */
  readonly topic: string;
  /** The envelope's payload, untouched. Parsing it is the kind's job. */
  readonly payload: unknown;
  readonly current: AgentState;
  /** The reason currently on the session, so a kind can preserve it. */
  readonly reason?: string;
  /**
   * The ONE predicate (ADR 0020), mirrored and threaded in. A kind must never
   * ask again — there is nothing in this process that could ask, which is the
   * point.
   */
  readonly viewing: boolean;
  readonly slot: AgentSlot;
}

/**
 * `ignore` is a first-class answer carrying a reason, not a null.
 *
 * It is what both the ordering guard and a foreign nested `claude -p` produce,
 * and those two have to be distinguishable in a log from "nothing arrived at
 * all" — which is the whole difference between a working guard and a dead wire.
 */
export type AgentDecision =
  | { readonly kind: 'transition'; readonly to: StateTransition }
  | { readonly kind: 'ignore'; readonly why: string };

export interface AgentKind {
  readonly id: string;
  /** The ingress topics this kind understands, e.g. `['claude.hook']`. */
  readonly topics: readonly string[];
  readonly capabilities?: AgentCapabilities;
  /**
   * Fold one event into a transition, or refuse it with a reason.
   *
   * Called for sessions this kind has already adopted **and** for ones nothing
   * has adopted yet: a plain shell becomes an agent when a kind first answers
   * with a transition, which is how `SessionStart` adopts a pane without anybody
   * matching on a process name (a real `claude` binary is named after its
   * version, so name matching matches nothing).
   */
  reduce(input: AgentEventInput): AgentDecision;
}

/** The id of the extension point vendors register through. */
export const AGENT_KINDS_POINT = 'agents.kinds';
