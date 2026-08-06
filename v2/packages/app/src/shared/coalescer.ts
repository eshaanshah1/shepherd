import type { Clock, Disposable } from '@shepherd/sdk';
import { COALESCE } from './channels.ts';

/**
 * Batches pty output before it crosses the IPC boundary.
 *
 * A `webContents.send` per `onData` is the obvious wiring and the wrong one:
 * `yes` produces thousands of tiny chunks a second, each of which costs a
 * structured clone, a message hop and a renderer task — the renderer then
 * spends its frame budget in IPC deserialization instead of in xterm, and the
 * terminal falls behind output it could otherwise draw in one write.
 *
 * So: accumulate, and flush on whichever of the two budgets in `COALESCE`
 * comes first. The size budget bounds latency under load (a fast producer
 * flushes on bytes long before the timer), the timer bounds it when idle (a
 * single keystroke's echo must not wait for 32 KB that never comes).
 *
 * Time is the injected `Clock`, not `setTimeout` — so the batching test asserts
 * exact send counts instead of sleeping and hoping.
 */
export interface CoalescerOptions {
  readonly clock: Clock;
  readonly flush: (bytes: Uint8Array) => void;
  readonly intervalMs?: number;
  readonly maxBytes?: number;
}

export class OutputCoalescer {
  readonly #clock: Clock;
  readonly #flush: (bytes: Uint8Array) => void;
  readonly #intervalMs: number;
  readonly #maxBytes: number;

  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #timer: Disposable | undefined;
  #disposed = false;

  constructor(options: CoalescerOptions) {
    this.#clock = options.clock;
    this.#flush = options.flush;
    this.#intervalMs = options.intervalMs ?? COALESCE.intervalMs;
    this.#maxBytes = options.maxBytes ?? COALESCE.maxBytes;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  push(bytes: Uint8Array): void {
    if (this.#disposed || bytes.length === 0) return;
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;

    if (this.#pendingBytes >= this.#maxBytes) {
      this.flushNow();
      return;
    }
    this.#timer ??= this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.flushNow();
    }, this.#intervalMs);
  }

  flushNow(): void {
    this.#timer?.dispose();
    this.#timer = undefined;
    if (this.#pendingBytes === 0) return;

    const out = new Uint8Array(this.#pendingBytes);
    let at = 0;
    for (const chunk of this.#pending) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#flush(out);
  }

  /**
   * Flushes what is pending and stops accepting more. Detaching a view without
   * this drops the tail of what it had already been sent — the last thing the
   * user typed, most visibly.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.flushNow();
    this.#disposed = true;
    this.#timer?.dispose();
    this.#timer = undefined;
  }
}
