import { describe, expect, it } from 'vitest';
import type { Clock } from '@shepherd/sdk';
import type { PullRequest } from './model/pr.ts';
import type { RepoSlug } from './model/remote.ts';
import type { GitHubClient } from './client.ts';
import { changed, keepPatches, Sync, SYNC_INTERVALS, type TaskSubject } from './sync.ts';

function fakeClock(): Clock & { advance(ms: number): void } {
  let at = 1_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  } as Clock & { advance(ms: number): void };
}

/** The commit the task's WORKTREE is on, unless a test says otherwise. */
const HEAD = 'a71c4e9b28d5f0631ac8e7b4920df15c6e83a047';
/**
 * What the user's own checkout is on — trunk, and never this task's work.
 *
 * The harness answers it for every path but the worktree, so a read of the
 * wrong one fails the ownership tests rather than passing by coincidence.
 */
const TRUNK = 'f0a3c71d95b6e284037ac5f1b8d629e4713ca580';
const STRANGER = '2d68b5f0913ce7a4820db6135f9e074ac2b81d6f';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: 'shepherd/v2',
    repoKey: 'v2',
    number: 301,
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
    reviewDecision: 'none' as const,
    threads: [],
    comments: [],
    commits: [],
    reviewers: [],
    body: '',
    author: 'someone',
    openedAt: 0,
    updatedAt: 0,
    mergeState: 'clean',
    dependsOn: [],
    ...overrides,
  };
}

const TASK: TaskSubject = {
  id: 't-1',
  root: '/tasks/slate-merino',
  /** `path` is the user's own checkout; the task's is `<root>/<name>`. */
  repos: [{ path: '/repos/v2', name: 'v2' }],
  shipped: false,
};

const WORKTREE = '/tasks/slate-merino/v2';

interface Harness {
  readonly sync: Sync;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly asked: { slug: RepoSlug; branch: string }[];
  /** Every path whose HEAD was read — the cost `needsHead` exists to avoid. */
  readonly headReads: string[];
  /** Every WORKTREE whose HEAD branch was read — the branch is git's to answer. */
  readonly branchReads: string[];
  readonly logs: string[];
  readonly redraws: () => number;
  readonly authFailures: () => number;
  answer: (prs: readonly PullRequest[]) => void;
  fail: (error: unknown) => void;
}

