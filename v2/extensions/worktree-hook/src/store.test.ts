import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { createStore } from './store.ts';

/**
 * The same shape as `fakeKV` in `tasks/src/store.test.ts`: a real map behind the
 * real interface, so a round-trip is a round-trip and not a stub agreeing with
 * itself. `schema.parse` is honoured, because a value written by an older build
 * that no longer parses must read back as absent rather than as a crash.
 */
function fakeKv(seed: Record<string, unknown> = {}): KV {
  const raw = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string, schema: Schema<T>): T | undefined => {
      if (!raw.has(key)) return undefined;
      const parsed = schema.parse(raw.get(key));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void raw.set(key, value),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()].sort(),
  };
}

describe('the hook store', () => {
  it('answers undefined before anything is set', () => {
    const store = createStore(fakeKv(), '/Users/x');
    expect(store.global()).toBeUndefined();
    expect(store.forRepo('/src/alpha')).toBeUndefined();
    expect(store.listRepos()).toEqual([]);
  });

  it('round-trips the global hook', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo hi');
    expect(store.global()).toBe('echo hi');
  });

  it('round-trips a repo hook, keyed by the source repo path', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('/src/alpha', 'cp ~/.env .');
    expect(store.forRepo('/src/alpha')).toBe('cp ~/.env .');
    expect(store.forRepo('/src/beta')).toBeUndefined();
  });

  it('keeps the global hook and a repo hook apart', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo global');
    store.setForRepo('/src/alpha', 'echo alpha');
    expect(store.global()).toBe('echo global');
    expect(store.forRepo('/src/alpha')).toBe('echo alpha');
  });

  it('clears on an empty or whitespace-only script', () => {
    // v1's `setWorktreeHook` did this, and the reason survives: a stored empty
    // string is a hook that runs `/bin/bash -lc ''` on every worktree — a no-op
    // that still costs a process and still reads as configured.
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo hi');
    store.setGlobal('   \n  ');
    expect(store.global()).toBeUndefined();

    store.setForRepo('/src/alpha', 'echo hi');
    store.setForRepo('/src/alpha', '');
    expect(store.forRepo('/src/alpha')).toBeUndefined();
  });

  it('trims what it stores, so a trailing newline is not a different script', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('  echo hi\n');
    expect(store.global()).toBe('echo hi');
  });

  it('treats a ~ path and its expansion as ONE repo', () => {
    // The key is the identity. Typing `~/dev/alpha` in the editor and picking
    // `/Users/x/dev/alpha` in the composer must not be two different repos, or
    // a hook silently stops running the moment you spell the path the other way.
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('~/dev/alpha', 'echo hi');
    expect(store.forRepo('/Users/x/dev/alpha')).toBe('echo hi');
    expect(store.listRepos()).toEqual([{ path: '/Users/x/dev/alpha', script: 'echo hi' }]);
  });

  it('ignores surrounding whitespace in a path', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('  /src/alpha  ', 'echo hi');
    expect(store.forRepo('/src/alpha')).toBe('echo hi');
  });

  it('lists repos with hooks, sorted by path, and never the global one', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo global');
    store.setForRepo('/src/beta', 'echo b');
    store.setForRepo('/src/alpha', 'echo a');
    expect(store.listRepos()).toEqual([
      { path: '/src/alpha', script: 'echo a' },
      { path: '/src/beta', script: 'echo b' },
    ]);
  });

  it('drops a stored value that no longer parses rather than crashing', () => {
    // A key written by a future build, read by this one. Answering "no hook" is
    // the honest degradation; throwing here would be thrown inside provisioning.
    const store = createStore(fakeKv({ 'hook:repo:/src/alpha': { script: 42 } }), '/Users/x');
    expect(store.forRepo('/src/alpha')).toBeUndefined();
    expect(store.listRepos()).toEqual([]);
  });

  it('round-trips a set hook, keyed by its repos', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/alpha', '/src/beta'], 'ln -sf alpha/dist beta/vendor');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBe('ln -sf alpha/dist beta/vendor');
  });

  it('treats {a,b} and {b,a} as ONE set', () => {
    // Sorted before the key is built. Two orders of the same repos are one hook,
    // or the editor and the CLI would disagree about what exists.
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/beta', '/src/alpha'], 'echo hi');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBe('echo hi');
  });

  it('expands ~ in every member, so two spellings are one set', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['~/dev/alpha', '/src/beta'], 'echo hi');
    expect(store.forSet(['/Users/x/dev/alpha', '/src/beta'])).toBe('echo hi');
  });

  it('collapses a repeated repo to one member', () => {
    // After expansion, not before — `~/dev/alpha` and `/Users/x/dev/alpha` are
    // the same repo typed twice, and a two-member set of one repo would key
    // differently from the one-member set that means the same thing.
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['~/dev/alpha', '/Users/x/dev/alpha'], 'echo hi');
    expect(store.forSet(['/Users/x/dev/alpha'])).toBe('echo hi');
    expect(store.listSets()).toEqual([{ paths: ['/Users/x/dev/alpha'], script: 'echo hi' }]);
  });

  it('clears a set hook on an empty script', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForSet(['/src/alpha', '/src/beta'], 'echo hi');
    store.setForSet(['/src/alpha', '/src/beta'], '  \n ');
    expect(store.forSet(['/src/alpha', '/src/beta'])).toBeUndefined();
    expect(store.listSets()).toEqual([]);
  });

  it('refuses a set with no repos', () => {
    // It would be a subset of every task — a second global hook, with a key
    // indistinguishable from the prefix itself.
    const store = createStore(fakeKv(), '/Users/x');
    expect(() => store.setForSet([], 'echo everywhere')).toThrow(/at least one repo/);
  });

  it('answers undefined for a read of no repos rather than throwing', () => {
    // Asymmetric on purpose: a WRITE forms an identity and must be refused, but
    // this read runs inside somebody's provisioning and "there is no hook" is
    // the honest degradation.
    const store = createStore(fakeKv(), '/Users/x');
    expect(store.forSet([])).toBeUndefined();
  });

  it('keeps repo hooks and set hooks in separate namespaces', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setForRepo('/src/alpha', 'echo repo');
    store.setForSet(['/src/alpha'], 'echo set');
    expect(store.forRepo('/src/alpha')).toBe('echo repo');
    expect(store.forSet(['/src/alpha'])).toBe('echo set');
    expect(store.listRepos()).toEqual([{ path: '/src/alpha', script: 'echo repo' }]);
    expect(store.listSets()).toEqual([{ paths: ['/src/alpha'], script: 'echo set' }]);
  });

  it('lists sets by size then key, and never a repo or the global hook', () => {
    const store = createStore(fakeKv(), '/Users/x');
    store.setGlobal('echo global');
    store.setForRepo('/src/alpha', 'echo repo');
    store.setForSet(['/src/beta', '/src/gamma'], 'bg');
    store.setForSet(['/src/alpha', '/src/beta'], 'ab');
    store.setForSet(['/src/alpha'], 'a');
    expect(store.listSets()).toEqual([
      { paths: ['/src/alpha'], script: 'a' },
      { paths: ['/src/alpha', '/src/beta'], script: 'ab' },
      { paths: ['/src/beta', '/src/gamma'], script: 'bg' },
    ]);
  });

  it('drops a stored set that no longer parses rather than crashing', () => {
    const store = createStore(fakeKv({ 'hook:set:/src/alpha': { script: 42 } }), '/Users/x');
    expect(store.forSet(['/src/alpha'])).toBeUndefined();
    expect(store.listSets()).toEqual([]);
  });
});
