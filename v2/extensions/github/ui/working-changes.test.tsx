// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readChanges } from './working-changes.tsx';

/**
 * What `github.changes` answered, read rather than cast — it crossed a port to
 * an extension whose version this build does not pin.
 */
describe('readChanges', () => {
  const repo = (over: Record<string, unknown> = {}) => ({
    name: 'v2',
    path: '/task/v2',
    branch: 'feature',
    base: 'main',
    files: [{ path: 'a.ts', status: 'modified', patch: 'diff --git a/a.ts b/a.ts\n' }],
    refuse: null,
    ...over,
  });

  it('reads a repo and its files', () => {
    expect(readChanges({ repos: [repo()] })).toEqual([
      {
        name: 'v2',
        path: '/task/v2',
        branch: 'feature',
        base: 'main',
        files: [{ path: 'a.ts', status: 'modified', patch: 'diff --git a/a.ts b/a.ts\n' }],
        refuse: null,
      },
    ]);
  });

  it('drops a repo with no path — the identifier createPr is addressed by', () => {
    // An invented path would push somebody else's repo.
    expect(readChanges({ repos: [{ name: 'v2' }, repo()] })).toHaveLength(1);
  });

  it('drops a file with no patch, which there is nothing to draw for', () => {
    const rows = readChanges({ repos: [repo({ files: [{ path: 'a.ts' }] })] });
    expect(rows[0]?.files).toEqual([]);
  });

  it('carries a refusal through as the reason it is', () => {
    expect(readChanges({ repos: [repo({ refuse: 'nothing committed on this branch yet' })] })[0]?.refuse)
      .toBe('nothing committed on this branch yet');
  });

  it('is empty for an answer it cannot read', () => {
    expect(readChanges(undefined)).toEqual([]);
    expect(readChanges({ repos: 'nope' })).toEqual([]);
  });

  it('defaults a missing branch and base to null rather than inventing main', () => {
    const row = readChanges({ repos: [repo({ branch: undefined, base: undefined })] })[0];
    expect(row?.branch).toBeNull();
    expect(row?.base).toBeNull();
  });
});
