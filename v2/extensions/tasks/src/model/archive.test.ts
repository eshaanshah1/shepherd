import { describe, expect, it } from 'vitest';
import { planArchive, planRestore, type WorktreeState } from './archive.ts';

/**
 * The three gaps probe 2 measured in v1's archive. Its SHAPE is good — a
 * before/after `git status --porcelain` is byte-identical, untracked files
 * included — so what is tested here is only what it gets wrong.
 */

const state = (over: Partial<WorktreeState> = {}): WorktreeState => ({
  branch: 'fix-login',
  headSha: 'abc1234',
  hasConflicts: false,
  ignoredPaths: [],
  ...over,
});

describe('planArchive', () => {
  it('archives an ordinary worktree', () => {
    const out = planArchive(state());
    expect(out.ok).toBe(true);
  });

  it('REFUSES a conflicted worktree instead of failing inside git', () => {
    // Measured: `write-tree` hard-fails with `fatal: git-write-tree: error
    // building trees`, exit 128 — so v1's algorithm cannot archive a stopped
    // merge at all, which is exactly the task a user wants to shelve.
    const out = planArchive(state({ hasConflicts: true }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/conflict/i);
      expect(out.reason).toMatch(/resolve|finish|abort/i);
    }
  });

  it('WARNS about gitignored files, which the archive silently destroys', () => {
    // Measured: `add -A` skips them, then `worktree remove --force` deletes them.
    // `.env`, `node_modules`, build output — no warning anywhere in v1.
    const out = planArchive(state({ ignoredPaths: ['.env', 'build/out.o'] }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain('.env');
    }
  });

  it('warns about nothing when there is nothing ignored', () => {
    const out = planArchive(state());
    if (out.ok) expect(out.warnings).toEqual([]);
  });

  /**
   * The warning has to SUMMARIZE, because a dependency tree is not a list
   * anybody reads.
   *
   * Measured in this repo's own worktree: 42,643 ignored paths, 42,170 of them
   * under `node_modules` — a single warning string of roughly 1.7 MB, returned
   * across the IPC port and written to the log as one line. Shelving happens on
   * every pane-group close now, so this is not a rare path.
   */
  describe('the ignored-files warning', () => {
    const nodeModules = Array.from({ length: 42_000 }, (_, i) => `node_modules/pkg${i}/index.js`);

    it('names the directory rather than the files inside it', () => {
      const out = planArchive(state({ ignoredPaths: nodeModules }));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.warnings[0]).toContain('node_modules/');
      expect(out.warnings[0]).not.toContain('pkg41999');
    });

    it('stays bounded however many paths it is handed', () => {
      const out = planArchive(state({ ignoredPaths: nodeModules }));
      if (out.ok) expect(out.warnings[0]?.length ?? 0).toBeLessThan(1_000);
    });

    it('still reports the true total', () => {
      const out = planArchive(state({ ignoredPaths: nodeModules }));
      if (out.ok) expect(out.warnings[0]).toContain('42000');
    });

    it('names a handful of loose files individually, since that is readable', () => {
      const out = planArchive(state({ ignoredPaths: ['.env', 'build/out.o'] }));
      if (out.ok) {
        expect(out.warnings[0]).toContain('.env');
        expect(out.warnings[0]).toContain('build/');
      }
    });

    it('groups several directories without listing any of their contents', () => {
      const out = planArchive(
        state({
          ignoredPaths: [
            ...Array.from({ length: 50 }, (_, i) => `node_modules/a${i}/x.js`),
            ...Array.from({ length: 50 }, (_, i) => `dist/b${i}.js`),
            '.env',
          ],
        }),
      );
      if (out.ok) {
        expect(out.warnings[0]).toContain('node_modules/');
        expect(out.warnings[0]).toContain('dist/');
        expect(out.warnings[0]).toContain('.env');
        expect(out.warnings[0]).not.toContain('a49');
      }
    });
  });

  it('records the HEAD sha SEPARATELY from the branch', () => {
    // The detached-worktree fix: v1 restored to the archive commit because it
    // kept only the branch, and skipped `symbolic-ref` when the branch was empty.
    const out = planArchive(state({ branch: '', headSha: 'deadbee' }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.record).toEqual({ branch: '', headSha: 'deadbee' });
  });

  it('records both when the worktree is on a branch', () => {
    const out = planArchive(state());
    if (out.ok) expect(out.record).toEqual({ branch: 'fix-login', headSha: 'abc1234' });
  });
});

describe('planRestore', () => {
  it('reattaches the branch when there was one', () => {
    expect(planRestore({ branch: 'fix-login', headSha: 'abc1234' })).toEqual({
      args: ['symbolic-ref', 'HEAD', 'refs/heads/fix-login'],
    });
  });

  it('returns a DETACHED worktree to its own commit, not to the archive commit', () => {
    // v1 measured: original HEAD `ab6078b`, restored HEAD `2ccf376` — the archive
    // commit. It skipped `symbolic-ref` for an empty branch and did nothing else.
    expect(planRestore({ branch: '', headSha: 'ab6078b' })).toEqual({
      args: ['checkout', '--detach', 'ab6078b'],
    });
  });

  it('never does nothing — every archive has somewhere to land', () => {
    for (const record of [
      { branch: 'x', headSha: 'a1' },
      { branch: '', headSha: 'a1' },
    ]) {
      expect(planRestore(record).args.length).toBeGreaterThan(0);
    }
  });
});
