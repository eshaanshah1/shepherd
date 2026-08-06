import { toDisposable, type Disposable } from '@shepherd/sdk';
import { PtyRing } from './ring.ts';

/** Where a session's bytes go. One per attached view (a window, a phone, a tap). */
export type PtySink = (bytes: Uint8Array) => void;

/**
 * A session's output, recorded and fanned out.
 *
 * The contract worth naming — v1's PtyBroker held a lock across it and
 * explained it only in a comment — is that **snapshot, register and replay are
 * one step**. Split them and you get one of two bugs, neither of which shows up
 * in a test that attaches to an idle session:
 *
 *   - register after replaying  -> bytes written *during* the replay reach
 *                                  nobody. A gap, mid-screen.
 *   - snapshot after registering -> those same bytes arrive twice.
 *
 * JavaScript has no threads, so the way that race reaches this code is
 * re-entrancy: a sink that writes back into the session (an echo, an
 * auto-response, a test) re-enters `feed` from inside `attach`. `ring.test.ts`
 * provokes exactly that, and catches the gap directly — moving the `add` below
 * the replay makes it lose a marker. The duplicate direction has no
 * single-threaded expression, so that half of the contract is guarded only by
 * the assertion that the replay appears exactly once.
 */
export class PtyFanout {
  readonly #ring: PtyRing;
  readonly #sinks = new Set<PtySink>();

  constructor(ring: PtyRing = new PtyRing()) {
    this.#ring = ring;
  }

  get viewerCount(): number {
    return this.#sinks.size;
  }

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#ring.append(bytes);
    // Iterate a copy: a sink is allowed to dispose itself (or attach another)
    // from inside its own callback.
    for (const sink of [...this.#sinks]) deliver(sink, bytes);
  }

  /** Registers `sink` and replays the ring to it, atomically. Dispose to detach. */
  attach(sink: PtySink): Disposable {
    const replay = this.#ring.snapshot();
    this.#sinks.add(sink);
    if (replay.length > 0) deliver(sink, replay);
    return toDisposable(() => {
      this.#sinks.delete(sink);
    });
  }

  snapshot(): Uint8Array {
    return this.#ring.snapshot();
  }

  clear(): void {
    this.#sinks.clear();
    this.#ring.clear();
  }
}

/**
 * A viewer that throws must not cost the others their bytes, and must not stop
 * the ring recording them — a dead IPC channel is the normal way this happens,
 * and it is the session's job to keep running when a window goes away.
 */
function deliver(sink: PtySink, bytes: Uint8Array): void {
  try {
    sink(bytes);
  } catch {
    // Swallowed on purpose. Logging belongs to whoever owns the sink.
  }
}
