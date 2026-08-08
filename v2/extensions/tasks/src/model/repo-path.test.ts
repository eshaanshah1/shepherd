import { describe, expect, it } from 'vitest';
import { expandHome } from './repo-path.ts';

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
