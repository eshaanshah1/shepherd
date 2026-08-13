import type { HookEnvelope } from '@shepherd/core';

/**
 * Agent hooks from the daemon, held until something in this app can reduce them.
 *
 * The daemon journals hooks fired while no app was connected and flushes them
 * inside the handshake — it has to, or it would go on holding events for a client
 * that is already live. But main's handshake happens in `whenReady`, **before the
 * extension host is forked**, and the bus has no retention: an emit with no
 * subscriber is gone. The replay therefore landed on an empty bus, and the restart
 * smoke read `working` for a turn that had already ended.
 *
 * `PtyFanout` states the rule this borrows — snapshot, register and replay are one
 * step — and the reason it needs restating here is that the step spans two
 * processes. The daemon's half is atomic within itself; this is the app's half.
 *
 * **`goLive` is not "the app is ready", it is "a consumer exists".** Nothing in
 * main knows when a child subscribes to a topic — `agents-core` says exactly that
 * about its own seed — so the honest signal is the one main owns: its startup
 * activations have completed, and `agents-core` declares `onStartup` precisely so
 * it is subscribed before the first hook arrives.
 */

export interface HookRelay {
  /** One envelope off the wire. Held, or passed through once live. */
  receive(envelope: HookEnvelope): void;
  /** Flush what is held, in order, and stop holding. Idempotent. */
  goLive(): void;
  /** What is waiting. For a log line, and for the tests. */
  readonly buffered: number;
}

export function hookRelay(emit: (envelope: HookEnvelope) => void): HookRelay {
  let held: HookEnvelope[] | undefined = [];

  const deliver = (envelope: HookEnvelope): void => {
    try {
      emit(envelope);
    } catch {
      // One bad consumer must not cost the remaining events their delivery. The
      // caller owns the logging; a relay that threw mid-flush would drop the tail
      // of a replay, which is the half that decides the state.
    }
  };

  return {
    receive(envelope) {
      if (held === undefined) deliver(envelope);
      else held.push(envelope);
    },
    goLive() {
      const queued = held;
      // Cleared BEFORE the flush, so a re-entrant `receive` — a consumer that
      // emits synchronously into something that posts back — appends nowhere and
      // is delivered rather than held for a flush that has already happened.
      held = undefined;
      if (queued === undefined) return;
      for (const envelope of queued) deliver(envelope);
    },
    get buffered() {
      return held?.length ?? 0;
    },
  };
}
