import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filePatch, listPaths, listStatus, type GitRunner } from './git.ts';

/**
 * A stub that answers by the first two args, so a test reads as "git said X".
 *
 * `ok: false` with a populated `stdout` is a real git shape, not a contrivance:
 * `git diff` exits 1 when there ARE differences.
 */
function runner(
  answers: Record<string, { stdout: string; ok?: boolean; code?: number }>,
): GitRunner & { readonly seen: string[][] } {
  const seen: string[][] = [];
  return {
    seen,
    gitRead: async (args) => {
      seen.push([...args]);
      const key = args.slice(0, 2).join(' ');
      const answer = answers[key];
      if (answer === undefined) {
        return { ok: false, code: 128, stdout: '', stderr: `no stub for ${key}` };
      }
      if (answer.ok === false) {
        return { ok: false, code: answer.code ?? 1, stdout: answer.stdout, stderr: '' };
      }
      return { ok: true, stdout: answer.stdout, stderr: '' };
    },
  };
}

const LS_TRACKED = 'ls-files --cached';
const LS_IGNORED = 'ls-files --others';

describe('listPaths', () => {
  it('merges the two ls-files answers', async () => {
    const git = runner({
      [LS_TRACKED]: { stdout: 'a.ts\nsrc/b.ts\n' },
      [LS_IGNORED]: { stdout: '.env\nnode_modules/\n' },
    });
    const walked = await listPaths(git, '/repo');
    expect(walked.paths).toEqual(['.env', 'a.ts', 'src/b.ts']);
    expect(walked.truncated).toBe(false);
  });

  it('still lists a repo with nothing ignored', async () => {
    // A repo whose ignore query comes back empty is a normal repo, not a
    // non-repo — only the FIRST call decides whether to fall back.
    const git = runner({
      [LS_TRACKED]: { stdout: 'a.ts\n' },
      [LS_IGNORED]: { stdout: '' },
    });
    expect((await listPaths(git, '/repo')).paths).toEqual(['a.ts']);
  });

  it('falls back to a walk when the root is not a repo', async () => {
    // `git ls-files` outside a repo exits 128. Falling through to the walk is
    // what makes `editor.open <any path>` work at all.
    const root = mkdtempSync(join(tmpdir(), 'editor-git-'));
    try {
      writeFileSync(join(root, 'loose.txt'), '');
      const walked = await listPaths(runner({}), root);
      expect(walked.paths).toEqual(['loose.txt']);
      expect(walked.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listStatus', () => {
  it('reads the porcelain answer', async () => {
    const git = runner({ 'status --porcelain': { stdout: ' M a.ts\0' } });
    expect(await listStatus(git, '/repo')).toEqual([{ path: 'a.ts', status: 'modified' }]);
  });

  it('asks for the -z form, whose parser is the only one status.ts has', async () => {
    const git = runner({ 'status --porcelain': { stdout: '' } });
    await listStatus(git, '/repo');
    expect(git.seen[0]).toContain('-z');
  });

  it('is empty rather than throwing when git fails', async () => {
    // A failure here costs decoration, never the tree.
    expect(await listStatus(runner({}), '/repo')).toEqual([]);
  });
});

describe('filePatch', () => {
  it('returns a tracked file diff against HEAD', async () => {
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-one\n+two\n';
    const git = runner({ 'diff HEAD': { stdout: patch } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBe(patch);
  });

  it('treats --no-index exit 1 as SUCCESS for an untracked file', async () => {
    // `git diff` exits 1 when there ARE differences, which for an untracked
    // file against /dev/null is always. Reading that as a failure means new
    // files never render in the changes view.
    const patch = 'diff --git a/new.ts b/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+one\n';
    const git = runner({ 'diff --no-index': { stdout: patch, ok: false, code: 1 } });
    expect(await filePatch(git, '/repo', 'new.ts', true)).toBe(patch);
  });

  it('diffs an untracked file from /dev/null', async () => {
    const git = runner({ 'diff --no-index': { stdout: 'x', ok: false, code: 1 } });
    await filePatch(git, '/repo', 'new.ts', true);
    expect(git.seen[0]).toEqual(['diff', '--no-index', '--', '/dev/null', 'new.ts']);
  });

  it('is null when there is genuinely no diff', async () => {
    const git = runner({ 'diff HEAD': { stdout: '' } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBeNull();
  });

  it('is null when git fails with no output', async () => {
    const git = runner({ 'diff HEAD': { stdout: '', ok: false, code: 128 } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBeNull();
  });
});

describe('listStatus, from a subdirectory', () => {
  it('rebases the marks onto the directory the pane was opened on', async () => {
    // The two commands disagree about what a path is relative to, and this is
    // where they are reconciled — see `status.ts`.
    const git = runner({
      'status --porcelain': { stdout: ' M v2/src/a.ts\0' },
      'rev-parse --show-prefix': { stdout: 'v2/\n' },
    });
    expect(await listStatus(git, '/repo/v2')).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
  });

  it('asks git for the prefix rather than deriving one from the path', async () => {
    // The pane's root is a filesystem path and the repo root is git's business;
    // subtracting one from the other would guess at symlinks and worktrees.
    const git = runner({
      'status --porcelain': { stdout: '' },
      'rev-parse --show-prefix': { stdout: '' },
    });
    await listStatus(git, '/repo/v2');
    expect(git.seen.some((args) => args.join(' ') === 'rev-parse --show-prefix')).toBe(true);
  });

  it('falls back to no prefix when git cannot answer', async () => {
    const git = runner({ 'status --porcelain': { stdout: ' M a.ts\0' } });
    expect(await listStatus(git, '/repo')).toEqual([{ path: 'a.ts', status: 'modified' }]);
  });
});
