/**
 * The replay ring: the last `cap` bytes a session produced, so a view that
 * attaches late sees the screen it missed.
 *
 * v1's PtyRing was an array with `buf.removeFirst(buf.count - cap)` on every
 * over-cap append — O(n) in the ring's size, per append, forever. It survived
 * because a phone attaching to a mostly-idle pane never noticed. `yes` noticed.
 *
 * This is a fixed circular buffer: one allocation at construction, and an
 * append is one or two `set()` calls plus index arithmetic, whatever the ring
 * already holds. `ring.test.ts` pushes 50 MB through a 256 KB ring in 64 KB
 * chunks and requires it to finish in under a second — a front-trim buffer does
 * not, which is the only reason that test is worth its runtime.
 */
export class PtyRing {
  readonly cap: number;
  #buf: Uint8Array;
  /** Index of the oldest live byte. */
  #start = 0;
  #length = 0;

  constructor(cap = 256 * 1024) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError('PtyRing cap must be a positive integer');
    }
    this.cap = cap;
    this.#buf = new Uint8Array(cap);
  }

  get length(): number {
    return this.#length;
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;

    // A write bigger than the ring can only leave its own tail behind, so skip
    // the wrap arithmetic entirely rather than looping over bytes nobody will
    // ever read.
    if (bytes.length >= this.cap) {
      this.#buf.set(bytes.subarray(bytes.length - this.cap));
      this.#start = 0;
      this.#length = this.cap;
      return;
    }

    const writeAt = (this.#start + this.#length) % this.cap;
    const untilEnd = this.cap - writeAt;
    if (bytes.length <= untilEnd) {
      this.#buf.set(bytes, writeAt);
    } else {
      this.#buf.set(bytes.subarray(0, untilEnd), writeAt);
      this.#buf.set(bytes.subarray(untilEnd), 0);
    }

    const total = this.#length + bytes.length;
    if (total <= this.cap) {
      this.#length = total;
    } else {
      // Overflowed: the oldest `total - cap` bytes were just written over.
      this.#start = (this.#start + (total - this.cap)) % this.cap;
      this.#length = this.cap;
    }
  }

  /** A copy, in write order. The caller may keep it; a later append can't touch it. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.#length);
    const untilEnd = Math.min(this.#length, this.cap - this.#start);
    out.set(this.#buf.subarray(this.#start, this.#start + untilEnd), 0);
    if (untilEnd < this.#length) {
      out.set(this.#buf.subarray(0, this.#length - untilEnd), untilEnd);
    }
    return out;
  }

  clear(): void {
    this.#start = 0;
    this.#length = 0;
  }
}
