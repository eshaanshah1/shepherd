import {
  callerLabel,
  seqVerdict,
  toDisposable,
  type Caller,
  type Clock,
  type Disposable,
  type Envelope,
  type Logger,
} from '@shepherd/sdk';

/**
 * Typed pub/sub between extensions, and the landing point for the external
 * ingress socket — hooks are simply its first client rather than a special case
 * wired into the app.
 *
 * The interesting part is the sequence handling. Two kinds of source exist:
 *
 *   - Most emitters do not track their own ordering, so the bus numbers them
 *     **per source**. A global counter would make every subscriber's gap check
 *     meaningless the moment a second source emitted.
 *   - A source that *does* number its own events (a hook process writing a
 *     per-session counter) supplies its `seq`, and the bus keeps it. Renumbering
 *     would throw away exactly the ordering evidence the number exists to carry.
 *
 * For the second kind the bus also judges the number, and the two verdicts get
 * deliberately opposite treatment:
 *
 *   - a **gap** is logged and the event is **delivered** — refusing it would
 *     turn one lost message into two;
 *   - a **duplicate** is logged and **dropped** — it is a retry, and delivering
 *     it twice would double-apply whatever transition it drives.
 *
 * This is the mechanism v1 lacked entirely: a `PreToolUse` that arrived after
 * the `PermissionRequest` it precedes overwrote `blocked` with `working`, with
 * no re-notification and no way to know it had happened.
 */

export interface EventBusOptions {
  readonly clock: Clock;
  readonly logger: Logger;
}

type Listener = (payload: unknown, envelope: Envelope) => void;

export class EventBus {
  /** Exact-topic subscribers. */
  readonly #exact = new Map<string, Set<Listener>>();
  /** `claude.*` subscribers, keyed by the prefix including its trailing dot. */
  readonly #prefix = new Map<string, Set<Listener>>();
  /** `*` subscribers — a debug log, and later the remote mirror. */
  readonly #all = new Set<Listener>();
  /** Per-source counters and last-seen numbers, keyed by `callerLabel`. */
  readonly #seq = new Map<string, number>();
  readonly #clock;
  readonly #log;

  constructor(options: EventBusOptions) {
    this.#clock = options.clock;
    this.#log = options.logger.child('event');
  }

  /**
   * `seq` is supplied only by a source authoritative about its own ordering.
   * Omit it and the bus assigns the next number for that source.
   */
  emit<T>(topic: string, payload: T, source: Caller, seq?: number): void {
    const who = callerLabel(source);

    let number: number;
    if (seq === undefined) {
      number = (this.#seq.get(who) ?? 0) + 1;
      this.#seq.set(who, number);
    } else {
      const verdict = seqVerdict(this.#seq.get(who), seq);
      if (verdict === 'duplicate') {
        this.#log.warn(`duplicate seq ${seq} on ${topic} from ${who} — dropped`);
        return;
      }
      if (verdict === 'gap') {
        this.#log.warn(
          `gap before seq ${seq} on ${topic} from ${who} (last was ${this.#seq.get(who)}) — delivered anyway`,
        );
      }
      number = seq;
      this.#seq.set(who, seq);
    }

    const envelope: Envelope = { seq: number, ts: this.#clock.now(), source };
    for (const listener of this.#listenersFor(topic)) {
      try {
        listener(payload, envelope);
      } catch (error) {
        // One bad subscriber must not stop the fan-out, and must not be silent:
        // "the extension that watches for conflicts stopped working" is not
        // something anyone discovers without a line naming it.
        this.#log.error(`listener for ${topic} threw: ${messageOf(error)}`);
      }
    }
  }

  on<T>(topic: string, fn: (payload: T, envelope: Envelope) => void): Disposable {
    const listener = fn as Listener;
    if (topic === '*') {
      this.#all.add(listener);
      return toDisposable(() => void this.#all.delete(listener));
    }
    if (topic.endsWith('.*')) {
      const prefix = topic.slice(0, -1); // keep the dot: `claude.`
      return add(this.#prefix, prefix, listener);
    }
    return add(this.#exact, topic, listener);
  }

  /** The last sequence number seen from a source. For diagnostics and tests. */
  lastSeq(source: Caller): number | undefined {
    return this.#seq.get(callerLabel(source));
  }

  /**
   * A snapshot, not the live sets: a listener that unsubscribes itself while
   * being called would otherwise shorten the collection mid-iteration and skip
   * whichever sibling happened to be next.
   */
  #listenersFor(topic: string): Listener[] {
    const out: Listener[] = [...(this.#exact.get(topic) ?? [])];
    for (const [prefix, listeners] of this.#prefix) {
      if (topic.startsWith(prefix)) out.push(...listeners);
    }
    out.push(...this.#all);
    return out;
  }
}

function add(index: Map<string, Set<Listener>>, key: string, listener: Listener): Disposable {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(listener);
  return toDisposable(() => {
    const current = index.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) index.delete(key);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
