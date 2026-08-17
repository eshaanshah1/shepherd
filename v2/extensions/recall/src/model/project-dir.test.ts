import { describe, expect, it } from 'vitest';
import { cwdIsUnder, encodeProjectDir, folderMatchesAny } from './project-dir.ts';

describe('encodeProjectDir', () => {
  it('replaces slashes AND dots, which is the bug recall.py has', () => {
    expect(encodeProjectDir('/Users/me/.shepherd/v2/tasks/fix-login')).toBe(
      '-Users-me--shepherd-v2-tasks-fix-login',
    );
  });

  it('encodes an ordinary path with no dots', () => {
    expect(encodeProjectDir('/Users/me/dev/shepherd')).toBe('-Users-me-dev-shepherd');
  });

  it('drops a trailing slash so one directory has one name', () => {
    expect(encodeProjectDir('/Users/me/dev/')).toBe(encodeProjectDir('/Users/me/dev'));
  });
});

describe('folderMatchesAny', () => {
  const root = '/Users/me/.shepherd/v2/tasks/fix-login';

  it('matches the task root exactly', () => {
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-fix-login', [root])).toBe(true);
  });

  it('matches a worktree BENEATH the root, without being told about it', () => {
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-fix-login-api', [root])).toBe(true);
  });

  it('does not match an unrelated task', () => {
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-other', [root])).toBe(false);
  });

  it('matches nothing when no dirs are given', () => {
    expect(folderMatchesAny('-Users-me-dev', [])).toBe(false);
  });
});

describe('cwdIsUnder', () => {
  const root = '/Users/me/.shepherd/v2/tasks/fix-login';

  it('accepts the directory itself', () => {
    expect(cwdIsUnder(root, [root])).toBe(true);
  });

  it('accepts a subdirectory, so an agent that cd-ed still counts', () => {
    expect(cwdIsUnder(`${root}/api/src`, [root])).toBe(true);
  });

  it('rejects a sibling that shares a name prefix', () => {
    // The folder-name prefilter over-selects this one; cwd is what rejects it.
    expect(cwdIsUnder(`${root}-2`, [root])).toBe(false);
  });

  it('rejects a null cwd', () => {
    expect(cwdIsUnder(null, [root])).toBe(false);
  });
});
