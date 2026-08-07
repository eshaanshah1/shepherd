import type { Clock, Disposable } from '@shepherd/sdk';

/**
 * Trailing debounce over the injected `Clock`.
 *
 * Exists because of review §Bad-8: v1 re-encoded and wrote its whole persisted
 * state on **every** `cd`. Batching those writes is the fix — but batching is
 * only safe if quitting is one of the things that ends a batch, which is what
 * `flush` is for. A debounced write with no flush on teardown loses exactly the
 * last change the user made, which is worse than writing too often.
 *
 * On the clock: nothing here calls `setTimeout` directly, so the coalescing
 * behaviour is testable without sleeping — review §Bad-9's whole complaint about
 * v1's untestable timing state machines.
 */
export interface Debounced extends Disposable {
  /** Start or extend the quiet window. */
  schedule(): void;
  /** Run pending work immediately. No-op if nothing is waiting. */
  flush(): void;
  /** Drop pending work without running it. */
  dispose(): void;
  readonly pending: boolean;
}

export function debounce(clock: Clock, ms: number, fn: () => void): Debounced {
  let timer: { dispose(): void } | undefined;

  const cancel = (): void => {
    timer?.dispose();
    timer = undefined;
  };

  const run = (): void => {
    cancel();
    // Cleared BEFORE the callback runs: a throwing write must not leave the
    // debouncer looking permanently busy, or every later `schedule()` becomes a
    // silent no-op and the state simply stops being saved.
    fn();
  };

  return {
    schedule() {
      cancel();
      timer = clock.setTimeout(run, ms);
    },
    flush() {
      if (timer === undefined) return;
      run();
    },
    dispose: cancel,
    get pending() {
      return timer !== undefined;
    },
  };
}
