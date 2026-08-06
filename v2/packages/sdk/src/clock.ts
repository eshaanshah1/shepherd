/**
 * Injected time. Nothing in core or an extension may call `Date.now()` or
 * `setTimeout` directly — a policy that reads the wall clock cannot be tested
 * without sleeping, and v1 paid for that in flaky timing tests.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Fires `fn` after `ms`; disposing the returned handle cancels it. */
  setTimeout(fn: () => void, ms: number): { dispose(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return { dispose: () => clearTimeout(handle) };
  },
};

export interface ManualClock extends Clock {
  /** Move time forward, firing every timer whose deadline has passed. */
  advance(ms: number): void;
}

/** A `Clock` tests drive by hand. Timers fire in deadline order. */
export function manualClock(startMs = 0): ManualClock {
  let current = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; order: number; fn: () => void }>();

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const key = seq++;
      timers.set(key, { at: current + ms, order: key, fn });
      return { dispose: () => void timers.delete(key) };
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order);
        const next = due[0];
        if (!next) break;
        const [key, timer] = next;
        timers.delete(key);
        current = timer.at;
        timer.fn();
      }
      current = target;
    },
  };
}
