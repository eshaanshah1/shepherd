import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeDirectories, exactRepoPath, looksLikeRepo } from './suggest.ts';

/**
 * The filesystem half, against a real tree — the only way to assert that a
 * symlinked directory completes, that a `.git` FILE counts as a repo, and that
 * a file named like a directory does not.
 */

let home: string;
const paths = (candidates: readonly { path: string }[]): readonly string[] =>
  candidates.map((candidate) => candidate.path);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepherd-home-'));
  mkdirSync(join(home, 'dev/shepherd/.git'), { recursive: true });
  mkdirSync(join(home, 'dev/shepherd-android/.git'), { recursive: true });
  mkdirSync(join(home, 'dev/scratch'), { recursive: true });
  mkdirSync(join(home, 'dev/.hidden'), { recursive: true });
  writeFileSync(join(home, 'dev/notes.md'), 'not a directory');
  mkdirSync(join(home, 'Downloads'), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('completeDirectories', () => {
  it('lists one level of the directory you have typed', () => {
    expect(paths(completeDirectories(join(home, 'dev'), home))).toEqual([
      join(home, 'dev/.hidden'),
      join(home, 'dev/scratch'),
      join(home, 'dev/shepherd'),
      join(home, 'dev/shepherd-android'),
    ]);
  });

  it('keeps dot-directories, which are half the reason you are typing a path', () => {
    expect(paths(completeDirectories(join(home, 'dev/.h'), home))).toEqual([join(home, 'dev/.hidden')]);
  });

  it('leaves files out — a completion is a list of places to go', () => {
    // `n` is a subsequence of several of the directories here, which is the
    // matcher working; what must never appear is the file.
    expect(paths(completeDirectories(join(home, 'dev/n'), home))).not.toContain(
      join(home, 'dev/notes.md'),
    );
  });

  it('fuzzy-matches the trailing segment against the parent, not only its prefix', () => {
    // `shp` is a subsequence of `shepherd`, which is what makes this faster than
    // typing the name out.
    expect(paths(completeDirectories(join(home, 'dev/shp'), home))).toEqual([
      join(home, 'dev/shepherd'),
      join(home, 'dev/shepherd-android'),
    ]);
  });

  it('marks which candidates are repos and drops none of them', () => {
    // `dev/scratch` is the row you need in order to REACH the repos inside it,
    // so a picker that excluded non-repos would stop being a navigator.
    const found = completeDirectories(join(home, 'dev'), home);
    expect(found.find((entry) => entry.path.endsWith('shepherd'))?.isRepo).toBe(true);
    expect(found.find((entry) => entry.path.endsWith('scratch'))?.isRepo).toBe(false);
  });

  it('fuzzy-matches the last segment, so `shp` reaches `shepherd`', () => {
    const [first] = completeDirectories(join(home, 'dev/shp'), home);
    expect(first?.path).toBe(join(home, 'dev/shepherd'));
  });

  it('never enumerates home itself', () => {
    // `~/` is the state that means "I have not told you anything yet"; the
    // honest answer there is the history.
    expect(completeDirectories(home, home)).toEqual([]);
    expect(completeDirectories(`${home}/`, home)).toEqual([]);
  });

  it('does complete inside home once there is something to match', () => {
    expect(paths(completeDirectories(join(home, 'Dow'), home))).toEqual([join(home, 'Downloads')]);
  });

  it('answers nothing for an unreadable or absent directory rather than throwing', () => {
    expect(completeDirectories(join(home, 'nope/at/all'), home)).toEqual([]);
    expect(completeDirectories('', home)).toEqual([]);
  });

  it('follows a symlink to a directory', () => {
    // A repo parked under a linked folder is exactly the case somebody types a
    // path by hand for. (`Downloads` also matches `wo` as a subsequence — the
    // assertion is that the symlink is there and ranks first, not that it is
    // alone.)
    symlinkSync(join(home, 'dev'), join(home, 'work'));
    expect(paths(completeDirectories(join(home, 'wo'), home))[0]).toBe(join(home, 'work'));
  });
});

describe('looksLikeRepo', () => {
  it('accepts a `.git` directory', () => {
    expect(looksLikeRepo(join(home, 'dev/shepherd'))).toBe(true);
  });

  it('accepts a `.git` FILE, which is what a linked worktree has', () => {
    mkdirSync(join(home, 'wt'), { recursive: true });
    writeFileSync(join(home, 'wt/.git'), 'gitdir: /elsewhere');
    expect(looksLikeRepo(join(home, 'wt'))).toBe(true);
  });

  it('rejects a directory with no `.git` at all', () => {
    expect(looksLikeRepo(join(home, 'dev/scratch'))).toBe(false);
  });
});

describe('match positions', () => {
  it('shifts the hit into the FULL path, since that is what the field draws', () => {
    // The match runs against the entry NAME (`shepherd`), and the picker draws
    // `<parent>/shepherd`. An unshifted position would highlight characters that
    // many places to the left — and still render, so nothing would report it.
    const [first] = completeDirectories(join(home, 'dev/shp'), home);
    const shown = first!.path;
    expect(shown).toBe(join(home, 'dev/shepherd'));
    expect(first!.positions.map((at) => shown[at])).toEqual(['s', 'h', 'p']);
  });

  it('answers an empty query with no positions rather than every position', () => {
    const [first] = completeDirectories(join(home, 'dev'), home);
    expect(first!.positions).toEqual([]);
  });
});

describe('exactRepoPath', () => {
  it('names the repo you typed the whole path of', () => {
    // The shipped defect: completion answers a directory with its CHILDREN, so
    // typing a repo's full path put `.claude` — first alphabetically — in the
    // ghost text, and ⏎ takes the ghost over the field. The task was then built
    // on a directory with no `.git`, which is also why its worktree never came.
    mkdirSync(join(home, 'dev/shepherd/.claude'), { recursive: true });
    expect(paths(completeDirectories(join(home, 'dev/shepherd'), home))[0]).toBe(
      join(home, 'dev/shepherd/.claude'),
    );
    expect(exactRepoPath(join(home, 'dev/shepherd'))).toBe(join(home, 'dev/shepherd'));
  });

  it('leaves a plain directory a waypoint, so typing a parent still descends', () => {
    expect(exactRepoPath(join(home, 'dev'))).toBeNull();
    expect(exactRepoPath(join(home, 'dev/scratch'))).toBeNull();
  });

  it('ignores a trailing slash, and answers nothing for what is not there', () => {
    expect(exactRepoPath(`${join(home, 'dev/shepherd')}/`)).toBe(join(home, 'dev/shepherd'));
    expect(exactRepoPath(join(home, 'dev/nope'))).toBeNull();
    expect(exactRepoPath('  ')).toBeNull();
    expect(exactRepoPath('/')).toBeNull();
  });
});
