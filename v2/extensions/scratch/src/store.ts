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

/** One row of the list — what a tree of notes is drawn from. */
export interface ScratchListing {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

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

  /**
   * Every LIVE document, newest first.
   *
   * The KV is keyed by id and nothing ever needed to enumerate it — a pane
   * always arrived already holding one. `editor`'s `Notes` root is the first
   * caller, and the reason this exists.
   *
   * Closed rows are OMITTED. Close is a soft delete kept for seven days so that
   * `closeGroup` cannot lose a buffer (see `GC_MAX_AGE_MS`), but a closed
   * buffer is not a note you have, and a row that reopens a tombstone is worse
   * than no row at all.
   */
  list(): readonly ScratchListing[] {
    const rows: ScratchListing[] = [];
    for (const id of this.#kv.keys()) {
      const doc = this.read(id);
      if (doc === undefined || doc.closedAt !== undefined) continue;
      rows.push({ id, title: titleOf(doc.text), updatedAt: doc.updatedAt });
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt);
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

/**
 * What a note is CALLED in a list.
 *
 * The first non-empty line with its heading marks stripped — the same answer
 * `scratch-pane.tsx`'s `presentation()` gives the tab, for the same reason: a
 * document names itself in its first line or it has no name at all. Not shared
 * with that function because it is the halves of two different decisions —
 * that one also picks a glyph and an action from a parsed skill head, and this
 * one must stay cheap enough to run over every row.
 */
function titleOf(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed !== '') return trimmed;
  }
  return 'untitled';
}
