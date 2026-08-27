import { describe, expect, it } from 'vitest';
import { agoText, readPr, readReview } from './review-data.ts';
import { plainly } from './review.tsx';

/**
 * The reader that refuses to trust the service half.
 *
 * Everything here crossed an IPC port as `unknown`, and this renders in a pane —
 * a throw inside React's render takes the window. So the claim under test is
 * never "it parses", it is "it says less rather than guessing".
 */

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'shepherd/v2',
  repoKey: 'v2',
  number: 301,
  title: 'Add multiple task tabs',
  state: 'open',
  baseRef: 'main',
  headRef: 'tabs',
  url: 'https://github.com/shepherd/v2/pull/301',
  added: 214,
  removed: 38,
  changedFiles: 12,
  checks: [],
  approvals: [],
  changesRequested: [],
  threads: [],
  comments: [],
  files: [],
  openedAt: 1,
  updatedAt: 2,
  mergeState: 'clean',
  dependsOn: [],
  ...over,
});

describe('readPr', () => {
  it('reads the ordinary case whole', () => {
    expect(readPr(raw())).toMatchObject({ repo: 'shepherd/v2', number: 301, state: 'open', added: 214 });
  });

  it('refuses a PR with no repo, number or state — the three with no honest default', () => {
    // A PR with no repo or number cannot be addressed by any verb on the
    // surface, and one with no state would have to be drawn as something.
    expect(readPr(raw({ repo: undefined }))).toBeNull();
    expect(readPr(raw({ number: 'many' }))).toBeNull();
    expect(readPr(raw({ state: 'reticulating' }))).toBeNull();
    expect(readPr(null)).toBeNull();
  });

  it('says less rather than guessing for everything else', () => {
    const pr = readPr({ repo: 'a/b', number: 1, state: 'open' });
    expect(pr).toMatchObject({ title: '#1', added: 0, removed: 0, checks: [], threads: [], comments: [], files: [] });
  });

  it('drops a check with no name or no state, and keeps its neighbours', () => {
    const pr = readPr(
      raw({ checks: [{ name: 'lint' }, { state: 'passed' }, { name: 'typecheck', state: 'failed' }] }),
    );
    expect(pr?.checks).toEqual([{ name: 'typecheck', state: 'failed' }]);
  });

  it('keeps a queued or blocked check, which are states this reader used to drop', () => {
    /*
     * The list of accepted states was `passed`/`failed`/`running`/`skipped`,
     * three of the six `CheckState` names — so the two added later fell through
     * the `find` and the check was dropped whole. A required status a repo posts
     * as PENDING is exactly that shape, and the pane it drew said `1 of 1
     * passed` for a PR that could not merge.
     */
    const pr = readPr(
      raw({
        checks: [
          { name: 'audit', state: 'queued' },
          { name: 'deploy', state: 'blocked' },
        ],
      }),
    );
    expect(pr?.checks).toEqual([
      { name: 'audit', state: 'queued' },
      { name: 'deploy', state: 'blocked' },
    ]);
  });

  it('reads the conversation\u2019s comments, and drops one with no body', () => {
    const pr = readPr(
      raw({
        comments: [
          { id: 'c1', author: 'bsautomation', body: 'needs a stack audit', at: 9 },
          { id: 'c2', author: 'jane' },
          { body: 'no id' },
        ],
      }),
    );
    expect(pr?.comments).toEqual([{ id: 'c1', author: 'bsautomation', body: 'needs a stack audit', at: 9 }]);
  });

  it('reads an unrecognised merge state as unknown, which forbids Merge', () => {
    expect(readPr(raw({ mergeState: 'probably-fine' }))?.mergeState).toBe('unknown');
  });

  it('keeps a thread whose line is missing, because you still have to answer it', () => {
    const pr = readPr(raw({ threads: [{ id: 'T1', author: 'sam', path: 'a.ts', body: 'hm' }] }));
    expect(pr?.threads[0]).toMatchObject({ id: 'T1', line: null, resolved: false });
  });

  it('takes an avatar only from the host that serves them', () => {
    /*
     * The one field on this port that becomes a `src`, so it is the one field
     * where a bad value would reach the network instead of the screen. `img-src`
     * refuses any other host as well, and a reader whose whole job is to
     * distrust this shape should not be leaving the check to a stylesheet.
     */
    const pr = readPr(
      raw({
        comments: [
          { id: 'c1', author: 'coderabbitai', body: 'skipped', at: 9, avatar: 'https://avatars.githubusercontent.com/u/1?s=64&v=4' },
          { id: 'c2', author: 'sam', body: 'and this', at: 10, avatar: 'https://elsewhere.example/track.gif' },
          { id: 'c3', author: 'jane', body: 'and this', at: 11, avatar: 42 },
        ],
      }),
    );
    expect(pr?.comments[0]?.avatar).toBe('https://avatars.githubusercontent.com/u/1?s=64&v=4');
    expect(pr?.comments[1]).not.toHaveProperty('avatar');
    expect(pr?.comments[2]).not.toHaveProperty('avatar');
  });
});

