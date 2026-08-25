import { describe, expect, it } from 'vitest';
import { bodyFrom, refuseReason } from './new-pr.ts';

describe('bodyFrom', () => {
  it('lists the commits, oldest first', () => {
    expect(bodyFrom(['add the reader', 'wire it up'])).toBe('- add the reader\n- wire it up');
  });

  it('is EMPTY for a single commit, whose subject is already the title', () => {
    // A bullet list repeating the title says less than nothing.
    expect(bodyFrom(['add the reader'])).toBe('');
  });

  it('is empty for no commits', () => {
    expect(bodyFrom([])).toBe('');
    expect(bodyFrom(['', '  '])).toBe('');
  });
});

describe('refuseReason', () => {
  const ok = { branch: 'feature', base: 'main', ahead: 2 };

  it('permits a branch with commits ahead of a known base', () => {
    expect(refuseReason(ok)).toBeNull();
  });

  it('refuses a detached worktree', () => {
    expect(refuseReason({ ...ok, branch: null })).toContain('not on a branch');
  });

  it('refuses when the base is unknown, rather than guessing main', () => {
    expect(refuseReason({ ...ok, base: null })).toContain('which branch');
  });

  it('refuses a branch that IS the base', () => {
    expect(refuseReason({ ...ok, branch: 'main' })).toContain('on main');
  });

  it('refuses with nothing committed — said BEFORE the push, not after it fails', () => {
    expect(refuseReason({ ...ok, ahead: 0 })).toContain('nothing committed');
  });
});
