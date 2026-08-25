import { describe, expect, it } from 'vitest';
import { cardFact, OPEN_COMMAND, REVIEW_COMMAND } from './card-fact.ts';
import type { PullRequest } from './pr.ts';

const task = (over: { shipped?: boolean } = {}) => ({ id: 't1', shipped: false, ...over });

const pr = (over: Partial<PullRequest> = {}): PullRequest =>
  ({
    repo: 'owner/repo',
    repoKey: 'repo',
    number: 7,
    title: 'A change',
    state: 'open',
    url: 'https://github.com/owner/repo/pull/7',
    updatedAt: 1,
    openedAt: 1,
    body: '',
    baseRef: 'main',
    headRef: 'feature',
    author: 'someone',
    commits: [],
    checks: [],
    threads: [],
    changesRequested: [],
    approvals: [],
    draft: false,
    mergeable: 'clean',
    ...over,
  }) as PullRequest;

describe('cardFact, with no pull request', () => {
  it('draws GIT’s own mark, not a pull-request one, and opens the review pane', () => {
    /*
     * Was `null`, so a task with no PR had no icon — and with no icon there was
     * no way in to the one view that says what you actually changed.
     *
     * It was then `pull-request-draft`, which is wrong on its own terms: there
     * is no pull request here, that being the whole point of this branch, so a
     * glyph from that family names a thing that does not exist. `pull-request-
     * draft` is GitHub's mark for a PR opened AS a draft.
     *
     * What exists is a worktree with changes in it. `brand-git` is the noun for
     * that, and `brand` is identity rather than state — git's orange says whose
     * mark it is and nothing about whether the row needs you.
     */
    const fact = cardFact(task(), [], true);
    expect(fact).toMatchObject({
      icon: 'brand-git',
      tone: 'brand',
      command: { id: REVIEW_COMMAND, args: { task: 't1' } },
    });
    expect(fact?.title).toContain('No pull request yet');
  });

  it('draws NOTHING before the task has been synced', () => {
    // "No PR" is a claim, and a glyph drawn before anything is known would be
    // making it. The narrowed version of the rule the old `null` encoded.
    expect(cardFact(task(), [], false)).toBeNull();
  });

  it('draws nothing on shipped work, which is not waiting for a PR', () => {
    expect(cardFact(task({ shipped: true }), [], true)).toBeNull();
  });
});

describe('cardFact, with a pull request', () => {
  it('draws the pull-request glyph and opens the review pane', () => {
    expect(cardFact(task(), [pr()], true)).toMatchObject({
      icon: 'pull-request',
      command: { id: REVIEW_COMMAND, args: { task: 't1' } },
    });
  });

  it('says the NUMBER on shipped work, and opens it on GitHub', () => {
    // On finished work the state is always merged; the useful fact is which PR
    // it was.
    expect(cardFact(task({ shipped: true }), [pr({ state: 'merged' })], true)).toMatchObject({
      label: 'repo #7',
      command: { id: OPEN_COMMAND, args: { url: 'https://github.com/owner/repo/pull/7' } },
    });
  });

  it('says nothing on shipped work with two merged PRs, which no label can name', () => {
    const two = [pr({ state: 'merged' }), pr({ number: 8, state: 'merged' })];
    expect(cardFact(task({ shipped: true }), two, true)).toBeNull();
  });
});
