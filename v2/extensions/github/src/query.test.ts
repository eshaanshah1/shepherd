import { describe, expect, it } from 'vitest';
import { PR_QUERY, readDependsOn, readPullRequests, type PrQueryResponse } from './query.ts';

/**
 * The mapping, tested without a network — which is the reason it is a separate
 * function from the request at all. Every case below is a shape GitHub really
 * returns: a deleted author, a check with no conclusion, a thread whose line has
 * gone, a repo with no CI.
 */

const IDENTITY = { repo: 'shepherd/v2', repoKey: 'v2', viewer: 'eshaan' };

function response(overrides: Record<string, unknown> = {}): PrQueryResponse {
  return {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 301,
            title: 'Add multiple task tabs',
            url: 'https://github.com/shepherd/v2/pull/301',
            body: '',
            state: 'OPEN',
            isDraft: false,
            baseRefName: 'main',
            headRefName: 'tasks/add-multiple-task-tabs',
            additions: 214,
            deletions: 38,
            changedFiles: 12,
            createdAt: '2026-08-14T10:00:00Z',
            updatedAt: '2026-08-14T12:00:00Z',
            mergeStateStatus: 'CLEAN',
            reviews: { nodes: [] },
            reviewThreads: { nodes: [] },
            files: { nodes: [] },
            commits: { totalCount: 0, nodes: [] },
            statusOn: { nodes: [] },
            ...overrides,
          },
        ],
      },
    },
  } as unknown as PrQueryResponse;
}

const one = (overrides: Record<string, unknown> = {}) => {
  const [pr] = readPullRequests(response(overrides), IDENTITY);
  if (pr === undefined) throw new Error('expected one PR');
  return pr;
};

describe('the query itself', () => {
  it('asks by head branch, which is the join a task already provides', () => {
    // Every worktree of a task is on one branch named after its slug, so "which
    // PRs belong to this task" is a lookup rather than a guess.
    expect(PR_QUERY).toContain('headRefName: $head');
  });
});

describe('readPullRequests', () => {
  it('reads the ordinary case', () => {
    const pr = one();
    expect(pr).toMatchObject({
      repo: 'shepherd/v2',
      repoKey: 'v2',
      number: 301,
      state: 'open',
      added: 214,
      removed: 38,
      changedFiles: 12,
      mergeState: 'clean',
    });
  });

  it('reads a draft as a draft, though GitHub calls it OPEN', () => {
    expect(one({ isDraft: true }).state).toBe('draft');
    expect(one({ state: 'MERGED', isDraft: false }).state).toBe('merged');
    expect(one({ state: 'CLOSED' }).state).toBe('closed');
  });

  it('answers an empty list for a branch with no PRs', () => {
    expect(readPullRequests({ repository: { pullRequests: { nodes: [] } } }, IDENTITY)).toEqual([]);
    expect(readPullRequests({ repository: null }, IDENTITY)).toEqual([]);
  });
});

describe('checks', () => {
  /*
   * `statusOn`, not `commits` — the query asks for the PR's commits twice under
   * two aliases, because they answer two questions: `commits` is the LIST the
   * Commits tab draws, and `statusOn` is the LAST one, which is the only place
   * a check rollup exists.
   */
  const rollup = (contexts: readonly unknown[]): Record<string, unknown> => ({
    statusOn: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
  });

  const run = (over: Record<string, unknown>): Record<string, unknown> => ({
    __typename: 'CheckRun',
    name: 'typecheck',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    startedAt: null,
    completedAt: null,
    detailsUrl: null,
    summary: null,
    ...over,
  });

  it('needs the status AND the conclusion, because neither says it alone', () => {
    expect(one(rollup([run({ status: 'IN_PROGRESS', conclusion: null })])).checks[0]?.state).toBe('running');
    expect(one(rollup([run({ conclusion: 'SUCCESS' })])).checks[0]?.state).toBe('passed');
    expect(one(rollup([run({ conclusion: 'FAILURE' })])).checks[0]?.state).toBe('failed');
    expect(one(rollup([run({ conclusion: 'TIMED_OUT' })])).checks[0]?.state).toBe('failed');
  });

  it('does not call a cancelled or stale run a failure', () => {
    // A run that did not happen is not a broken build, and colouring the task
    // red for one makes the two indistinguishable.
    for (const conclusion of ['CANCELLED', 'STALE', 'SKIPPED', 'NEUTRAL']) {
      expect(one(rollup([run({ conclusion })])).checks[0]?.state, conclusion).toBe('skipped');
    }
  });

  it('reads the older commit-status API too, which third-party CI still uses', () => {
    const pr = one(
      rollup([
        { __typename: 'StatusContext', context: 'ci/circleci', state: 'FAILURE', targetUrl: 'u', description: '2 errors' },
      ]),
    );
    expect(pr.checks[0]).toEqual({ name: 'ci/circleci', state: 'failed', summary: '2 errors', url: 'u' });
  });

  it('drops a context kind it does not know rather than guessing', () => {
    // Counted as passing, an unknown check makes a green meter a lie; counted as
    // failing, every repo looks broken the day GitHub adds a type.
    expect(one(rollup([{ __typename: 'SomethingNew' }])).checks).toEqual([]);
  });

  it('has no checks at all for a repo with no CI', () => {
    expect(one({ statusOn: { nodes: [{ commit: { statusCheckRollup: null } }] } }).checks).toEqual([]);
  });

  it('times a run only when it has both ends', () => {
    expect(
      one(rollup([run({ startedAt: '2026-08-14T10:00:00Z', completedAt: '2026-08-14T10:00:38Z' })])).checks[0]
        ?.durationMs,
    ).toBe(38_000);
    expect(one(rollup([run({ startedAt: '2026-08-14T10:00:00Z' })])).checks[0]?.durationMs).toBeUndefined();
  });
});

