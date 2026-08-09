import { toDisposable, type Disposable } from '@shepherd/sdk';
import { TerminalMirror, type ScreenState } from './mirror.ts';

/** Where a session's bytes go. One per attached view (a window, a phone, a tap). */
export type PtySink = (bytes: Uint8Array) => void;

/**
 * A session's output, kept as a SCREEN and fanned out.
 *
 * The contract worth naming — v1's PtyBroker held a lock across it and explained
 * it only in a comment — is that **snapshot, register and replay are one step**.
 * Split them and you get one of two bugs, neither of which shows up in a test
 * that attaches to an idle session:
 *
 *   - register after replaying  -> bytes written *during* the replay reach
 *                                  nobody. A gap, mid-screen.
 *   - snapshot after registering -> those same bytes arrive twice.
 *
 * R0 made that contract harder to keep in a way the ring version could not
 * express. The mirror captures ASYNCHRONOUSLY — parsing lags the feed — so "one
 * step" can no longer be one synchronous block. A sink is therefore registered
 * in a **pending** state, live bytes are queued for it rather than delivered,
 * and the queue is drained behind the snapshot once it lands.
 *
 * Two consequences worth stating, because both are reachable bugs rather than
 * theory:
 *
 *   - The duplicate direction is now REAL. Against a ring it had no
 *     single-threaded expression and was guarded only by asserting the replay
 *     appeared once; here, a snapshot taken one microtask late contains bytes
 *     that are also sitting in the queue. `mirror.ts`'s `capture` comment is what
 *     prevents it, and probe p4 is what found it.
 *
 *   - The drain is a LOOP, not a for-of. A sink may feed the fanout from inside
 *     its own callback (an echo, an auto-response, a test), and such a write must
 *     land after the bytes already queued ahead of it. Draining with a loop that
 *     re-checks the queue keeps that order; iterating a snapshot of the array
 *     would deliver the re-entrant write first, out of order, and only when the
 *     queue happened to be non-empty.
 */
export class PtyFanout {
  readonly #mirror: TerminalMirror;
  /** Live sinks. */
  readonly #sinks = new Set<PtySink>();
  /** Sinks awaiting (or draining) their snapshot, and the bytes queued for them. */
  readonly #pending = new Map<PtySink, Uint8Array[]>();

  constructor(mirror: TerminalMirror = new TerminalMirror()) {
    this.#mirror = mirror;
  }

  get viewerCount(): number {
    return this.#sinks.size + this.#pending.size;
  }

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#mirror.feed(bytes);
    // Iterate a copy: a sink is allowed to dispose itself (or attach another)
    // from inside its own callback.
    for (const sink of [...this.#sinks]) deliver(sink, bytes);
    // A sink still waiting for its snapshot must not miss these, and must not
    // receive them twice — they are after the capture point by construction.
    for (const queue of this.#pending.values()) queue.push(bytes);
  }

  /**
   * Registers `sink`, then replays the screen to it and goes live.
   *
   * Returns synchronously — the caller gets its `Disposable` in the same tick, as
   * it always did — but the first bytes now arrive on a later one, because the
   * screen has to be captured at a point in the mirror's write queue. Disposing
   * before the snapshot lands cancels it: a viewer that has gone away must not be
   * handed 55 KB of screen.
   */
  attach(sink: PtySink): Disposable {
    const queue: Uint8Array[] = [];
    this.#pending.set(sink, queue);

    this.#mirror.capture((snapshot) => {
      // Disposed while the capture was in flight.
      if (this.#pending.get(sink) !== queue) return;

      if (snapshot.length > 0) deliver(sink, snapshot);

      // Drain by re-checking, so a re-entrant feed from inside `deliver` queues
      // behind what is already waiting instead of overtaking it. `shift()` is
      // O(n) on a large array, but this queue holds only what arrived during one
      // capture — a few milliseconds of output.
      for (;;) {
        const next = queue.shift();
        if (next === undefined) break;
        deliver(sink, next);
      }

      // Nothing is in flight now: the loop above only exits with an empty queue
      // and no callback running, so promoting here cannot drop a byte.
      if (this.#pending.get(sink) !== queue) return;
      this.#pending.delete(sink);
      this.#sinks.add(sink);
    });

    return toDisposable(() => {
      this.#pending.delete(sink);
      this.#sinks.delete(sink);
    });
  }

  /**
   * The screen as bytes, for a caller that wants it without attaching.
   *
   * Callback-shaped rather than a return value, for the reason in `mirror.ts`:
   * the capture happens at a point in the write queue, and a synchronous getter
   * would have to serialize a terminal that may still be parsing.
   */
  snapshot(sink: (bytes: Uint8Array) => void): void {
    this.#mirror.capture(sink);
  }

  /** What is on the display right now. */
  screen(): ScreenState {
    return this.#mirror.screen();
  }

  /**
   * Keeps the mirror the same size as the pty. It must be resized WITH the pty
   * and not merely told afterwards — a program redrawing into its new size would
   * otherwise be parsed against the old one, and the screen every late viewer is
   * handed would be wrong in a way nothing else reveals.
   */
  resize(cols: number, rows: number): void {
    this.#mirror.resize(cols, rows);
  }

  clear(): void {
    this.#sinks.clear();
    this.#pending.clear();
    this.#mirror.dispose();
  }
}

/**
 * A viewer that throws must not cost the others their bytes, and must not stop
 * the mirror recording them — a dead IPC channel is the normal way this happens,
 * and it is the session's job to keep running when a window goes away.
 */
function deliver(sink: PtySink, bytes: Uint8Array): void {
  try {
    sink(bytes);
  } catch {
    // Swallowed on purpose. Logging belongs to whoever owns the sink.
  }
}
