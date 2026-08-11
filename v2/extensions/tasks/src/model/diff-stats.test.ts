import { describe, expect, it } from 'vitest';
import { isEmptyDiff, numstatPaths, parseNumstat, sumDiff } from './diff-stats.ts';
import { DIFF_TIMEOUT_MS, collectRepoDiff, collectTaskDiff, resolveBase, type GitReader } from './diff-collect.ts';

describe('parseNumstat', () => {
  it('reads the three columns git actually prints', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n')).toEqual({ added: 12, removed: 10, files: 2 });
  });

  it('counts a BINARY file as changed and adds no lines for it', () => {
    // `-\t-` is git's "unknown", not zero. A 4MB PNG did not add 4 million lines
    // and it did not add zero either — but it IS a changed file.
    expect(parseNumstat('-\t-\tlogo.png\n5\t1\tsrc/a.ts\n')).toEqual({ added: 5, removed: 1, files: 2 });
  });

  it('never lets a binary’s `-` poison the sum as NaN', () => {
    const stats = parseNumstat('-\t-\ta.bin\n-\t-\tb.bin\n');
    expect(Number.isFinite(stats.added)).toBe(true);
    expect(stats).toEqual({ added: 0, removed: 0, files: 2 });
  });

  it('keeps a rename, which is one file and no lines', () => {
    // A task that only moved files HAS changed something; `0 files` would say it
    // had not.
    expect(parseNumstat('0\t0\tsrc/{a => b}/c.ts\n')).toEqual({ added: 0, removed: 0, files: 1 });
  });

  it('takes everything after the second tab as the path, tabs included', () => {
    expect(parseNumstat('1\t1\tsrc/we\tird.ts\n').files).toBe(1);
    expect(numstatPaths('1\t1\tsrc/we\tird.ts\n')).toEqual(['src/we\tird.ts']);
  });

  it('skips a line it cannot read rather than throwing', () => {
    // This parses output from a git that may be newer than this code. A card that
    // cannot draw its diff line is smaller than a sidebar that will not render.
    expect(parseNumstat('garbage\n\n1\t2\tok.ts\nalso garbage\n')).toEqual({ added: 1, removed: 2, files: 1 });
  });

  it('is empty for empty output', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0, files: 0 });
    expect(isEmptyDiff(parseNumstat(''))).toBe(true);
  });
});

describe('sumDiff', () => {
  it('adds files across repos, which cannot share a path', () => {
    expect(sumDiff([{ added: 1, removed: 2, files: 3 }, { added: 10, removed: 20, files: 4 }])).toEqual({
      added: 11,
      removed: 22,
      files: 7,
    });
  });
});

/** A git that answers from a table, so the parsing and the ARGUMENTS are both asserted. */
const fakeGit = (table: Readonly<Record<string, string | null>>): GitReader & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    gitRead: async (args) => {
      calls.push([...args]);
      const answer = table[args.join(' ')];
      return answer === undefined || answer === null ? { ok: false } : { ok: true, stdout: answer };
    },
  };
};

describe('resolveBase', () => {
  it('prefers what the remote says its default branch is', async () => {
    const git = fakeGit({ 'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/trunk\n' });
    expect(await resolveBase(git, '/r')).toBe('refs/remotes/origin/trunk');
  });

  it('falls back through candidates, checking each EXISTS', async () => {
    // A guessed base is worse than none: `main` on a master repo resolves to
    // nothing, and diffing against nothing is an error or the whole history.
    const git = fakeGit({ 'rev-parse --verify --quiet origin/master^{commit}': 'abc123\n' });
    expect(await resolveBase(git, '/r')).toBe('origin/master');
  });

  it('answers null rather than guessing when nothing resolves', async () => {
    expect(await resolveBase(fakeGit({}), '/r')).toBeNull();
  });

  it('never runs a command that touches the network', async () => {
    const git = fakeGit({});
    await resolveBase(git, '/r');
    for (const call of git.calls) {
      // v1's fallback ran `git remote set-head origin --auto` — a round-trip, on
      // a path that fires on a timer.
      expect(call).not.toContain('fetch');
      expect(call).not.toContain('remote');
      expect(call).not.toContain('ls-remote');
    }
  });
});

