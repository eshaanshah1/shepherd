import { isBusy, type AgentState, type StateTransition } from './state.ts';
import type { AgentDecision, AgentKind, AgentSlot } from './kind.ts';

/**
 * Every tracked agent session, and the ONE place any of their states is written.
 *
 * Two sources of evidence reach it and neither is allowed its own writer:
 *
 *   - a **kind's reducer**, folding a vendor's protocol event, and
 *   - the **reconciliation sweep**, which knows nothing about any protocol and
 *     only that a session's shell is back in front of it.
 *
 * The sweep deliberately does NOT travel through `AgentKind.reduce`. Synthesising
 * an event for it would put a lie in a vendor reducer's input, and Claude's
 * reducer would then eat it: mid-turn events apply only while `working`/`blocked`
 * (ADR 0004), which is exactly the state a demotion starts from. So both
 * evidence sources call `#write`, and there is one writer with two callers.
 *
 * Pure: no clock, no IO, no bus. The extension's `activate` is the shell around
 * it, which is what lets the ordering guard, the adoption rule and the sweep's
 * hysteresis all be tested as values.
 */

export interface AgentRecord {
  readonly sessionId: string;
  /** Which kind adopted this session. Undefined until one does. */
  readonly kindId?: string;
  readonly state: AgentState;
  readonly reason?: string;
}

export interface AgentChange {
  readonly sessionId: string;
  readonly kindId: string;
  readonly from: AgentState;
  readonly to: AgentState;
  readonly reason?: string;
  /**
   * The turn ended here — whether that read as `needsCheck` or, because the user
   * was watching, as `idle`. Consumers key off THIS, never `state === needsCheck`,
   * which misses the viewing landing entirely (ADR 0020).
   */
  readonly turnFinished: boolean;
}

interface Entry {
  kindId: string;
  state: AgentState;
  reason?: string;
  /** Per-kind, per-session state. Dropped whole when the session goes. */
  slot: AgentSlot;
  /** Consecutive sweep readings saying nothing is running. See `observe`. */
  quietTicks: number;
}

/** How many consecutive quiet readings before the sweep demotes. */
export const SWEEP_QUIET_TICKS = 2;

export class AgentRegistry {
  readonly #entries = new Map<string, Entry>();
  /** Sessions the user is demonstrably looking at — the mirrored ONE predicate. */
  readonly #viewed = new Set<string>();
  readonly #listeners = new Set<(change: AgentChange) => void>();

  // ------------------------------------------------------------------ the mirror

