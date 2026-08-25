import { describe, expect, it } from 'vitest';
import { readStatus } from './status.ts';

/*
 * `--porcelain -z`: NUL-separated, and a rename is TWO NUL-separated fields —
 * `R  new\0old`. The `-z` form rather than the newline one because a path may
 * legally contain a newline, and the newline form quotes and escapes those,
 * which is a second parser nobody wants.
 */
describe('readStatus', () => {
  it('reads the ordinary marks', () => {
    const out = ' M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? notes.md\0';
    expect(readStatus(out)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
      { path: 'notes.md', status: 'untracked' },
    ]);
  });

  it('reads a rename, whose NEW path is the one the tree has a row for', () => {
    // `R  new\0old` — two fields for one entry. Consuming only one leaves the
    // OLD path parsed as the next entry's status code, and every subsequent row
    // shifts by one.
    const out = 'R  src/new.ts\0src/old.ts\0 M src/after.ts\0';
    expect(readStatus(out)).toEqual([
      { path: 'src/new.ts', status: 'renamed' },
      { path: 'src/after.ts', status: 'modified' },
    ]);
  });

  it('reads a copy the same way, since it also spends two fields', () => {
    expect(readStatus('C  src/new.ts\0src/old.ts\0')).toEqual([
      { path: 'src/new.ts', status: 'renamed' },
    ]);
  });

  it('prefers the staged mark when both columns are set', () => {
    expect(readStatus('MM src/a.ts\0')).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
  });

  it('reads a staged add whose worktree half is clean', () => {
    expect(readStatus('A  src/b.ts\0')).toEqual([{ path: 'src/b.ts', status: 'added' }]);
  });

  it('is empty for a clean tree', () => {
    expect(readStatus('')).toEqual([]);
  });
});

/**
 * The asymmetry that made the Changes view draw nothing.
 *
 * `git ls-files` in a subdirectory reports paths relative to the CWD;
 * `git status --porcelain` reports them relative to the REPOSITORY ROOT, and
 * neither a `.` pathspec nor `-c status.relativePaths=true` changes it
 * (porcelain is documented as unaffected by that config). So a pane opened on
 * `<repo>/v2` had a tree of `extensions/…` and marks for `v2/extensions/…` —
 * two vocabularies, no overlap: no mark ever matched a row, the Changes tree
 * grew a phantom `v2/` root, and every `editor.diff` asked git about a path
 * that does not exist from that cwd and got nothing back.
 */
describe('readStatus, under a prefix', () => {
  it('rebases a path onto the directory the pane was opened on', () => {
    expect(readStatus(' M v2/src/a.ts\0', 'v2/')).toEqual([
      { path: 'src/a.ts', status: 'modified' },
    ]);
  });

  it('drops a change outside that directory, which has no row to mark', () => {
    // A sibling's edit is real and is not in this tree. Left in, it would draw
    // a row for a file the pane cannot open.
    expect(readStatus(' M docs/x.md\0 M v2/src/a.ts\0', 'v2/')).toEqual([
      { path: 'src/a.ts', status: 'modified' },
    ]);
  });

  it('rebases a rename onto the same base, and still skips its old path', () => {
    expect(readStatus('R  v2/src/new.ts\0v2/src/old.ts\0 M v2/after.ts\0', 'v2/')).toEqual([
      { path: 'src/new.ts', status: 'renamed' },
      { path: 'after.ts', status: 'modified' },
    ]);
  });

  it('changes nothing when the pane is opened at the repo root', () => {
    expect(readStatus(' M src/a.ts\0', '')).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
  });

  it('does not mistake a sibling whose name merely starts with the prefix', () => {
    // `v2-old/` shares five characters with `v2/` and is a different directory.
    expect(readStatus(' M v2-old/a.ts\0', 'v2/')).toEqual([]);
  });
});