describe('collectRepoDiff', () => {
  it('diffs the branch against its MERGE BASE, not against the tip', async () => {
    // Three dots. With two, every commit that landed on trunk after this task
    // branched counts as a removal by this task — hundreds of deleted lines
    // nobody deleted. The single most consequential character in this file.
    const git = fakeGit({
      'diff --numstat HEAD': '',
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'origin/main\n',
      'diff --numstat origin/main...HEAD': '10\t2\tsrc/a.ts\n',
    });
    expect(await collectRepoDiff(git, '/r')).toEqual({ added: 10, removed: 2, files: 1 });
    expect(git.calls.some((c) => c.includes('diff') && c.some((a) => a.includes('...')))).toBe(true);
    expect(git.calls.some((c) => c.some((a) => /[^.]\.\.[^.]/.test(a)))).toBe(false);
  });

  it('counts a file edited after it was committed ONCE', async () => {
    // The reason the two halves are unioned on path rather than summed on count:
    // a file in both readings is one changed file, and its lines are both.
    const git = fakeGit({
      'diff --numstat HEAD': '3\t1\tsrc/a.ts\n',
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'origin/main\n',
      'diff --numstat origin/main...HEAD': '10\t2\tsrc/a.ts\n',
    });
    expect(await collectRepoDiff(git, '/r')).toEqual({ added: 13, removed: 3, files: 1 });
  });

  it('measures uncommitted work alone when there is no local base', async () => {
    const git = fakeGit({ 'diff --numstat HEAD': '4\t4\tsrc/a.ts\n' });
    expect(await collectRepoDiff(git, '/r')).toEqual({ added: 4, removed: 4, files: 1 });
  });

  it('never asks for untracked files', async () => {
    // A task that dropped a build directory in its worktree has not written
    // 40,000 lines, and `--others` would say it had.
    const git = fakeGit({ 'diff --numstat HEAD': '' });
    await collectRepoDiff(git, '/r');
    for (const call of git.calls) expect(call).not.toContain('--others');
  });

  it('bounds every call, because this runs on a timer', async () => {
    const seen: number[] = [];
    const git: GitReader = {
      gitRead: async (_args, opts) => {
        seen.push(opts.timeoutMs);
        return { ok: true, stdout: '' };
      },
    };
    await collectRepoDiff(git, '/r');
    expect(seen.length).toBeGreaterThan(0);
    for (const ms of seen) expect(ms).toBe(DIFF_TIMEOUT_MS);
  });

  it('says UNKNOWN, not zero, for a repo it cannot read', async () => {
    // `+0 −0` is a claim that nothing changed. A removed worktree has not made
    // that claim.
    expect(await collectRepoDiff(fakeGit({}), '/gone')).toBeNull();
  });
});

describe('collectTaskDiff', () => {
  it('sums every repo a task touches', async () => {
    const git = fakeGit({ 'diff --numstat HEAD': '1\t1\ta.ts\n' });
    expect(await collectTaskDiff(git, ['/one', '/two'])).toEqual({ added: 2, removed: 2, files: 2 });
  });

  it('lets one unreadable repo contribute nothing without blanking the line', async () => {
    let call = 0;
    const git: GitReader = {
      gitRead: async (args) => {
        if (args[0] !== 'diff') return { ok: false };
        call += 1;
        return call === 1 ? { ok: false } : { ok: true, stdout: '5\t0\ta.ts\n' };
      },
    };
    expect(await collectTaskDiff(git, ['/gone', '/live'])).toEqual({ added: 5, removed: 0, files: 1 });
  });

  it('is null when NOTHING reads, and for a task with no repos', async () => {
    expect(await collectTaskDiff(fakeGit({}), ['/a', '/b'])).toBeNull();
    expect(await collectTaskDiff(fakeGit({}), [])).toBeNull();
  });
});
