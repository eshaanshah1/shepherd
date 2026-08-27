import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreesOf } from './worktrees.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'github-worktrees-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A worktree: a directory whose `.git` is a file pointing at the real one. */
function worktree(name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
}

/** A plain clone, whose `.git` is a directory. */
function clone(name: string): void {
  mkdirSync(join(root, name, '.git'), { recursive: true });
}

describe('worktreesOf', () => {
  it('joins each repo the record names to the task root', () => {
    worktree('api');
    expect(worktreesOf({ root, repos: [{ name: 'api' }] })).toEqual([
      { name: 'api', worktree: join(root, 'api') },
    ]);
  });

  it('finds a checkout the record never heard of', () => {
    // The bug this file exists for: a task created with no repos, whose agent
    // ran `git worktree add` itself. The pane said nothing had changed.
    worktree('shepherd');
    expect(worktreesOf({ root, repos: [] })).toEqual([
      { name: 'shepherd', worktree: join(root, 'shepherd') },
    ]);
  });

  it('finds a plain clone too, whose .git is a directory', () => {
    clone('vendored');
    expect(worktreesOf({ root, repos: [] }).map((found) => found.name)).toEqual(['vendored']);
  });

  it('keeps the record first and in its own order, then what it found', () => {
    worktree('web');
    worktree('api');
    worktree('extra');
    const found = worktreesOf({ root, repos: [{ name: 'web' }, { name: 'api' }] });
    expect(found.map((repo) => repo.name)).toEqual(['web', 'api', 'extra']);
  });

  it('names a repo once, however both halves spell it', () => {
    worktree('api');
    expect(worktreesOf({ root, repos: [{ name: 'api' }] }).map((repo) => repo.name)).toEqual(['api']);
  });

  it('skips a directory that is not a checkout', () => {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '');
    expect(worktreesOf({ root, repos: [] })).toEqual([]);
  });

  it('skips the .claude linked into every task root', () => {
    clone('.claude');
    expect(worktreesOf({ root, repos: [] })).toEqual([]);
  });

  it('still draws a .claude the user actually picked', () => {
    clone('.claude');
    expect(worktreesOf({ root, repos: [{ name: '.claude' }] }).map((repo) => repo.name)).toEqual([
      '.claude',
    ]);
  });

  it('keeps a repo whose worktree is gone — a shelved task still has repos', () => {
    expect(worktreesOf({ root, repos: [{ name: 'api' }] })).toEqual([
      { name: 'api', worktree: join(root, 'api') },
    ]);
  });

  it('answers with the record alone when the root does not exist', () => {
    const gone = join(root, 'shelved');
    expect(worktreesOf({ root: gone, repos: [{ name: 'api' }] })).toEqual([
      { name: 'api', worktree: join(gone, 'api') },
    ]);
  });
});
