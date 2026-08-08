import { describe, expect, it } from 'vitest';
import { repoName } from './repo-name.ts';

describe('repoName', () => {
  it('is the last segment of a path', () => {
    expect(repoName('/Users/me/dev/shepherd')).toBe('shepherd');
  });

  it('ignores a trailing slash — a picker that appends one must not name the repo ""', () => {
    expect(repoName('/Users/me/dev/shepherd/')).toBe('shepherd');
  });

  it('ignores "." segments, so ./repo and repo are the same repo', () => {
    expect(repoName('./repo')).toBe('repo');
  });

  it('falls back to the whole string when there is no segment to take', () => {
    expect(repoName('/')).toBe('/');
  });
});
