import { describe, expect, it } from 'vitest';
import type { Clock } from '@shepherd/sdk';
import type { PullRequest } from './model/pr.ts';
import type { RepoSlug } from './model/remote.ts';
import type { GitHubClient } from './client.ts';
import { changed, Sync, SYNC_INTERVALS, type TaskSubject } from './sync.ts';

function fakeClock(): Clock & { advance(ms: number): void } {
  let at = 1_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  } as Clock & { advance(ms: number): void };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: 'shepherd/v2',
    repoKey: 'v2',
    number: 301,
    title: 'Add multiple task tabs',
    state: 'open',
    baseRef: 'main',
    headRef: 'tabs',
    url: 'u',
    added: 1,
    removed: 0,
    changedFiles: 1,
    checks: [],
    approvals: [],
    changesRequested: [],
    threads: [],
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

const TASK: TaskSubject = {
  id: 't-1',
  branch: 'tasks/add-multiple-task-tabs',
  repos: [{ path: '/repos/v2', name: 'v2' }],
  shipped: false,
};

interface Harness {
  readonly sync: Sync;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly asked: { slug: RepoSlug; branch: string }[];
  readonly redraws: () => number;
  readonly authFailures: () => number;
  answer: (prs: readonly PullRequest[]) => void;
  fail: (error: unknown) => void;
}

function harness(options: { remote?: RepoSlug | null } = {}): Harness {
  const clock = fakeClock();
  const asked: { slug: RepoSlug; branch: string }[] = [];
  let redraws = 0;
  let authFailures = 0;
  let answer: readonly PullRequest[] = [];
  let failure: unknown;

  const client: GitHubClient = {
    viewer: () => Promise.resolve('eshaan'),
    pullRequests: (slug, branch) => {
      asked.push({ slug, branch });
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(answer);
    },
    merge: () => Promise.resolve({ ok: true }),
    files: () => Promise.resolve([]),
  };

  const sync = new Sync({
    clock,
    client: () => client,
    remoteOf: () =>
      Promise.resolve(options.remote === undefined ? { owner: 'shepherd', repo: 'v2' } : options.remote),
    onChanged: () => (redraws += 1),
    onAuthFailure: () => (authFailures += 1),
    log: () => {},
  });

  return {
    sync,
    clock,
    asked,
    redraws: () => redraws,
    authFailures: () => authFailures,
    answer: (prs) => {
      answer = prs;
      failure = undefined;
    },
    fail: (error) => {
      failure = error;
    },
  };
}

describe('a pass', () => {
  it('asks about a task’s branch, once per repo', async () => {
    const h = harness();
    h.answer([pr()]);
    await h.sync.pass([TASK]);
    expect(h.asked).toEqual([
      { slug: { owner: 'shepherd', repo: 'v2' }, branch: 'tasks/add-multiple-task-tabs' },
    ]);
    expect(h.sync.prsOf('t-1')).toHaveLength(1);
  });

  it('skips a repo with no GitHub remote, silently', async () => {
    // Not a failure and not worth a word on screen: every multi-repo user has a
    // scratch repo or a vendored checkout.
    const h = harness({ remote: null });
    await h.sync.pass([TASK]);
    expect(h.asked).toEqual([]);
    expect(h.sync.get('t-1')?.error).toBeUndefined();
  });

  it('does not ask again until the answer is stale', async () => {
    const h = harness();
    await h.sync.pass([TASK]);
    await h.sync.pass([TASK]);
    expect(h.asked).toHaveLength(1);

    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);
    expect(h.asked).toHaveLength(2);
  });

  it('asks far more often while the review tab is open', async () => {
    const h = harness();
    await h.sync.pass([TASK]);
    h.sync.watch('t-1');
    h.clock.advance(SYNC_INTERVALS.open);
    await h.sync.pass([TASK]);
    expect(h.asked).toHaveLength(2);

    h.sync.unwatch('t-1');
    h.clock.advance(SYNC_INTERVALS.open);
    await h.sync.pass([TASK]);
    expect(h.asked).toHaveLength(2);
  });

  it('leaves finished work alone', async () => {
    const shipped = { ...TASK, shipped: true };
    const h = harness();
    await h.sync.pass([shipped]);
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([shipped]);
    expect(h.asked).toHaveLength(1);
    expect(h.sync.intervalFor(shipped)).toBe(SYNC_INTERVALS.shipped);
  });

  it('asks about a task with no PRs on the same clock as one with them', async () => {
    // "A PR has just been opened" is the transition nobody would otherwise see —
    // and the one that puts the glyph on the row for the first time.
    const h = harness();
    h.answer([]);
    await h.sync.pass([TASK]);
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);
    expect(h.asked).toHaveLength(2);
  });

  it('forgets a task that is no longer in the list', async () => {
    const h = harness();
    h.answer([pr()]);
    await h.sync.pass([TASK]);
    await h.sync.pass([]);
    expect(h.sync.get('t-1')).toBeUndefined();
  });

  it('re-asks everything when the user asks', async () => {
    const h = harness();
    await h.sync.pass([TASK]);
    await h.sync.pass([TASK], true);
    expect(h.asked).toHaveLength(2);
  });
});

