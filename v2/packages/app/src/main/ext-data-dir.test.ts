import { describe, expect, it } from 'vitest';
import { extensionDataDir } from './ext-data-dir.ts';

/**
 * D1b: `boundaries.js` denies `node:os` to extensions AND to the process that
 * hosts them, so an extension cannot resolve `~` — and `tasks` is defined in
 * terms of a path (`~/.shepherd/…/tasks/<slug>/`). The host hands it one.
 */

const SUPPORT = '/u/me/.shepherd/v2';

describe('extensionDataDir', () => {
  it('uses the id’s last segment, which is what makes the path readable', () => {
    // Humans browse these and agents `cd` into them, so
    // `~/.shepherd/v2/tasks/fix-login/api` is the point — not a correctness
    // detail. `<support>/shepherd.tasks/…` would work and nobody would enjoy it.
    expect(extensionDataDir('shepherd.tasks', ['shepherd.tasks'], SUPPORT)).toBe(`${SUPPORT}/tasks`);
  });

  it('falls back to the full id when two extensions want the same segment', () => {
    // Determinism over prettiness the moment they conflict: whoever activated
    // first must not win a directory, because activation order is not stable.
    const ids = ['shepherd.tasks', 'acme.tasks'];
    expect(extensionDataDir('shepherd.tasks', ids, SUPPORT)).toBe(`${SUPPORT}/shepherd.tasks`);
    expect(extensionDataDir('acme.tasks', ids, SUPPORT)).toBe(`${SUPPORT}/acme.tasks`);
  });

  it('gives every extension a distinct directory, collisions or not', () => {
    const ids = ['shepherd.tasks', 'acme.tasks', 'shepherd.agents-core'];
    const dirs = ids.map((id) => extensionDataDir(id, ids, SUPPORT));
    expect(new Set(dirs).size).toBe(ids.length);
  });

  it('handles an id with no dot at all', () => {
    expect(extensionDataDir('tasks', ['tasks'], SUPPORT)).toBe(`${SUPPORT}/tasks`);
  });

  it('never escapes the support directory, whatever the id says', () => {
    // An id is declared in a manifest, and a third party writes the manifest.
    for (const id of ['../../etc', 'a/../../b', 'shepherd../..']) {
      const dir = extensionDataDir(id, [id], SUPPORT);
      expect(dir.startsWith(`${SUPPORT}/`)).toBe(true);
      expect(dir).not.toContain('..');
    }
  });

  it('is stable across calls — a directory that moved would strand its contents', () => {
    const ids = ['shepherd.tasks', 'acme.tasks'];
    expect(extensionDataDir('shepherd.tasks', ids, SUPPORT)).toBe(
      extensionDataDir('shepherd.tasks', [...ids].reverse(), SUPPORT),
    );
  });
});