function harness(
  options: { remote?: RepoSlug | null; head?: string | null; branch?: string | null } = {},
): Harness {
  const clock = fakeClock();
  const branchReads: string[] = [];
  const asked: { slug: RepoSlug; branch: string }[] = [];
  const headReads: string[] = [];
  const logs: string[] = [];
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
    // The two writes `sync` never makes: it polls, and opening a PR is a verb.
    defaultBranch: () => Promise.resolve('main'),
    createPr: () => Promise.resolve({ ok: true, url: 'https://example.invalid/pr/1' }),
    commit: () => Promise.resolve([]),
    files: () => Promise.resolve([]),
  };

  const sync = new Sync({
    clock,
    client: () => client,
    remoteOf: () =>
      Promise.resolve(options.remote === undefined ? { owner: 'shepherd', repo: 'v2' } : options.remote),
    headOf: (path) => {
      headReads.push(path);
      if (options.head !== undefined) return Promise.resolve(options.head);
      return Promise.resolve(path === WORKTREE ? HEAD : TRUNK);
    },
    branchOf: (worktree) => {
      branchReads.push(worktree);
      return Promise.resolve(
        options.branch === undefined ? 'tasks/add-multiple-task-tabs' : options.branch,
      );
    },
    onChanged: () => (redraws += 1),
    onAuthFailure: () => (authFailures += 1),
    log: (line) => logs.push(line),
  });

  return {
    sync,
    clock,
    asked,
    headReads,
    branchReads,
    logs,
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

describe('a PR that only shares the branch name', () => {
  it('is dropped, and said out loud', async () => {
    // A task took a slug some earlier branch had. GitHub answers truthfully
    // about a branch of that name and means somebody else's work.
    const h = harness();
    h.answer([pr({ number: 288, state: 'merged', headOid: STRANGER })]);
    await h.sync.pass([TASK]);
    expect(h.sync.prsOf('t-1')).toEqual([]);
    expect(h.logs.join(' ')).toContain('#288');
  });

  it('keeps this task’s own merged PR beside it', async () => {
    const h = harness();
    h.answer([
      pr({ number: 301, state: 'merged' }),
      pr({ number: 288, state: 'merged', headOid: STRANGER }),
    ]);
    await h.sync.pass([TASK]);
    expect(h.sync.prsOf('t-1').map((entry) => entry.number)).toEqual([301]);
  });

  it('keeps everything when the HEAD cannot be read', async () => {
    // A missing PR reads as the integration being broken; an extra one is noise.
    const h = harness({ head: null });
    h.answer([pr({ number: 288, state: 'merged', headOid: STRANGER })]);
    await h.sync.pass([TASK]);
    expect(h.sync.prsOf('t-1')).toHaveLength(1);
  });

  it('never reads HEAD for the ordinary task', async () => {
    // The read is a subprocess, and a task whose PRs are all open — or which has
    // none at all — needs no judgement.
    const h = harness();
    h.answer([pr({ state: 'open' })]);
    await h.sync.pass([TASK]);
    expect(h.headReads).toEqual([]);

    h.answer([pr({ state: 'merged' })]);
    h.clock.advance(SYNC_INTERVALS.live);
    await h.sync.pass([TASK]);
    expect(h.headReads).toEqual([WORKTREE]);
  });

  it('reads the WORKTREE’s HEAD, not the user’s own checkout', async () => {
    // The checkout the task was made from sits on trunk and has never seen this
    // task's commits, so judging a merged PR against it dropped every one of
    // them — and a task with no PRs draws git's mark, so a PR merging made the
    // glyph go backwards.
    const h = harness();
    h.answer([pr({ number: 301, state: 'merged' })]);
    await h.sync.pass([TASK]);
    expect(h.headReads).toEqual([WORKTREE]);
    expect(h.sync.prsOf('t-1').map((entry) => entry.number)).toEqual([301]);
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

/**
 * Which branch a task is on is GIT's answer, not the task record's.
 *
 * A task's branch used to be its slug, so a record was enough. The slug is
 * minted now and an agent is invited to rename the branch it works on, so the
 * only place that knows is the worktree.
 */
describe('reading the branch', () => {
  it('asks the worktree, not the task, and queries what it answered', async () => {
    const h = harness({ branch: 'fix-login' });
    h.answer([]);
    await h.sync.pass([TASK]);

    expect(h.branchReads).toEqual(['/tasks/slate-merino/v2']);
    expect(h.asked.map((ask) => ask.branch)).toEqual(['fix-login']);
  });

  // `symbolic-ref` fails on a detached head where `rev-parse --abbrev-ref`
  // answers the literal string `HEAD` — a perfectly valid thing to ask GitHub
  // about and never what anybody meant.
  it('asks for no PRs when a worktree is not on a branch', async () => {
    const h = harness({ branch: null });
    h.answer([]);
    await h.sync.pass([TASK]);

    expect(h.asked).toEqual([]);
  });
});

describe('keepPatches', () => {
  /*
   * A sync pass is one GraphQL round trip and GraphQL has no patch field, so a
   * pass describes every file and carries the diff of none. Writing it straight
   * over the held answer deleted every fetched patch every twenty seconds —
   * and `github.diff` then answered `cached` for them, because its key is
   * `<pr>@<updatedAt>` and `updatedAt` had not moved. The Files tab said "the
   * diff for this file has not been fetched" until somebody pushed.
   */
  const withPatch = pr({
    files: [
      { path: 'a.ts', added: 1, removed: 0, patch: '@@ -1 +1 @@' },
      { path: 'b.ts', added: 2, removed: 0, patch: '@@ -2 +2 @@' },
    ],
  });
  const fromGraphql = pr({ files: [{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.ts', added: 2, removed: 0 }] });

  it('carries a fetched patch onto an answer that has none', () => {
    const [kept] = keepPatches([fromGraphql], [withPatch]);
    expect(kept?.files?.map((file) => file.patch)).toEqual(['@@ -1 +1 @@', '@@ -2 +2 @@']);
  });

  it('drops them when the PR has moved, because then they are stale', () => {
    // `github.diff`'s cache key changes with `updatedAt` too, so the next look
    // asks GitHub again rather than drawing a diff of the previous head.
    const [kept] = keepPatches([{ ...fromGraphql, updatedAt: 5 }], [withPatch]);
    expect(kept?.files?.every((file) => file.patch === undefined)).toBe(true);
  });

  it('matches by path, so a file that left the PR carries nothing', () => {
    const renamed = pr({ files: [{ path: 'c.ts', added: 1, removed: 0 }] });
    const [kept] = keepPatches([renamed], [withPatch]);
    expect(kept?.files).toEqual([{ path: 'c.ts', added: 1, removed: 0 }]);
  });

  it('leaves another PR’s patches alone', () => {
    const other = pr({ number: 999, files: [{ path: 'a.ts', added: 1, removed: 0 }] });
    const [kept] = keepPatches([other], [withPatch]);
    expect(kept?.files?.[0]?.patch).toBeUndefined();
  });

  it('is a no-op with nothing held', () => {
    expect(keepPatches([fromGraphql], [])).toEqual([fromGraphql]);
  });
});

describe('keepPatches, on the fields beside the patch', () => {
  /*
   * A pass answers from GraphQL, which knows a path and two counts. Everything
   * the REST call added — the patch, and what GitHub said HAPPENED to the file —
   * has to survive it, or a renamed file reports "its contents are identical"
   * twenty seconds after it reported the truth.
   */
  const held = pr({
    files: [{ path: 'new.ts', added: 0, removed: 0, status: 'renamed', previousPath: 'old.ts' }],
  });
  const fromGraphql = pr({ files: [{ path: 'new.ts', added: 0, removed: 0 }] });

  it('carries `status` and `previousPath`, not only the patch', () => {
    const [kept] = keepPatches([fromGraphql], [held]);
    expect(kept?.files?.[0]?.status).toBe('renamed');
    expect(kept?.files?.[0]?.previousPath).toBe('old.ts');
  });

  it('still drops them when the PR has moved', () => {
    const [kept] = keepPatches([{ ...fromGraphql, updatedAt: 9 }], [held]);
    expect(kept?.files?.[0]?.status).toBeUndefined();
  });
});
