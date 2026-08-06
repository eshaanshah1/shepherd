export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      // Idempotent on purpose: a subscription list disposed twice (deactivate
      // after a crash-teardown) must not run its cleanup twice.
      if (done) return;
      done = true;
      fn();
    },
  };
}

/**
 * Disposes everything, in reverse registration order, even if one throws.
 * The first error is rethrown once the rest have been disposed.
 */
export function disposeAll(items: Disposable[]): void {
  let firstError: unknown;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    try {
      items[i]?.dispose();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  items.length = 0;
  if (firstError !== undefined) throw firstError;
}