describe('reviews', () => {
  const reviews = (nodes: readonly unknown[]): Record<string, unknown> => ({ reviews: { nodes } });

  it('keeps only each author’s LATEST verdict', () => {
    // A reviewer who asks for changes and then approves is not both.
    const pr = one(
      reviews([
        { state: 'CHANGES_REQUESTED', author: { login: 'sam' } },
        { state: 'APPROVED', author: { login: 'sam' } },
      ]),
    );
    expect(pr.approvals).toEqual(['sam']);
    expect(pr.changesRequested).toEqual([]);
  });

  it('treats a comment and a dismissal as no verdict at all', () => {
    const pr = one(
      reviews([
        { state: 'COMMENTED', author: { login: 'jane' } },
        { state: 'DISMISSED', author: { login: 'sam' } },
      ]),
    );
    expect([pr.approvals, pr.changesRequested]).toEqual([[], []]);
  });

  it('skips a review whose author has been deleted', () => {
    expect(one(reviews([{ state: 'APPROVED', author: null }])).approvals).toEqual([]);
  });
});

describe('review threads', () => {
  const thread = (over: Record<string, unknown>): Record<string, unknown> => ({
    reviewThreads: {
      nodes: [
        {
          id: 'T1',
          isResolved: false,
          resolvedBy: null,
          diffSide: 'RIGHT',
          path: 'src/tree.ts',
          line: 61,
          comments: { nodes: [{ body: 'this drops a case', author: { login: 'sam' } }] },
          ...over,
        },
      ],
    },
  });

  it('reads the first comment as the thread', () => {
    expect(one(thread({})).threads[0]).toEqual({
      id: 'T1',
      author: 'sam',
      path: 'src/tree.ts',
      line: 61,
      side: 'right',
      resolved: false,
      body: 'this drops a case',
    });
  });

  it('reads which SIDE the comment was left on, rather than assuming', () => {
    // Assuming puts a comment about a REMOVED line beside the addition that
    // replaced it: a remark about the code that went away, on the code that
    // arrived.
    expect(one(thread({ diffSide: 'LEFT' })).threads[0]?.side).toBe('left');
    // `RIGHT` is GitHub's own default and the overwhelming case.
    expect(one(thread({ diffSide: null })).threads[0]?.side).toBe('right');
  });

  it('keeps a thread whose line has gone, because you still have to answer it', () => {
    expect(one(thread({ line: null })).threads[0]?.line).toBeNull();
  });

  it('marks one resolved through your own account as yours', () => {
    const yours = one(thread({ isResolved: true, resolvedBy: { login: 'eshaan' } })).threads[0];
    expect(yours?.resolvedByYou).toBe(true);
    const theirs = one(thread({ isResolved: true, resolvedBy: { login: 'jane' } })).threads[0];
    expect(theirs?.resolvedByYou).toBeUndefined();
  });

  it('drops a thread whose every comment has been deleted', () => {
    expect(one(thread({ comments: { nodes: [] } })).threads).toEqual([]);
  });
});

describe('mergeState', () => {
  it('reads unknown for a server that did not send the preview field', () => {
    // A missing Merge button is a much better failure than one that errors.
    expect(one({ mergeStateStatus: null }).mergeState).toBe('unknown');
    expect(one({ mergeStateStatus: 'WHAT' }).mergeState).toBe('unknown');
    expect(one({ mergeStateStatus: 'BLOCKED' }).mergeState).toBe('blocked');
  });
});

describe('readDependsOn', () => {
  it('reads the trailer people actually write, in the forms they write it', () => {
    expect(readDependsOn('Depends-on: shepherd/sdk#44')).toEqual(['shepherd/sdk#44']);
    expect(readDependsOn('depends on: shepherd/sdk#44')).toEqual(['shepherd/sdk#44']);
    expect(readDependsOn('Depends-On: https://github.com/shepherd/sdk/pull/44')).toEqual(['shepherd/sdk#44']);
  });

  it('reads several, and de-duplicates', () => {
    expect(readDependsOn('Depends-on: a/b#1, a/b#2\nDepends-on: a/b#1')).toEqual(['a/b#1', 'a/b#2']);
  });

  it('ignores a PR reference that is not on a Depends-on line', () => {
    // Otherwise every "see also #12" in a description becomes an ordering
    // constraint nobody meant to write.
    expect(readDependsOn('This is a follow-up to shepherd/v2#288.')).toEqual([]);
    expect(readDependsOn('')).toEqual([]);
  });
});
