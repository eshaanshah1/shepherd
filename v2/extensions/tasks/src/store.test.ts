import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { TASK_SCHEMA_VERSION, TaskStore, type TaskRecord } from './store.ts';

function fakeKV(seed: Record<string, unknown> = {}): KV & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>(Object.entries(seed));
  return {
    raw,
    get: <T>(key: string, schema: Schema<T>): T | undefined => {
      if (!raw.has(key)) return undefined;
      const parsed = schema.parse(raw.get(key));
      // Matches the real KV: a value that does not validate reads as ABSENT.
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void raw.set(key, value),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()].sort(),
  };
}

const draft = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  schemaVersion: TASK_SCHEMA_VERSION,
  id: 't1',
  slug: 'fix-login',
  title: 'Fix login',
  brief: 'Make it work.',
  lifecycle: 'draft',
  repos: [],
  sessions: [],
  createdAt: 1,
  ...over,
});

describe('TaskStore', () => {
  it('round-trips a task', () => {
    const store = new TaskStore(fakeKV());
    store.put(draft());
    expect(store.get('t1')).toEqual(draft());
  });

  /**
   * A snooze survives the round trip — **both halves of it**.
   *
   * The schema here is a `s.stored`, so a field the interface declares and the
   * schema does not is read back as ABSENT: the record would save, the task
   * would look snoozed until the next launch, and then quietly be awake again
   * with nothing anywhere saying why. That is the `head` trap in the persistence
   * layer, and this is the case that catches it.
   *
   * Both FORMS are asserted, because they are stored differently: a time and a
   * condition. Testing only the first would leave "when agents finish" — the
   * option the whole verb is worth having for — unpinned.
   */
  it('round-trips a snooze that sleeps on the clock', () => {
    const store = new TaskStore(fakeKV());
    const snooze = { label: 'later today', wakeAt: 1_800_000_000_000, was: 'Plan approval' } as const;
    store.put(draft({ snooze }));
    expect(store.get('t1')?.snooze).toEqual(snooze);
  });

  it('round-trips a snooze that sleeps on the room', () => {
    const store = new TaskStore(fakeKV());
    store.put(draft({ snooze: { label: 'when agents finish', wakeOnQuiet: true } }));
    expect(store.get('t1')?.snooze).toEqual({ label: 'when agents finish', wakeOnQuiet: true });
  });

  it('reads a record written before snoozing existed', () => {
    // The reason the field is optional and the schema is `s.stored`: every
    // record on every machine predates it.
    const store = new TaskStore(fakeKV());
    store.put(draft());
    expect(store.get('t1')?.snooze).toBeUndefined();
  });

  it('lists tasks, which is the query KV can actually express', () => {
    const store = new TaskStore(fakeKV());
    store.put(draft({ id: 't1' }));
    store.put(draft({ id: 't2' }));
    expect(store.list().map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('keeps its keys namespaced, so a stray KV key is not read as a task', () => {
    const kv = fakeKV({ 'not-a-task': { hello: true } });
    const store = new TaskStore(kv);
    store.put(draft());
    expect(store.list()).toHaveLength(1);
  });

  it('knows which slugs are taken, so a second task cannot claim one', () => {
    const store = new TaskStore(fakeKV());
    store.put(draft({ id: 't1', slug: 'fix-login' }));
    expect(store.takenSlugs().has('fix-login')).toBe(true);
    expect(store.takenSlugs().has('other')).toBe(false);
  });

  it('deletes', () => {
    const store = new TaskStore(fakeKV());
    store.put(draft());
    store.remove('t1');
    expect(store.get('t1')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  describe('D15 — an unreadable record must not orphan a worktree', () => {
    it('KEEPS a record written by a newer build', () => {
      // `s.object` rejects unknown keys and `KV.get` treats a mismatch as ABSENT,
      // so without the lenient read a task written by a newer build would read as
      // "no such task" while its worktrees sat on disk unreferenced.
      const kv = fakeKV({ 'task:t1': { ...draft(), somethingNewer: 'x' } });
      expect(new TaskStore(kv).get('t1')?.id).toBe('t1');
    });

    it('QUARANTINES a record it genuinely cannot read, rather than dropping it', () => {
      const kv = fakeKV({ 'task:t1': { id: 't1' } });
      const store = new TaskStore(kv);
      expect(store.get('t1')).toBeUndefined();
      expect(store.list()).toEqual([]);
      // The point: it is reportable. A task that silently does not exist is one
      // nobody cleans up.
      expect(store.unreadable()).toEqual(['t1']);
    });

    it('reports nothing unreadable when everything parses', () => {
      const store = new TaskStore(fakeKV());
      store.put(draft());
      store.list();
      expect(store.unreadable()).toEqual([]);
    });

    it('refuses a record from a FUTURE schema version rather than guessing', () => {
      const kv = fakeKV({ 'task:t1': { ...draft(), schemaVersion: TASK_SCHEMA_VERSION + 1 } });
      const store = new TaskStore(kv);
      expect(store.get('t1')).toBeUndefined();
      expect(store.unreadable()).toEqual(['t1']);
    });

    it('stamps the current version on everything it writes', () => {
      const kv = fakeKV();
      new TaskStore(kv).put({ ...draft(), schemaVersion: 0 as 1 });
      expect((kv.raw.get('task:t1') as TaskRecord).schemaVersion).toBe(TASK_SCHEMA_VERSION);
    });
  });

  describe('the repo picker\'s history', () => {
    it('round-trips through the same KV a third party gets', () => {
      const kv = fakeKV();
      const store = new TaskStore(kv);
      store.recordRepoUses(['/repos/api'], 1_000);
      expect(store.repoHistory()).toEqual([{ path: '/repos/api', uses: 1, lastUsedAt: 1_000 }]);
      // In ONE key, not one per path: `list()` walks `keys()`, and fifty more
      // of them would be fifty more strings to skip on every task read.
      expect(kv.keys()).toEqual(['repo-history']);
    });

    it('counts a repo picked again rather than duplicating it', () => {
      const store = new TaskStore(fakeKV());
      store.recordRepoUses(['/repos/api'], 1_000);
      store.recordRepoUses(['/repos/api', '/repos/web'], 2_000);
      expect(store.repoHistory()).toEqual([
        { path: '/repos/api', uses: 2, lastUsedAt: 2_000 },
        { path: '/repos/web', uses: 1, lastUsedAt: 2_000 },
      ]);
    });

    it('counts one task naming a repo twice as one pick', () => {
      const store = new TaskStore(fakeKV());
      store.recordRepoUses(['/repos/api', '/repos/api'], 1_000);
      expect(store.repoHistory()[0]?.uses).toBe(1);
    });

    it('reads a malformed history as empty rather than refusing to open', () => {
      // An accelerator. A picker that would not open because a preference blob
      // was bad is worse than one that has forgotten.
      const store = new TaskStore(fakeKV({ 'repo-history': { nope: true } }));
      expect(store.repoHistory()).toEqual([]);
    });

    it('is not read as a task by `list()`', () => {
      const store = new TaskStore(fakeKV());
      store.put(draft());
      store.recordRepoUses(['/repos/api'], 1_000);
      expect(store.list()).toHaveLength(1);
      expect(store.unreadable()).toEqual([]);
    });
  });
});
