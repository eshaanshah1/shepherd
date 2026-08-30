import type { Envelope } from '@shepherd/sdk';

/**
 * One client's subscription to one topic — the two things the CLI never needed
 * and a second client does (core/UI isolation design §3).
 *
 * **Snapshot-then-delta.** `PtyFanout` learned this on the data plane: snapshot,
 * register and replay are ONE step, or a viewer that arrives mid-stream folds
 * bytes onto a screen it never saw. The control plane has the same failure with
 * a quieter symptom — a client that subscribes and *then* reads has a window
 * where an event lands between the two, and a client that reads and then
 * subscribes has a window where one is lost. Either way the client's model is
 * silently wrong until the next change, which for a settings page is forever.
 *
 * **Pull-with-nudge.** ADR 0031 chose this for views and gave the reason: the
 * change signal is a nudge, the reader reads when it wants, and a chatty
 * extension cannot flood anyone. A nudge carries no payload, so nothing is drawn
 * from a snapshot the reader did not ask for; and at most ONE is outstanding, so
 * a hundred changes during a slow read produce one more nudge rather than a
 * hundred queued frames.
 *
 * A nudge may name the SUBJECTS that changed (`keys`) when the topic says how to
 * read one off a payload. That is not a widening of the rule — an id is not
 * data, and the reader still has to go and read — but it is the difference
 * between "some view changed, re-read all of them" and "the task tree changed".
 * Without it, back-pressure on the view topic would trade one flood for another:
 * every nudge would fan out into a read per contributed tree, each of which
 * crosses a process boundary.
 *
 * Pure: no bus, no socket, no timers. Every rule above is assertable without a
 * process.
 */

export type Delivery = 'push' | 'nudge';

export interface SubscriptionSpec {
  readonly topic: string;
  readonly delivery: Delivery;
  /**
   * Which subject a payload is about, for a nudge's `keys`. Absent = the topic
   * has no subjects and a nudge names none.
   */
  readonly key?: (payload: unknown) => string | undefined;
}

/**
 * How many distinct subjects a nudge will name before it gives up and says
 * "everything".
 *
 * A bound rather than a list, because the list is a client's work queue: a
 * chatty extension touching a thousand view types would otherwise turn one
 * coalesced frame into a thousand-entry array the reader walks. Past the cap the
 * honest answer is `keys: undefined` — re-read what you hold — which is what a
 * client with no `keys` support does anyway.
 */
export const MAX_NUDGE_KEYS = 32;

/** The topic's current value, or the fact that it has none. */
export type SnapshotResult = { readonly has: true; readonly value: unknown } | { readonly has: false };

export type ControlFrame =
  | { readonly kind: 'snapshot'; readonly topic: string; readonly seq: number; readonly value: unknown }
  | {
      readonly kind: 'event';
      readonly topic: string;
      readonly seq: number;
      readonly payload: unknown;
      readonly envelope: Envelope;
    }
  | {
      readonly kind: 'nudge';
      readonly topic: string;
      readonly seq: number;
      /** How many further changes happened while this nudge was outstanding. */
      readonly coalesced: number;
      /**
       * The subjects that changed, when the topic can name them and there were
       * few enough to list. **Absent means "everything you hold"** — either the
       * topic has no subjects or too many changed to be worth enumerating.
       */
      readonly keys?: readonly string[];
    };

export class SubscriptionState {
  readonly #spec: SubscriptionSpec;
  /** 0 is the snapshot; deltas count from 1, so a gap in the run is visible. */
  #seq = 0;
  /** A nudge is out and the reader has not come back. */
  #outstanding = false;
  /** Changes swallowed while one was outstanding. */
  #coalesced = 0;
  /** Their subjects, if the topic names them. `null` = too many to list. */
  #keys: Set<string> | null = new Set();

  constructor(spec: SubscriptionSpec) {
    this.#spec = spec;
  }

  get topic(): string {
    return this.#spec.topic;
  }

  /**
   * The frames a client gets the instant it subscribes.
   *
   * Called by the transport in the SAME step as registering the listener —
   * that is the whole invariant, and it lives at the call site because only the
   * transport can hold both halves.
   */
  open(snapshot: SnapshotResult): ControlFrame[] {
    if (!snapshot.has) return [];
    return [{ kind: 'snapshot', topic: this.#spec.topic, seq: 0, value: snapshot.value }];
  }

  receive(payload: unknown, envelope: Envelope): ControlFrame[] {
    if (this.#spec.delivery === 'push') {
      this.#seq += 1;
      return [{ kind: 'event', topic: this.#spec.topic, seq: this.#seq, payload, envelope }];
    }
    if (this.#outstanding) {
      this.#coalesced += 1;
      this.#remember(payload);
      return [];
    }
    this.#outstanding = true;
    this.#seq += 1;
    const keys = this.#keyOf(payload);
    return [
      {
        kind: 'nudge',
        topic: this.#spec.topic,
        seq: this.#seq,
        coalesced: 0,
        ...(keys === undefined ? {} : { keys: [keys] }),
      },
    ];
  }

  /**
   * The reader read. Answers with a fresh nudge only if something changed while
   * it was reading — a pull that always nudged would make the read its own next
   * signal and spin.
   */
  pulled(): ControlFrame[] {
    if (this.#spec.delivery === 'push') return [];
    this.#outstanding = false;
    if (this.#coalesced === 0) {
      this.#keys = new Set();
      return [];
    }
    const coalesced = this.#coalesced;
    const keys = this.#keys === null || this.#keys.size === 0 ? undefined : [...this.#keys];
    this.#coalesced = 0;
    this.#keys = new Set();
    this.#outstanding = true;
    this.#seq += 1;
    return [
      {
        kind: 'nudge',
        topic: this.#spec.topic,
        seq: this.#seq,
        coalesced,
        ...(keys === undefined ? {} : { keys }),
      },
    ];
  }

  #keyOf(payload: unknown): string | undefined {
    return this.#spec.key?.(payload);
  }

  #remember(payload: unknown): void {
    if (this.#keys === null) return;
    const key = this.#keyOf(payload);
    if (key === undefined) {
      // A payload with no subject means the whole topic moved; naming the others
      // would tell the reader to re-read a strict subset of what changed.
      this.#keys = null;
      return;
    }
    this.#keys.add(key);
    if (this.#keys.size > MAX_NUDGE_KEYS) this.#keys = null;
  }
}