describe('when GitHub does not answer', () => {
  it('keeps the previous PRs and says what went wrong', async () => {
    // An empty review tab on a wifi blip is the flicker this avoids.
    const h = harness();
    h.answer([pr()]);
    await h.sync.pass([TASK]);

    h.fail(new Error('socket hang up'));
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);

    expect(h.sync.prsOf('t-1')).toHaveLength(1);
    expect(h.sync.get('t-1')?.error).toContain('socket hang up');
  });

  it('reports an expired credential once and stops, rather than every tick', async () => {
    const h = harness();
    h.fail(Object.assign(new Error('Bad credentials'), { status: 401 }));
    await h.sync.pass([TASK]);
    expect(h.authFailures()).toBe(1);
    expect(h.sync.get('t-1')?.error).toBe('not signed in');
  });
});

describe('redraws', () => {
  it('happen when something drawn changed', async () => {
    const h = harness();
    h.answer([pr()]);
    await h.sync.pass([TASK]);
    expect(h.redraws()).toBe(1);

    h.answer([pr({ approvals: ['jane'] })]);
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);
    expect(h.redraws()).toBe(2);
  });

  it('do NOT happen when the answer is the same', async () => {
    // A redraw is a full tree re-read across a port, and on a quiet afternoon
    // every sync finds nothing.
    const h = harness();
    h.answer([pr()]);
    await h.sync.pass([TASK]);
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);
    expect(h.redraws()).toBe(1);
  });
});

describe('changed', () => {
  const held = (prs: readonly PullRequest[]) => ({ prs, syncedAt: 0 });

  it('ignores the sync time, which is different every time by construction', () => {
    expect(changed({ prs: [pr()], syncedAt: 1 }, { prs: [pr()], syncedAt: 99 })).toBe(false);
  });

  it('sees every field a row or a pane draws', () => {
    expect(changed(held([pr()]), held([pr({ state: 'merged' })]))).toBe(true);
    expect(changed(held([pr()]), held([pr({ approvals: ['jane'] })]))).toBe(true);
    expect(changed(held([pr()]), held([pr({ checks: [{ name: 'lint', state: 'failed' }] })]))).toBe(true);
    expect(changed(held([pr()]), held([pr({ mergeState: 'blocked' })]))).toBe(true);
    expect(changed(held([pr()]), held([]))).toBe(true);
  });

  it('ignores a field nothing draws', () => {
    // `updatedAt` moves whenever CI touches a PR, which is constantly.
    expect(changed(held([pr()]), held([pr({ updatedAt: 12_345 })]))).toBe(false);
  });
});