describe('readReview', () => {
  it('resolves the two orders against the one list of PRs', () => {
    // The service half sends the PRs once and the orders as keys, so a PR cannot
    // appear twice with two different states.
    const data = readReview({
      prs: [raw(), raw({ number: 288, state: 'merged' })],
      open: ['shepherd/v2#301'],
      closed: ['shepherd/v2#288'],
      syncedAt: 1_000,
      signedIn: true,
    });
    expect(data?.open.map((pr) => pr.number)).toEqual([301]);
    expect(data?.closed.map((pr) => pr.number)).toEqual([288]);
  });

  it('ignores a key naming a PR that is not in the list', () => {
    const data = readReview({ prs: [raw()], open: ['shepherd/v2#301', 'other/repo#9'], signedIn: true });
    expect(data?.open).toHaveLength(1);
  });

  it('reads not-signed-in as a state rather than an absence', () => {
    const data = readReview({ prs: [], open: [], closed: [], signedIn: false, error: 'not signed in' });
    expect(data).toMatchObject({ signedIn: false, error: 'not signed in', syncedAt: null });
  });

  it('answers null only for a value that is not an object at all', () => {
    expect(readReview('nope')).toBeNull();
    expect(readReview({})).toMatchObject({ open: [], closed: [], signedIn: false });
  });
});

describe('agoText', () => {
  it('is coarse past a minute, because the pane is claiming "roughly current"', () => {
    expect(agoText(1_000, 13_000)).toBe('12s');
    expect(agoText(0, 4 * 60_000)).toBe('4m');
    expect(agoText(0, 2 * 3_600_000)).toBe('2h');
  });

  it('says nothing at all before the first sync', () => {
    expect(agoText(null, 1)).toBeNull();
  });

  it('never reports a negative age from a clock that disagrees', () => {
    expect(agoText(9_000, 1_000)).toBe('0s');
  });
});

describe('plainly', () => {
  /**
   * Seen on screen, which is why it is here: a hand-off that could not spawn
   * arrived as three layers of who-was-called in front of the one clause a
   * person can act on.
   */
  it('takes the plumbing off a nested failure', () => {
    expect(
      plainly('"tasks.spawn" failed: handler-failed: "tasks.spawn" failed: task t-1 has no repo "sdk"'),
    ).toBe('task t-1 has no repo "sdk"');
  });

  it('leaves an ordinary sentence alone, colons and all', () => {
    expect(plainly('somebody merged it first')).toBe('somebody merged it first');
    expect(plainly('the branch moved: force-pushed at 14:02')).toBe('the branch moved: force-pushed at 14:02');
  });

  it('cannot spin on a pathological string', () => {
    expect(plainly('a: '.repeat(50))).toContain('a: ');
  });
});
