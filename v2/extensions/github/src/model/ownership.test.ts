import { describe, expect, it } from 'vitest';
import type { PullRequest } from './pr.ts';
import { isTaskWork, needsHead, ownedByTask } from './ownership.ts';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: 'shepherd/v2',
    repoKey: 'v2',
    number: 301,
    author: 'someone',
    title: 'Add multiple task tabs',
    state: 'open',
    baseRef: 'main',
    headRef: 'tabs',
    headOid: HEAD,
    url: 'u',
    added: 1,
    removed: 0,
    changedFiles: 1,
    checks: [],
    approvals: [],
    changesRequested: [],
    threads: [],
    comments: [],
    commits: [],
    reviewers: [],
    body: '',
    openedAt: 0,
    updatedAt: 0,
    mergeState: 'clean',
    dependsOn: [],
    ...overrides,
  };
}

const commit = (sha: string): PullRequest['commits'][number] => ({
  sha,
  subject: 's',
  author: 'a',
  added: 0,
  removed: 0,
  at: 0,
});

describe('a live PR', () => {
  it('belongs to the task whatever the HEAD says', () => {
    // Its head ref is a branch that exists right now, under the name this task
    // owns. Two live PRs cannot share that.
    expect(isTaskWork(pr({ state: 'open', headOid: OTHER }), HEAD)).toBe(true);
    expect(isTaskWork(pr({ state: 'draft', headOid: OTHER }), HEAD)).toBe(true);
  });

  it('belongs even mid-push, when the task has moved past it', () => {
    // The agent committed locally after opening the PR. Judging an open PR on
    // commits would hide it for exactly as long as the work was ahead of it.
    expect(isTaskWork(pr({ state: 'open' }), OTHER)).toBe(true);
  });
});

describe('a finished PR', () => {
  it('belongs when the task’s HEAD is its tip', () => {
    expect(isTaskWork(pr({ state: 'merged' }), HEAD)).toBe(true);
    expect(isTaskWork(pr({ state: 'closed' }), HEAD)).toBe(true);
  });

  it('belongs when the task’s HEAD is one of its commits, not its tip', () => {
    // A branch updated from the web, or a merge queue's own commit, leaves HEAD
    // inside the PR without being what GitHub calls its head.
    const merged = pr({ state: 'merged', headOid: OTHER, commits: [commit(OTHER), commit(HEAD)] });
    expect(isTaskWork(merged, HEAD)).toBe(true);
  });

  it('does NOT belong when the branch name is all it shares', () => {
    // The case this whole module exists for: a task took a slug some earlier
    // branch had, and GitHub answers truthfully about a `fix-login` that is
    // somebody else's.
    const stranger = pr({ state: 'merged', headOid: OTHER, commits: [commit(OTHER)] });
    expect(isTaskWork(stranger, HEAD)).toBe(false);
  });
});

describe('what cannot be judged', () => {
  it('belongs when there is no HEAD to judge against', () => {
    // git unreadable, or a worktree that has gone. An extra merged PR is noise;
    // a missing one reads as the integration being broken.
    expect(isTaskWork(pr({ state: 'merged', headOid: OTHER }), null)).toBe(true);
    expect(isTaskWork(pr({ state: 'merged', headOid: OTHER }), '')).toBe(true);
  });

  it('belongs when GitHub sent no head commit', () => {
    expect(isTaskWork(pr({ state: 'merged', headOid: '' }), HEAD)).toBe(true);
  });
});

describe('ownedByTask', () => {
  it('reports what it dropped as well as what it kept', () => {
    // Both halves: a caller that cannot say what it dropped is a silent filter.
    const mine = pr({ number: 1, state: 'merged' });
    const stranger = pr({ number: 2, state: 'merged', headOid: OTHER });
    const { kept, dropped } = ownedByTask([mine, stranger], HEAD);
    expect(kept.map((p) => p.number)).toEqual([1]);
    expect(dropped.map((p) => p.number)).toEqual([2]);
  });
});

describe('needsHead', () => {
  it('is false for the ordinary task, so the read never happens', () => {
    expect(needsHead([])).toBe(false);
    expect(needsHead([pr({ state: 'open' }), pr({ state: 'draft' })])).toBe(false);
  });

  it('is true as soon as one PR is finished', () => {
    expect(needsHead([pr({ state: 'open' }), pr({ state: 'merged' })])).toBe(true);
  });
});
