import { describe, expect, it } from 'vitest';
import { collapseHome, expandHome } from './repo-path.ts';

const HOME = '/Users/eshaan';

describe('expandHome', () => {
  it('expands the leading ~/ a shell would have expanded', () => {
    expect(expandHome('~/Home/dev/shepherd', HOME)).toBe('/Users/eshaan/Home/dev/shepherd');
  });

  it('expands a bare ~', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/src/api', HOME)).toBe('/src/api');
  });

  it('leaves a ~ that is not leading, since that is a real directory name', () => {
    expect(expandHome('/src/~backup', HOME)).toBe('/src/~backup');
  });

  it('does NOT touch ~user, which is a lookup this cannot do', () => {
    // Expanding it as `${home}user` would invent a directory nobody named.
    expect(expandHome('~alice/code', HOME)).toBe('~alice/code');
  });
});

describe('collapseHome', () => {
  it('writes a path under home the way a person writes it', () => {
    expect(collapseHome(`${HOME}/dev/shepherd`, HOME)).toBe('~/dev/shepherd');
    expect(collapseHome(HOME, HOME)).toBe('~');
  });

  it('only collapses at a segment boundary', () => {
    // `/Users/me-old` starts with `/Users/me` and is a different person's home.
    expect(collapseHome('/Users/me-old/x', '/Users/me')).toBe('/Users/me-old/x');
  });

  it('leaves a path outside home alone', () => {
    expect(collapseHome('/opt/work/api', HOME)).toBe('/opt/work/api');
  });

  it('does nothing with an empty home, rather than collapsing everything to `~`', () => {
    expect(collapseHome('/opt/work', '')).toBe('/opt/work');
  });
});
