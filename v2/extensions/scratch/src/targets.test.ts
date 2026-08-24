import { describe, expect, it } from 'vitest';
import { collapseHome, findTarget, skillTargets, USER_TARGET } from './targets.ts';

const HOME = '/Users/e';

describe('collapseHome', () => {
  it('collapses the home directory', () => {
    expect(collapseHome('/Users/e/work/api', HOME)).toBe('~/work/api');
  });

  it('answers with a bare tilde for the home itself', () => {
    expect(collapseHome(HOME, HOME)).toBe('~');
  });

  it('leaves a path outside home alone', () => {
    expect(collapseHome('/opt/src/api', HOME)).toBe('/opt/src/api');
  });

  /*
   * `/Users/eshaan` starts with `/Users/e` and is somebody else's directory.
   * A prefix match without the separator check renames it `~shaan`.
   */
  it('does not collapse a path that merely shares a prefix', () => {
    expect(collapseHome('/Users/eshaan/work', HOME)).toBe('/Users/eshaan/work');
  });

  it('leaves everything alone with no home to compare against', () => {
    expect(collapseHome('/Users/e/work', '')).toBe('/Users/e/work');
  });
});

describe('skillTargets', () => {
  it('lists the user level even with no repos', () => {
    const targets = skillTargets(HOME, []);
    expect(targets).toEqual([{ id: USER_TARGET, label: 'User', root: HOME, kind: 'user', display: '~' }]);
  });

  /*
   * User FIRST, and it is a decision rather than an accident: a repo install
   * commits a file somebody else pulls, so the option with the narrower
   * consequence is the one that leads.
   */
  it('puts the user level first, then the repos in the task’s own order', () => {
    const targets = skillTargets(HOME, [
      { path: '/Users/e/work/web', name: 'web' },
      { path: '/Users/e/work/api', name: 'api' },
    ]);
    expect(targets.map((target) => target.label)).toEqual(['User', 'web', 'api']);
    expect(targets.map((target) => target.kind)).toEqual(['user', 'repo', 'repo']);
  });

  it('carries the path in the id, so nobody keeps a parallel list', () => {
    const targets = skillTargets(HOME, [{ path: '/Users/e/work/api', name: 'api' }]);
    expect(targets[1]?.id).toBe('repo:/Users/e/work/api');
    expect(targets[1]?.display).toBe('~/work/api');
  });

  it('drops a duplicate repo', () => {
    const targets = skillTargets(HOME, [
      { path: '/Users/e/work/api', name: 'api' },
      { path: '/Users/e/work/api', name: 'api' },
    ]);
    expect(targets).toHaveLength(2);
  });

  it('drops a trailing slash before comparing', () => {
    const targets = skillTargets(HOME, [
      { path: '/Users/e/work/api/', name: 'api' },
      { path: '/Users/e/work/api', name: 'api' },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[1]?.root).toBe('/Users/e/work/api');
  });

  /*
   * A repo checked out at `~` is the same directory as the user level. Listed
   * twice, the two rows install to one place under two names, and the second one
   * refuses because the first one just wrote there.
   */
  it('does not list a repo that IS the home directory', () => {
    const targets = skillTargets(HOME, [{ path: HOME, name: 'dotfiles' }]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.kind).toBe('user');
  });

  it('names an unnamed repo after its last path component', () => {
    const targets = skillTargets(HOME, [{ path: '/opt/src/api', name: '' }]);
    expect(targets[1]?.label).toBe('api');
  });

  it('skips a repo with no path at all', () => {
    expect(skillTargets(HOME, [{ path: '', name: 'nowhere' }])).toHaveLength(1);
  });
});

describe('findTarget', () => {
  it('finds one by id', () => {
    const targets = skillTargets(HOME, [{ path: '/Users/e/work/api', name: 'api' }]);
    expect(findTarget(targets, 'repo:/Users/e/work/api')?.label).toBe('api');
  });

  it('answers undefined for an id naming none, rather than the first', () => {
    expect(findTarget(skillTargets(HOME, []), 'repo:/gone')).toBeUndefined();
  });
});
