import { s, type KV } from '@shepherd/sdk';

/**
 * How long a closed buffer survives.
 *
 * Close is a SOFT delete because `layout.closeGroup` runs `store.close` per
 * pane directly in main (`packages/core/src/layout/commands.ts:573`), which is
 * what shelving a task does and which never reaches the renderer. No prompt can
 * guard that path, so the net has to be underneath it rather than in front.
 */
export const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScratchDoc {
  readonly text: string;
  readonly updatedAt: number;
  /** Present once the pane holding it closed. Absent means live. */
  readonly closedAt?: number;
}

const DOC = s.object({
  text: s.string(),
  updatedAt: s.number(),
  closedAt: s.optional(s.number()),
});

/**
 * A class over an injected `KV` rather than functions reaching for
 * `ctx.storage`: the whole file is then testable with a `Map` and no host,
 * which is what makes the garbage-collection assertions cheap enough to write.
 */
export class ScratchStore {
  readonly #kv: KV;

  constructor(kv: KV) {
    this.#kv = kv;
  }

  create(id: string, now: number): void {
    this.#kv.set<ScratchDoc>(id, { text: '', updatedAt: now });
  }

  read(id: string): ScratchDoc | undefined {
    return this.#kv.get(id, DOC);
  }

  /**
   * Writing an id with no row creates one rather than throwing.
   *
   * A pane can outlive its row — a relaunch against an older build, a store
   * edited by hand. Refusing the write would drop the keystrokes that are on
   * screen in front of the user, which is a worse answer than a resurrected row.
   */
  write(id: string, text: string, now: number): void {
    this.#kv.set<ScratchDoc>(id, { text, updatedAt: now });
  }

  close(id: string, now: number): void {
    const doc = this.read(id);
    if (doc === undefined) return;
    this.#kv.set<ScratchDoc>(id, { ...doc, closedAt: now });
  }

  /** Removes closed rows older than `maxAgeMs`. Returns how many went. */
  collect(now: number, maxAgeMs: number): number {
    let removed = 0;
    for (const key of this.#kv.keys()) {
      const doc = this.read(key);
      // An OPEN row is never collected, whatever its age. A pane left alone for
      // a year still has its text on screen.
      if (doc?.closedAt === undefined) continue;
      if (now - doc.closedAt < maxAgeMs) continue;
      this.#kv.delete(key);
      removed += 1;
    }
    return removed;
  }
}
