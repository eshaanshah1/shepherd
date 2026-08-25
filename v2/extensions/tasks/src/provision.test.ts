import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecErr, ExecOk, ExecOptions, ProcessAPI } from '@shepherd/sdk';
import { addWorktree, deleteBranch, materializeTaskRoot, provisionRepo, readRepoRefs, removeWorktree } from './provision.ts';
import { synthTaskRoot } from './model/root-synth.ts';

/**
 * The materializer — the half that touches disk, so the plan can stay pure.
 *
 * Everything asserted here traces to probe 1: per-entry symlinks (only they can
 * merge N repos into one namespace), agents aggregated as well as skills (a
 * nested repo's are NEVER loaded), and the root CLAUDE.md written because it is
 * the only one loaded at session start.
 */

let root: string;
let repoDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shepherd-taskroot-'));
  repoDir = mkdtempSync(join(tmpdir(), 'shepherd-repo-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function seedRepo(skills: string[] = [], agents: string[] = []): void {
  mkdirSync(join(repoDir, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true });
  for (const skill of skills) {
    mkdirSync(join(repoDir, '.claude', 'skills', skill), { recursive: true });
    writeFileSync(join(repoDir, '.claude', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  for (const agent of agents) writeFileSync(join(repoDir, '.claude', 'agents', agent), `# ${agent}\n`);
}

const plan = (skills: string[] = [], agents: string[] = []) =>
  synthTaskRoot({
    brief: 'Make it work.',
    branch: 'slate-merino',
    repos: [{ name: 'api', path: repoDir, skills, agents, hasSettings: false }],
  });

describe('materializeTaskRoot', () => {
  it('writes the root CLAUDE.md — the only one loaded at session start', () => {
    materializeTaskRoot(root, plan());
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('Make it work.');
  });

  it('links a skill per entry, and the link resolves to the repo’s real directory', () => {
    seedRepo(['deploy']);
    materializeTaskRoot(root, plan(['deploy']));
    const link = join(root, '.claude', 'skills', 'deploy');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(repoDir, '.claude', 'skills', 'deploy'));
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toContain('deploy');
  });

  it('links agents too', () => {
    seedRepo([], ['reviewer.md']);
    materializeTaskRoot(root, plan([], ['reviewer.md']));
    expect(existsSync(join(root, '.claude', 'agents', 'reviewer.md'))).toBe(true);
  });

  it('is idempotent — re-materializing an existing root does not throw', () => {
    seedRepo(['deploy']);
    materializeTaskRoot(root, plan(['deploy']));
    expect(() => materializeTaskRoot(root, plan(['deploy']))).not.toThrow();
  });

  it('replaces a link whose target moved, rather than leaving the old one', () => {
    // A REAL new location, deliberately: pointing at a nonexistent path would
    // test the missing-target rule below at the same time, and a test that
    // asserts two rules at once tells you nothing when it fails.
    seedRepo(['deploy']);
    const moved = mkdtempSync(join(tmpdir(), 'shepherd-repo-moved-'));
    mkdirSync(join(moved, '.claude', 'skills', 'deploy'), { recursive: true });
    try {
      materializeTaskRoot(root, plan(['deploy']));
      materializeTaskRoot(
        root,
        synthTaskRoot({
          brief: 'b',
          branch: 'slate-merino',
          repos: [{ name: 'api', path: moved, skills: ['deploy'], agents: [], hasSettings: false }],
        }),
      );
      expect(readlinkSync(join(root, '.claude', 'skills', 'deploy'))).toBe(
        join(moved, '.claude', 'skills', 'deploy'),
      );
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('refuses to create a DANGLING link, and says which', () => {
    // A symlink to nothing resolves to nothing and reports no error, so the
    // skill silently stops existing — which is the same silent-failure shape the
    // collision rule exists to prevent, one layer along.
    const out = materializeTaskRoot(root, plan(['absent']));
    expect(existsSync(join(root, '.claude', 'skills', 'absent'))).toBe(false);
    expect(out.failed[0]).toContain('absent');
  });

  it('reports what it linked and what it could not', () => {
    seedRepo(['deploy']);
    const out = materializeTaskRoot(root, plan(['deploy', 'absent']));
    expect(out.linked).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toContain('absent');
  });

  it('does NOT fail the whole task because one link could not be made', () => {
    // A missing skill is a degraded task, not a broken one. Refusing to create
    // the task would make one stale directory entry block the work.
    expect(() => materializeTaskRoot(root, plan(['absent']))).not.toThrow();
  });

  it('never writes a .claude ABOVE the task root', () => {
    // Probe 1: Claude walks UP from cwd for `.claude/` and CLAUDE.md, measured
    // from three levels. Anything this wrote above the root would leak into
    // every other task.
    materializeTaskRoot(root, plan());
    expect(existsSync(join(root, '..', '.claude'))).toBe(false);
    expect(existsSync(join(root, '..', 'CLAUDE.md'))).toBe(false);
  });
});

interface GitCall {
  readonly fn: 'gitRead' | 'gitWrite';
  readonly args: readonly string[];
  readonly opts: ExecOptions;
}

/**
 * Git, without git — the same shape `fakeKV` has in `store.test.ts`: canned
 * answers plus a record of what was asked.
 *
 * Recording the calls is not incidental here. `removeWorktree` runs two git
 * invocations in two different directories, and WHICH directory each ran in is
 * the thing that has to be true — asserting only the return value would pass
 * for a version that ran both in the wrong place.
 */
type Canned = ExecOk | ExecErr | ((args: readonly string[]) => ExecOk | ExecErr);

function fakeGit(canned: {
  read?: Canned;
  write?: Canned;
}): ProcessAPI & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const ok: ExecOk = { ok: true, stdout: '', stderr: '' };
  const answer = (given: Canned | undefined, args: readonly string[]): ExecOk | ExecErr =>
    given === undefined ? ok : typeof given === 'function' ? given(args) : given;
  return {
    calls,
    exec: () => Promise.resolve(ok),
    gitRead: (args, opts) => {
      calls.push({ fn: 'gitRead', args, opts });
      return Promise.resolve(answer(canned.read, args));
    },
    gitWrite: (args, opts) => {
      calls.push({ fn: 'gitWrite', args, opts });
      return Promise.resolve(answer(canned.write, args));
    },
  };
}

describe('removeWorktree', () => {
  const repoPath = '/src/api';
  const worktree = '/data/fix-login/api';

  it('removes the worktree from the SOURCE repo, and reads the branch in the worktree', async () => {
    // The two cwds are the whole invariant. `git worktree remove` names a path
    // it is about to delete, so it cannot be run from inside it; the branch, by
    // contrast, is the worktree's own HEAD and reading it from the source repo
    // would report whatever that repo happens to have checked out.
    const git = fakeGit({ read: { ok: true, stdout: 'fix-login\n', stderr: '' } });
    const out = await removeWorktree(git, repoPath, worktree);

    expect(out).toEqual({ ok: true, branch: 'fix-login' });
    const removal = git.calls.find((call) => call.fn === 'gitWrite');
    expect(removal?.args).toEqual(['worktree', 'remove', '--force', worktree]);
    expect(removal?.opts.cwd).toBe(repoPath);
    expect(git.calls.find((call) => call.fn === 'gitRead')?.opts.cwd).toBe(worktree);
  });

  it('reads the branch BEFORE the removal, since afterwards there is nothing to read', async () => {
    // Ordering, not sequencing for its own sake: the directory whose HEAD is
    // being read is the one the next call deletes.
    const git = fakeGit({ read: { ok: true, stdout: 'fix-login\n', stderr: '' } });
    await removeWorktree(git, repoPath, worktree);
    expect(git.calls.map((call) => call.fn)).toEqual(['gitRead', 'gitWrite']);
  });

  it('reports NO branch for a detached HEAD, rather than a branch called "HEAD"', async () => {
    // `rev-parse --abbrev-ref HEAD` prints the literal string `HEAD` when
    // nothing is checked out, so a caller listing what it left behind would
    // otherwise tell the user about a branch that does not exist.
    const git = fakeGit({ read: { ok: true, stdout: 'HEAD\n', stderr: '' } });
    expect(await removeWorktree(git, repoPath, worktree)).toEqual({ ok: true, branch: null });
  });

  it('fails with git’s own stderr when the removal will not go through', async () => {
    const git = fakeGit({
      write: { ok: false, code: 128, stdout: '', stderr: "fatal: '/data/fix-login/api' is not a working tree\n" },
    });
    const out = await removeWorktree(git, repoPath, worktree);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("fatal: '/data/fix-login/api' is not a working tree");
  });

  it('still fails, with the exit code, when git says nothing at all', async () => {
    // A reason of "" would surface to the user as a failure with no cause,
    // which reads as a bug in Shepherd rather than a refusal from git.
    const git = fakeGit({ write: { ok: false, code: 128, stdout: '', stderr: '   ' } });
    const out = await removeWorktree(git, repoPath, worktree);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('git exited 128');
  });

  it('succeeds with no branch when the branch could not be read at all', async () => {
    // The removal is what this verb was asked to do, and it happened. Failing
    // the whole call because the NAME of the branch was unavailable would leave
    // the caller believing a worktree is still there when it is gone — the
    // half-delete state the record-goes-last ordering exists to avoid.
    const git = fakeGit({
      read: { ok: false, code: 128, stdout: '', stderr: 'fatal: not a git repository\n' },
    });
    expect(await removeWorktree(git, repoPath, worktree)).toEqual({ ok: true, branch: null });
  });

  it('does not delete the branch, which lives in the source repo and may carry commits', async () => {
    // The doc comment's promise, pinned: `git branch -D` here would be a second,
    // larger destruction than deleting a task asked for.
    const git = fakeGit({ read: { ok: true, stdout: 'fix-login\n', stderr: '' } });
    await removeWorktree(git, repoPath, worktree);
    expect(git.calls.some((call) => call.args.includes('branch'))).toBe(false);
  });
});

/**
 * The split, and the reason for it: reading a repo's refs needs only its path, so
 * it can run while a slow question is being asked elsewhere. Probe 2 sized the
 * win — one fetch is ~2.5s of network per repo and a `worktree add` is 0.16s, so
 * a name has to arrive before the last fraction of a second rather than before
 * the first call.
 */
describe('readRepoRefs', () => {
  const repo = { name: 'api', path: '/src/api' };

  it('needs only the repo path — no branch, no destination', async () => {
    const git = fakeGit({ read: { ok: true, stdout: 'main\nfix-login\n', stderr: '' } });
    const refs = await readRepoRefs(git, repo);
    expect(refs.localBranches).toContain('fix-login');
    // The fetch comes FIRST, which is what gives the model the network's time.
    expect(git.calls[0]?.args).toEqual(['fetch', '--quiet', 'origin']);
    expect(git.calls.every((call) => call.opts.cwd === '/src/api')).toBe(true);
  });

  it('touches nothing but origin/HEAD, so it is safe to start before anything is decided', async () => {
    // The one write it may make is `remote set-head`, which records what origin
    // already says. Nothing about the task, its branch or its worktrees.
    const git = fakeGit({});
    await readRepoRefs(git, repo);
    for (const call of git.calls.filter((c) => c.fn === 'gitWrite')) {
      expect(call.args).toEqual(['remote', 'set-head', 'origin', '--auto']);
    }
  });

  it('survives a repo with no remote, because the fetch is opportunistic', async () => {
    // v1 aborted when the fetch failed, which makes a remoteless or offline repo
    // unusable. The refs come back empty and `resolveBranch` falls back to HEAD.
    const git = fakeGit({ read: { ok: false, code: 128, stdout: '', stderr: 'no such remote' } });
    const refs = await readRepoRefs(git, repo);
    expect(refs.localBranches).toEqual([]);
    expect(refs.defaultBase).toBeUndefined();
  });

  /**
   * `refs/remotes/origin/HEAD` is written by `git clone` and by `git remote
   * set-head` — never by a plain fetch on older git. A repo that acquired its
   * remote with `git remote add` therefore has no origin/HEAD, and the base for
   * a brand-new branch silently became whatever branch the SOURCE repo happened
   * to have checked out.
   */
  describe('origin/HEAD', () => {
    const symbolic = (args: readonly string[]): boolean =>
      args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD');
    const setHead = (call: GitCall): boolean => call.args.join(' ') === 'remote set-head origin --auto';

    it('asks origin what its default is when the repo has no origin/HEAD, then reads it back', async () => {
      let asked = 0;
      const git = fakeGit({
        read: (args) =>
          symbolic(args)
            ? { ok: true, stdout: ++asked === 1 ? '' : 'origin/trunk\n', stderr: '' }
            : { ok: true, stdout: '', stderr: '' },
      });

      const refs = await readRepoRefs(git, repo);

      expect(refs.defaultBase).toBe('origin/trunk');
      expect(git.calls.filter(setHead)).toHaveLength(1);
      expect(git.calls.find(setHead)?.opts.cwd).toBe('/src/api');
    });

    it('leaves a repo that already has one alone, since set-head costs a round trip', async () => {
      const git = fakeGit({
        read: (args) => ({ ok: true, stdout: symbolic(args) ? 'origin/main\n' : '', stderr: '' }),
      });

      const refs = await readRepoRefs(git, repo);

      expect(refs.defaultBase).toBe('origin/main');
      expect(git.calls.filter(setHead)).toEqual([]);
    });

    it('stays undefined when origin cannot be asked, rather than guessing a base', async () => {
      // Offline, or no remote at all. `resolveBranch` then falls back to HEAD,
      // which is the honest answer — a guessed `origin/main` is an invalid ref.
      const git = fakeGit({
        read: (args) => (symbolic(args) ? { ok: true, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }),
        write: { ok: false, code: 128, stdout: '', stderr: 'unable to access origin' },
      });

      const refs = await readRepoRefs(git, repo);

      expect(refs.defaultBase).toBeUndefined();
    });
  });
});

describe('addWorktree', () => {
  const repo = { name: 'api', path: '/src/api' };
  const bare = {
    localBranches: [] as string[],
    remoteBranches: [] as string[],
    checkedOutBranches: [] as string[],
    defaultBase: undefined,
  };

  it('refuses a branch another worktree holds, without running git at all', async () => {
    const git = fakeGit({});
    const outcome = await addWorktree(git, repo, 'fix-login', '/d/fix-login/api', {
      ...bare,
      localBranches: ['fix-login'],
      checkedOutBranches: ['fix-login'],
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(git.calls).toEqual([]);
  });

  it('checks out a branch that exists locally', async () => {
    const git = fakeGit({});
    const outcome = await addWorktree(git, repo, 'fix-login', '/d/fix-login/api', {
      ...bare,
      localBranches: ['fix-login'],
    });
    expect(outcome).toMatchObject({ ok: true, name: 'api', worktree: '/d/fix-login/api' });
    expect(git.calls[0]?.args).toEqual(['worktree', 'add', '/d/fix-login/api', 'fix-login']);
    expect(git.calls[0]?.opts.cwd).toBe('/src/api');
  });

  it('creates a branch off HEAD when it exists nowhere', async () => {
    const git = fakeGit({});
    await addWorktree(git, repo, 'brand-new', '/d/brand-new/api', bare);
    expect(git.calls[0]?.args).toEqual(['worktree', 'add', '/d/brand-new/api', '-b', 'brand-new', 'HEAD']);
  });

  it('reports git’s own words when the add fails', async () => {
    const git = fakeGit({ write: { ok: false, code: 128, stdout: '', stderr: 'fatal: already exists\n' } });
    expect(await addWorktree(git, repo, 'brand-new', '/d/brand-new/api', bare)).toMatchObject({
      ok: false,
      reason: 'fatal: already exists',
    });
  });
});

describe('provisionRepo', () => {
  it('is still the two halves in order, so no caller had to change', async () => {
    // The refactor's own assertion: the composed verb reads refs and then adds,
    // in one repo, with the same result it always had.
    const git = fakeGit({ read: { ok: true, stdout: 'fix-login\n', stderr: '' } });
    const outcome = await provisionRepo(git, { name: 'api', path: '/src/api' }, 'fix-login', '/d/x/api');
    expect(outcome).toMatchObject({ ok: true, worktree: '/d/x/api' });
    expect(git.calls[0]?.args).toEqual(['fetch', '--quiet', 'origin']);
    expect(git.calls.at(-1)?.fn).toBe('gitWrite');
  });
});

/**
 * Deleting the branch an incognito task worked on.
 *
 * The counterpart to `removeWorktree`, and deliberately NOT part of it: an
 * ordinary task keeps its branch — it lives in the user's own repo and may
 * carry commits — and only a task that asked to leave nothing behind gets this.
 */
describe('deleteBranch', () => {
  it('deletes it in the SOURCE repo, where a branch actually lives', async () => {
    const git = fakeGit({ write: { ok: true, stdout: '', stderr: '' } });

    const out = await deleteBranch(git, '/src/api', 'fix-login');

    expect(out.ok).toBe(true);
    const call = git.calls.find((entry) => entry.fn === 'gitWrite');
    expect(call?.args).toEqual(['branch', '-D', 'fix-login']);
    expect(call?.opts.cwd).toBe('/src/api');
  });

  it('forces it, because unmerged is the ordinary case here', async () => {
    /*
     * `-d` refuses a branch that is not merged into HEAD, which is exactly what
     * a task's branch is — so the safe flag would leave the branch behind on
     * every task that did any work. The user asked for this knowing it: pushed
     * work survives on the remote, unpushed work does not.
     */
    const git = fakeGit({ write: { ok: true, stdout: '', stderr: '' } });
    await deleteBranch(git, '/src/api', 'fix-login');
    expect(git.calls.find((entry) => entry.fn === 'gitWrite')?.args).toContain('-D');
  });

  it('reports why rather than throwing, so one repo cannot abort a delete', async () => {
    const git = fakeGit({ write: { ok: false, code: 1, stdout: '', stderr: 'branch is checked out\n' } });

    expect(await deleteBranch(git, '/src/api', 'fix-login')).toEqual({
      ok: false,
      reason: 'branch is checked out',
    });
  });

  it('does nothing for a detached head, which names no branch to delete', async () => {
    const git = fakeGit({ write: { ok: true, stdout: '', stderr: '' } });

    expect((await deleteBranch(git, '/src/api', null)).ok).toBe(true);
    expect(git.calls).toHaveLength(0);
  });
});
