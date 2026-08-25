import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { GC_MAX_AGE_MS, ScratchStore } from './store.ts';

/** A KV backed by a Map. The store must not need a host to be tested. */
function fakeKv(): KV {
  const rows = new Map<string, unknown>();
  return {
    get<T>(key: string, _schema: Schema<T>): T | undefined {
      return rows.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      rows.set(key, value);
    },
    delete(key: string): void {
      rows.delete(key);
    },
    keys(): readonly string[] {
      return [...rows.keys()].sort();
    },
  };
}

describe('ScratchStore', () => {
  it('creates an empty buffer that reads back', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    expect(store.read('scr_a')).toEqual({ text: '', updatedAt: 1000 });
  });

  it('round-trips text', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.write('scr_a', '# hello', 2000);
    expect(store.read('scr_a')).toEqual({ text: '# hello', updatedAt: 2000 });
  });

  it('reads undefined for an id it has never seen', () => {
    expect(new ScratchStore(fakeKv()).read('scr_nope')).toBeUndefined();
  });

  it('writing an unknown id creates it rather than throwing', () => {
    // A pane can outlive a row: a hand-edited store, a relaunch against an
    // older build. Losing the keystrokes that are on screen would be worse than
    // a resurrected row.
    const store = new ScratchStore(fakeKv());
    store.write('scr_ghost', 'typed anyway', 5000);
    expect(store.read('scr_ghost')?.text).toBe('typed anyway');
  });

  it('close is a SOFT delete: the row and its text survive', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.write('scr_a', 'notes', 2000);
    store.close('scr_a', 3000);
    expect(store.read('scr_a')).toEqual({ text: 'notes', updatedAt: 2000, closedAt: 3000 });
  });

  it('collects a closed row once it is older than the max age', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.close('scr_a', 1000);
    const removed = store.collect(1000 + GC_MAX_AGE_MS + 1, GC_MAX_AGE_MS);
    expect(removed).toBe(1);
    expect(store.read('scr_a')).toBeUndefined();
  });

  it('does NOT collect a closed row that is still inside the window', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.close('scr_a', 1000);
    expect(store.collect(1000 + GC_MAX_AGE_MS - 1, GC_MAX_AGE_MS)).toBe(0);
    expect(store.read('scr_a')).toBeDefined();
  });

  it('NEVER collects an open row, however old', () => {
    // The property the whole lifetime rule rests on: a pane that has been open
    // and untouched for a year must not lose its text to housekeeping.
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 0);
    store.write('scr_a', 'a year of notes', 0);
    expect(store.collect(GC_MAX_AGE_MS * 365, GC_MAX_AGE_MS)).toBe(0);
    expect(store.read('scr_a')?.text).toBe('a year of notes');
  });

  it('is seven days', () => {
    expect(GC_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('ScratchStore.list', () => {
  it('answers the LIVE documents, newest first', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1_000);
    store.write('scr_a', 'first note', 1_000);
    store.create('scr_b', 2_000);
    store.write('scr_b', 'second note', 2_000);

    expect(store.list().map((doc) => doc.id)).toEqual(['scr_b', 'scr_a']);
  });

  it('omits a closed document', () => {
    // Close is a SOFT delete kept for seven days so `closeGroup` cannot lose a
    // buffer — but a closed buffer is not a note you HAVE, and a row that
    // reopens a tombstone is worse than no row.
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1_000);
    store.close('scr_a', 2_000);
    expect(store.list()).toEqual([]);
  });

  it('titles a document by its first non-empty line, heading marks stripped', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1_000);
    store.write('scr_a', '\n\n# Deploy checks\n\nbody\n', 1_000);
    expect(store.list()[0]?.title).toBe('Deploy checks');
  });

  it('titles an empty document `untitled` rather than leaving a blank row', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1_000);
    expect(store.list()[0]?.title).toBe('untitled');
  });

  it('carries updatedAt, so a caller can order or age a row itself', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1_000);
    store.write('scr_a', 'x', 5_000);
    expect(store.list()[0]).toEqual({ id: 'scr_a', title: 'x', updatedAt: 5_000 });
  });
});