  /**
   * Set from `session.viewing` and from `sessions.list`'s seed.
   *
   * A cache of the one answer, never a second computation of it: nothing in this
   * process can see focus, zoom or an overlay, which is precisely why this is
   * safe (ADR 0020 forbids a second *check*, not a pushed value).
   */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.#viewed.add(sessionId);
    else this.#viewed.delete(sessionId);
  }

  isViewing(sessionId: string): boolean {
    return this.#viewed.has(sessionId);
  }

  /**
   * The edge that clears a finished turn you have now looked at.
   *
   * v1's table: need-to-check → idle on focus, and **only** need-to-check —
   * looking at a permission prompt is not answering it, and a failed turn is not
   * un-failed by being seen. Returns the change so the caller can log it.
   */
  observeViewed(sessionId: string): AgentChange | undefined {
    this.setViewing(sessionId, true);
    const entry = this.#entries.get(sessionId);
    if (entry?.state !== 'needsCheck') return undefined;
    return this.#write(sessionId, {
      state: 'idle',
      clearTitle: false,
      applied: true,
      heldForBackground: false,
      turnFinished: false,
    });
  }

  // ------------------------------------------------------------------- events

  /**
   * Route one ingress event to the kinds that understand its topic.
   *
   * An unadopted session is offered to every kind handling the topic, in
   * registration order, and **the first kind that answers with a transition
   * adopts it**. That is how a plain shell becomes a tracked agent: by its agent
   * saying so through a hook, not by anybody matching a process name — a real
   * `claude` resolves to a binary named after its version, so name matching
   * matches nothing.
   *
   * Once adopted, only the owning kind is consulted. A second vendor's events
   * arriving on a session another vendor owns are ignored rather than fought over.
   */
  handle(
    sessionId: string,
    topic: string,
    payload: unknown,
    kinds: readonly AgentKind[],
  ): { readonly change?: AgentChange; readonly ignored?: string } {
    const entry = this.#entries.get(sessionId);
    const candidates = entry
      ? kinds.filter((kind) => kind.id === entry.kindId)
      : kinds.filter((kind) => kind.topics.includes(topic));

    if (candidates.length === 0) {
      return { ignored: entry ? `${topic} is not ${entry.kindId}'s topic` : `no kind handles ${topic}` };
    }

    const reasons: string[] = [];
    for (const kind of candidates) {
      if (!kind.topics.includes(topic)) continue;
      // The slot handed to a kind that is about to ADOPT has to be the very
      // object the record then keeps. Creating one here and another inside
      // adoption silently discards everything the adopting event wrote — and the
      // adopting event is `SessionStart`, which is exactly where a vendor takes
      // its ownership lock and records its resume id. A fresh object per
      // candidate, so a kind that declines cannot leave anything in the one the
      // adopter receives.
      const slot: AgentSlot = entry?.slot ?? {};
      const decision: AgentDecision = kind.reduce({
        topic,
        payload,
        current: entry?.state ?? 'shell',
        ...(entry?.reason === undefined ? {} : { reason: entry.reason }),
        viewing: this.#viewed.has(sessionId),
        slot,
      });

      if (decision.kind === 'ignore') {
        reasons.push(`${kind.id}: ${decision.why}`);
        continue;
      }
      if (!decision.to.applied) {
        // A reducer answering `applied: false` is the ordering guard, and it is
        // NOT a state write. Saying so keeps a guard that is working apart from
        // a wire that is dead.
        reasons.push(`${kind.id}: not applied (mid-turn guard)`);
        continue;
      }
      return { change: this.#adoptAndWrite(sessionId, kind, decision.to, slot) };
    }
    return { ignored: reasons.join('; ') };
  }

  // -------------------------------------------------------------- the sweep

  /**
   * One reading of "is anything still running in this session".
   *
   * `hasForegroundProcess` is **tri-state** and `undefined` means the tty could
   * not be read. That is not evidence of anything: node-pty answers it for a
   * transient read failure on a perfectly live agent, and treating it as `false`
   * would demote one. So `undefined` resets nothing and decides nothing.
   *
   * A demotion needs `SWEEP_QUIET_TICKS` **consecutive** quiet readings, because
   * one reading is not evidence in either direction — a freshly spawned pty
   * reports node-pty's own helper, and a login shell runs transient helpers for
   * its first moments.
   */
  observe(sessionId: string, hasForegroundProcess: boolean | undefined): AgentChange | undefined {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    // Only a session claiming to be doing something can be wrong about it.
    if (!isBusy(entry.state)) {
      entry.quietTicks = 0;
      return undefined;
    }
    if (hasForegroundProcess === undefined) return undefined;
    if (hasForegroundProcess) {
      entry.quietTicks = 0;
      return undefined;
    }

    entry.quietTicks += 1;
    if (entry.quietTicks < SWEEP_QUIET_TICKS) return undefined;
    entry.quietTicks = 0;

    // **`needsCheck`, never `idle`.** A dead agent is exactly something the user
    // has not seen, so landing it `idle` would silently discard the one alert
    // this sweep exists to raise.
    return this.#write(sessionId, {
      state: 'needsCheck',
      reason: 'the agent exited without saying so',
      clearTitle: false,
      applied: true,
      heldForBackground: false,
      turnFinished: true,
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /** A session ended: its record and every kind's slot for it go together. */
  forget(sessionId: string): AgentChange | undefined {
    const entry = this.#entries.get(sessionId);
    this.#viewed.delete(sessionId);
    if (entry === undefined) return undefined;
    const change: AgentChange = {
      sessionId,
      kindId: entry.kindId,
      from: entry.state,
      to: 'shell',
      reason: 'the session ended',
      turnFinished: false,
    };
    this.#entries.delete(sessionId);
    this.#emit(change);
    return change;
  }

  get(sessionId: string): AgentRecord | undefined {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    return {
      sessionId,
      kindId: entry.kindId,
      state: entry.state,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  }

  list(): readonly AgentRecord[] {
    return [...this.#entries.keys()].map((id) => this.get(id)).filter((r): r is AgentRecord => r !== undefined);
  }

  onDidChange(fn: (change: AgentChange) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  // ------------------------------------------------------------------ internals

  #adoptAndWrite(
    sessionId: string,
    kind: AgentKind,
    to: StateTransition,
    slot: AgentSlot,
  ): AgentChange {
    // `slot` is the object the kind was just handed, not a new one: the adopting
    // event is where a vendor writes its ownership lock, and a second object here
    // would drop it on the floor with nothing saying so.
    if (!this.#entries.has(sessionId)) {
      this.#entries.set(sessionId, { kindId: kind.id, state: 'shell', slot, quietTicks: 0 });
    }
    return this.#write(sessionId, to);
  }

  /** The one writer. Both evidence sources arrive here and nowhere else. */
  #write(sessionId: string, to: StateTransition): AgentChange {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) {
      throw new Error(`agents-core: no record for ${sessionId} — #write is only reachable after adoption`);
    }
    const from = entry.state;
    entry.state = to.state;
    if (to.reason === undefined) delete entry.reason;
    else entry.reason = to.reason;
    // Any real transition ends a quiet run: the session is demonstrably alive.
    entry.quietTicks = 0;

    const change: AgentChange = {
      sessionId,
      kindId: entry.kindId,
      from,
      to: to.state,
      ...(to.reason === undefined ? {} : { reason: to.reason }),
      turnFinished: to.turnFinished,
    };
    this.#emit(change);
    return change;
  }

  #emit(change: AgentChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {
        // One bad subscriber must not stop the fan-out. The caller owns logging;
        // this class is pure and has no logger by design.
      }
    }
  }
}
