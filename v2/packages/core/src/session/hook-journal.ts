/**
 * What an agent reported while no app was listening.
 *
 * Agent state is derived from a STREAM of events, and the stream does not stop
 * when the app closes — a `claude` keeps working in a pty the daemon owns, and
 * keeps firing hooks. Those hooks used to reach a socket the app served, so
 * closing the app dropped every one of them on the floor: `report.sh` finds no
 * socket and exits 0, by design, because a wedged listener must never stall the
 * agent it is observing.
 *
 * So the process that outlives the app holds them instead — the same argument
 * that put the ptys in the daemon (D4). An app that comes back drains this and
 * folds the real events, rather than guessing from a snapshot how a turn ended.
 *
 * Pure: no socket, no clock, no host. `SessionServer` decides WHEN to record and
 * who to hand a drain to; this only decides what survives a cap.
 */

export interface HookEnvelope {
  readonly topic: string;
  /** Whose session — the correlation key, as the ingress attributed it. */
  readonly sessionId: string;
  readonly payload: unknown;
  /**
   * Carried only if the client sent one, and then it stays authoritative all the
   * way to the bus.
   *
   * `report.sh` deliberately sends none (a counter file is a read-increment-write
   * with no lock, so two racing hooks both claim one number and the bus drops the
   * second as a duplicate — a lost `Stop` strands a pane at `working`). But this
   * envelope now crosses a process, and dropping a field a client did set would
   * be the silent loss the `seq` mechanism exists to make visible.
   */
  readonly seq?: number;
}

/**
 * How many envelopes are held before the head starts falling off.
 *
 * A turn is tens of hooks, so this is many turns of several agents. It exists
 * because an app left closed for a week against a chatty agent is otherwise
 * unbounded memory in a process nobody is watching.
 */
export const DEFAULT_JOURNAL_LIMIT = 2_000;

export class HookJournal {
  readonly #limit: number;
  #held: HookEnvelope[] = [];
  #dropped = 0;

  constructor(options: { readonly limit?: number } = {}) {
    this.#limit = options.limit ?? DEFAULT_JOURNAL_LIMIT;
  }

  /**
   * Append, dropping the OLDEST when full.
   *
   * The direction is the decision. A reducer folds these in order and the final
   * state is decided by the last events; the early ones are mostly re-assertions
   * that a turn is still working. Keeping the tail lands closest to the truth,
   * and keeping the head would land on a turn that has since ended.
   */
  record(envelope: HookEnvelope): void {
    this.#held.push(envelope);
    while (this.#held.length > this.#limit) {
      this.#held.shift();
      this.#dropped += 1;
    }
  }

  get size(): number {
    return this.#held.length;
  }

  /**
   * Hand over everything held and forget it — a delivered event is not replayed.
   *
   * The loss count rides WITH the batch rather than being a second read, because
   * the drain resets it: a caller that drained and then asked would be told zero,
   * and would report a complete replay of an incomplete one. Reset per batch for
   * the same reason it is reported at all — a running total would put the same
   * warning in the log at every launch for the life of the daemon.
   */
  drain(): { readonly events: readonly HookEnvelope[]; readonly dropped: number } {
    const events = this.#held;
    const dropped = this.#dropped;
    this.#held = [];
    this.#dropped = 0;
    return { events, dropped };
  }
}
