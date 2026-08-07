import { describe, expect, it } from 'vitest';
import { resolveBranch, type RepoRefs } from './branch.ts';

/**
 * The v1 bug, pinned so it cannot come back.
 *
 * v1's `branchExists` checked `refs/heads/` only, so a branch existing ONLY on
 * origin fell through to `-b <name> <default>` — git exits 0, the worktree holds
 * the WRONG content under the right name with an upstream pointing elsewhere, and
 * the first symptom is a push failing much later. Measured in probe 2 and
 * verified against `spike/seam1/Sources/WorktreeService.swift:74-77,115-117`.
 */

const refs = (over: Partial<RepoRefs> = {}): RepoRefs => ({
  localBranches: [],
  remoteBranches: [],
  checkedOutBranches: [],
  defaultBase: undefined,
  ...over,
});

describe('resolveBranch', () => {
  it('checks out an existing LOCAL branch without inventing one', () => {
    const out = resolveBranch('fix-login', '/t/api', refs({ localBranches: ['fix-login'] }));
    expect(out).toEqual({ ok: true, args: ['worktree', 'add', '/t/api', 'fix-login'] });
  });

  it('TRACKS a branch that exists only on a remote — the v1 bug', () => {
    const out = resolveBranch(
      'fix-login',
      '/t/api',
      refs({ remoteBranches: ['origin/fix-login'], defaultBase: 'origin/main' }),
    );
    // Not `-b fix-login origin/main`, which is what v1 did: right name, wrong
    // content, wrong upstream, exit 0.
    expect(out).toEqual({
      ok: true,
      args: ['worktree', 'add', '--track', '-b', 'fix-login', '/t/api', 'origin/fix-login'],
    });
  });

  it('prefers the local branch when the name exists in both places', () => {
    const out = resolveBranch(
      'fix-login',
      '/t/api',
      refs({ localBranches: ['fix-login'], remoteBranches: ['origin/fix-login'] }),
    );
    expect(out).toEqual({ ok: true, args: ['worktree', 'add', '/t/api', 'fix-login'] });
  });

  it('creates off the default base when the branch exists nowhere', () => {
    const out = resolveBranch('brand-new', '/t/api', refs({ defaultBase: 'origin/main' }));
    expect(out).toEqual({
      ok: true,
      args: ['worktree', 'add', '/t/api', '-b', 'brand-new', 'origin/main'],
    });
  });

  it('creates off HEAD in a repo with no remote — v1 could not do this at all', () => {
    // v1 ran `git fetch origin` as a PRECONDITION and aborted when it failed, so
    // a remoteless repo was unusable; its last resort was the literal string
    // `origin/main`, which is an invalid ref there.
    const out = resolveBranch('brand-new', '/t/api', refs());
    expect(out).toEqual({ ok: true, args: ['worktree', 'add', '/t/api', '-b', 'brand-new', 'HEAD'] });
    expect(JSON.stringify(out)).not.toContain('origin/main');
  });

  it('matches a remote branch on any remote, not just origin', () => {
    const out = resolveBranch('fix-login', '/t/api', refs({ remoteBranches: ['upstream/fix-login'] }));
    expect(out).toEqual({
      ok: true,
      args: ['worktree', 'add', '--track', '-b', 'fix-login', '/t/api', 'upstream/fix-login'],
    });
  });

  it('does not mistake a differently-named remote branch for a match', () => {
    const out = resolveBranch('fix', '/t/api', refs({ remoteBranches: ['origin/fix-login'] }));
    expect(out).toEqual({ ok: true, args: ['worktree', 'add', '/t/api', '-b', 'fix', 'HEAD'] });
  });

  it('refuses a branch already checked out elsewhere, rather than reaching for --force', () => {
    // Measured: `fatal: '<b>' is already used by worktree at '<path>'`, exit 128.
    // A branch is checkable-out once per repo, so two tasks on one branch is a
    // policy question — and --force would give two worktrees one branch, which
    // is how they overwrite each other's commits.
    const out = resolveBranch(
      'fix-login',
      '/t/api',
      refs({ localBranches: ['fix-login'], checkedOutBranches: ['fix-login'] }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('already checked out');
    expect(JSON.stringify(out)).not.toContain('--force');
  });

  it('never emits git’s DWIM form, which would name the branch after the directory', () => {
    // With `<root>/<slug>/<repo>` the path basename is the REPO name, so a bare
    // `worktree add <path>` would create a branch called `api`.
    for (const out of [
      resolveBranch('fix-login', '/t/api', refs({ localBranches: ['fix-login'] })),
      resolveBranch('fix-login', '/t/api', refs({ remoteBranches: ['origin/fix-login'] })),
      resolveBranch('fix-login', '/t/api', refs()),
    ]) {
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.args.length).toBeGreaterThan(3);
    }
  });
});
