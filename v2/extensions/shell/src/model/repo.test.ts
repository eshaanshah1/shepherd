import { describe, expect, it } from 'vitest';
import { repoAt } from './repo.ts';

/** A fake tree: the set of paths that hold a `.git` entry. */
const has = (...repos: string[]) => (path: string) => repos.includes(path);

describe('the repo a shell is sitting in', () => {
  it('is the cwd itself when the cwd is a repo', () => {
    expect(repoAt('/Users/me/dev/relay', has('/Users/me/dev/relay'))).toEqual({
      path: '/Users/me/dev/relay',
      name: 'relay',
    });
  });

  it('walks UP, because a shell is usually somewhere inside a repo', () => {
    // The cwd's basename is `ui`, and a task rooted at `packages/ui` would try to
    // worktree a directory with no `.git`.
    expect(repoAt('/Users/me/dev/relay/packages/ui', has('/Users/me/dev/relay'))).toEqual({
      path: '/Users/me/dev/relay',
      name: 'relay',
    });
  });

  it('stops at the NEAREST repo, so a nested one wins over its parent', () => {
    expect(
      repoAt('/Users/me/dev/relay/vendor/lib/src', has('/Users/me/dev/relay', '/Users/me/dev/relay/vendor/lib')),
    ).toEqual({ path: '/Users/me/dev/relay/vendor/lib', name: 'lib' });
  });

  it('is nothing when no ancestor is a repo', () => {
    // `$HOME` is the cwd of the first shell anyone opens, and it is not a repo.
    expect(repoAt('/Users/me', has('/Users/me/dev/relay'))).toBeNull();
  });

  it('does not treat the filesystem root as a repo it can name', () => {
    // Walking past `/` must terminate, and `/` has no basename to be a task's
    // repo name.
    expect(repoAt('/', has('/'))).toBeNull();
  });

  it('is nothing for a cwd that is not an absolute path', () => {
    // A cwd crossed a port. A relative one would make the walk unbounded.
    expect(repoAt('relay', has('relay'))).toBeNull();
    expect(repoAt('', has(''))).toBeNull();
  });

  it('ignores a trailing slash rather than looking for an empty name', () => {
    expect(repoAt('/Users/me/dev/relay/', has('/Users/me/dev/relay'))).toEqual({
      path: '/Users/me/dev/relay',
      name: 'relay',
    });
  });
});
