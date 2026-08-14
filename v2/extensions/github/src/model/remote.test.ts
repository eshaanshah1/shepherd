import { describe, expect, it } from 'vitest';
import { parseRemote, slugText } from './remote.ts';

describe('parseRemote', () => {
  it('reads every form a real machine produces', () => {
    const expected = { owner: 'shepherd', repo: 'v2' };
    for (const url of [
      'https://github.com/shepherd/v2.git',
      'https://github.com/shepherd/v2',
      'https://eshaan@github.com/shepherd/v2.git',
      'git@github.com:shepherd/v2.git',
      'git@github.com:shepherd/v2',
      'ssh://git@github.com/shepherd/v2.git',
      'git://github.com/shepherd/v2.git',
      'github.com:shepherd/v2',
      '  https://github.com/shepherd/v2.git\n',
    ]) {
      expect(parseRemote(url), url).toEqual(expected);
    }
  });

  it('refuses a host that is not github.com', () => {
    // A permissive parser turns a GitLab remote into a GitHub API call that
    // 404s, which reads as "the PR is gone" rather than "this is not GitHub".
    for (const url of [
      'git@gitlab.com:shepherd/v2.git',
      'https://bitbucket.org/shepherd/v2.git',
      'https://github.enterprise.example.com/shepherd/v2.git',
      'https://notgithub.com/shepherd/v2.git',
    ]) {
      expect(parseRemote(url), url).toBeNull();
    }
  });

  it('refuses a path that is not exactly owner/repo', () => {
    for (const url of [
      'https://github.com/shepherd',
      'https://github.com/',
      'https://github.com/shepherd/v2/tree/main',
      'git@github.com:shepherd',
      '',
      '   ',
      'not a url at all',
    ]) {
      expect(parseRemote(url), url).toBeNull();
    }
  });

  it('keeps a repo name that merely contains .git', () => {
    expect(parseRemote('git@github.com:shepherd/dot.git.thing.git')).toEqual({
      owner: 'shepherd',
      repo: 'dot.git.thing',
    });
  });

  it('names a repo the way a PR row does', () => {
    expect(slugText({ owner: 'shepherd', repo: 'sdk' })).toBe('shepherd/sdk');
  });
});
