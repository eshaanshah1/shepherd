import { s, type Schema } from '@shepherd/sdk';
import { AGENT_STATES, isAgent, type AgentState } from './state.ts';
import type { AgentSlot } from './kind.ts';

/**
 * What a tracked agent leaves behind, and what may be believed on the way back.
 *
 * The daemon outlives the app and keeps every pty, so a `claude` that was mid-turn
 * when the app was replaced is still mid-turn when it comes back. Nothing asks it
 * what it is doing — a vendor reports state by firing hooks, and a process that
 * did not restart fires no `SessionStart`. Worse, the events it DOES fire are then
 * discarded: the ordering guard applies a mid-turn event only while the session is
 * `working`/`blocked` (ADR 0004), and an untracked session reads `shell`. So every
 * agent read idle until the user typed the next prompt.
 *
 * The registry is still the one writer and still the only thing that decides a
 * state. This file decides only which rows off disk are worth handing it.
 *
 * Pure: no host, no clock, no IO. The KV read and the write live in `activate`.
 */

/** The KV key. Versioned, so a shape change is a new key rather than a migration. */
export const AGENT_STATE_KEY = 'agents.sessions.v1';

export interface PersistedAgent {
  readonly sessionId: string;
  readonly kindId: string;
  readonly state: AgentState;
  readonly reason?: string;
  /** The vendor's own per-session state — its ownership lock and resume id. */
  readonly slot: AgentSlot;
}

/**
 * Read as a list of UNKNOWNS and validated one row at a time, deliberately.
 *
 * A schema over the whole blob would make one unreadable row cost every other
 * agent its state: `KV.get` answers `undefined` for a parse failure, so a single
 * entry from a newer build would restore nothing at all. This is the line
 * `readSessionRows` draws for the same reason, one seam over.
 */
const storedList: Schema<unknown[]> = s.array(s.unknown());

const storedAgent: Schema<{
  sessionId: string;
  kindId: string;
  state: AgentState;
  reason?: string;
  slot?: Record<string, unknown>;
}> = s.stored({
  sessionId: s.string(),
  kindId: s.string(),
  state: s.enumOf(AGENT_STATES),
  reason: s.optional(s.string()),
  slot: s.optional(s.record(s.unknown())),
});

export function readStored(storage: { get<T>(key: string, schema: Schema<T>): T | undefined }): readonly unknown[] | undefined {
  return storage.get(AGENT_STATE_KEY, storedList);
}

/**
 * Which of a snapshot's rows may be restored.
 *
 * `live` is the session ids `sessions.list` reports, and it is the whole of the
 * staleness check: a row naming a session the kernel does not have is a pty that
 * went with the previous run, and restoring it would put a working dot on a pane
 * that does not exist — permanently, because the sweep only looks at sessions the
 * kernel names.
 *
 * A row that survives can still be WRONG — an agent may have finished while the
 * app was down — and that is fine by construction: a restored `working` is busy,
 * so the sweep watches it and demotes it to `needsCheck` on two quiet readings.
 * Guessing busy costs one correction; guessing idle discards the alert.
 */
export function restorable(
  rows: readonly unknown[] | undefined,
  live: ReadonlySet<string>,
): readonly PersistedAgent[] {
  if (rows === undefined) return [];
  const kept: PersistedAgent[] = [];
  for (const row of rows) {
    const parsed = storedAgent.parse(row);
    if (!parsed.ok) continue;
    const entry = parsed.value;
    if (!live.has(entry.sessionId)) continue;
    // A plain terminal is not an agent, so there is nothing to preserve — and
    // `shell` is the one state the registry expresses by holding no entry.
    if (!isAgent(entry.state)) continue;
    kept.push({
      sessionId: entry.sessionId,
      kindId: entry.kindId,
      state: entry.state,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      slot: entry.slot ?? {},
    });
  }
  return kept;
}
