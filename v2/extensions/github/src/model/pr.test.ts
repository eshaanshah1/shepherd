import { describe, expect, it } from 'vitest';
import {
  blockedBy,
  canMerge,
  checksSaid,
  countChecks,
  landOrder,
  prKey,
  reviewSaid,
  rollUp,
  rollUpSaid,
  stackLabel,
  stateWord,
  type CheckRun,
  type PullRequest,
} from './pr.ts';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: 'shepherd/v2',
    repoKey: 'v2',
    number: 301,
    title: 'Add multiple task tabs',
    state: 'open',
    baseRef: 'main',
    headRef: 'tasks/add-multiple-task-tabs',
    url: 'https://github.com/shepherd/v2/pull/301',
    added: 214,
    removed: 38,
    changedFiles: 12,
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

const check = (name: string, state: CheckRun['state']): CheckRun => ({ name, state });
const green = (n: number): CheckRun[] => Array.from({ length: n }, (_, i) => check(`job-${i}`, 'passed'));

describe('countChecks', () => {
  it('leaves a skipped check out of the total', () => {
    // A conditional job that did not match its path filter would otherwise make
    // `12 of 13` the healthy state — a number that is never green.
    const counts = countChecks([check('lint', 'passed'), check('typecheck', 'failed'), check('test', 'skipped')]);
    expect(counts).toEqual({ total: 2, passed: 1, failed: 1, running: 0 });
  });
});

describe('stateWord', () => {
  it('names the check that failed, not the count', () => {
    // "1 check failed" sends you to the PR to find out which one.
    expect(stateWord(pr({ checks: [check('lint', 'passed'), check('typecheck', 'failed')] }))).toEqual({
      text: 'typecheck failed',
      tone: 'negative',
    });
  });

  it('puts a red check above a requested change', () => {
    // Both are true and only one is actionable alone — and the review cannot be
    // addressed without a green build anyway.
    const said = stateWord(pr({ checks: [check('typecheck', 'failed')], changesRequested: ['sam'] }));
    expect(said.text).toBe('typecheck failed');
  });

  it('reads a draft as a draft whatever its checks say', () => {
    expect(stateWord(pr({ state: 'draft', checks: [check('typecheck', 'failed')] }))).toEqual({
      text: 'draft',
      tone: 'quiet',
    });
  });

  it('says approved only once the checks are done', () => {
    expect(stateWord(pr({ approvals: ['jane'], checks: green(12) })).text).toBe('approved');
    expect(stateWord(pr({ approvals: ['jane'], checks: [check('test', 'running')] })).text).toBe('checks running');
  });

  it('falls through to open for a PR nobody has looked at', () => {
    expect(stateWord(pr())).toEqual({ text: 'open', tone: 'neutral' });
  });

  it('says merged and closed and stops there', () => {
    expect(stateWord(pr({ state: 'merged', checks: [check('x', 'failed')] })).text).toBe('merged');
    expect(stateWord(pr({ state: 'closed' })).text).toBe('closed');
  });
});

describe('the mono line', () => {
  it('counts checks, and is negative the moment one failed', () => {
    expect(checksSaid(pr({ checks: [check('a', 'passed'), check('b', 'failed'), check('c', 'running')] }))).toEqual({
      text: '1 of 3 checks',
      tone: 'negative',
    });
    expect(checksSaid(pr({ checks: green(12) }))).toEqual({ text: '12 of 12 checks', tone: 'positive' });
    expect(checksSaid(pr())).toEqual({ text: 'checks not run', tone: 'quiet' });
  });

  it('says who reviewed, and says nothing at all on a draft', () => {
    // On a draft, "no review yet" reports something nobody was going to do.
    expect(reviewSaid(pr({ approvals: ['jane'] }))).toEqual({ text: '@jane', tone: 'positive' });
    expect(reviewSaid(pr({ changesRequested: ['sam'] }))).toEqual({ text: '@sam', tone: 'negative' });
    expect(reviewSaid(pr())).toEqual({ text: 'no review yet', tone: 'quiet' });
    expect(reviewSaid(pr({ state: 'draft' }))).toBeNull();
    expect(reviewSaid(pr({ state: 'merged' }))).toBeNull();
  });
});

describe('a stack in one repo', () => {
  const bottom = pr({ number: 301, baseRef: 'main', headRef: 'tabs' });
  const top = pr({ number: 305, state: 'draft', baseRef: 'tabs', headRef: 'tab-overflow' });
  const elsewhere = pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 44, headRef: 'sdk-tabs' });

  it('labels each member, and says what the upper one sits on', () => {
    expect(stackLabel(bottom, [bottom, top, elsewhere])).toBe('1 of 2');
    expect(stackLabel(top, [bottom, top, elsewhere])).toBe('2 of 2 · on #301');
  });

  it('says nothing for a repo with one PR', () => {
    // `1 of 1` is a fact about a set of one, drawn on every row of every
    // ordinary task.
    expect(stackLabel(elsewhere, [bottom, top, elsewhere])).toBeNull();
  });

  it('agrees whichever member is asked', () => {
    const fromTop = stackLabel(top, [top, bottom]);
    const fromBottom = stackLabel(bottom, [top, bottom]);
    expect([fromBottom, fromTop]).toEqual(['1 of 2', '2 of 2 · on #301']);
  });

  it('does not chain through a merged PR', () => {
    // Its head ref may still exist; it is not something you are landing on.
    const merged = pr({ number: 300, state: 'merged', baseRef: 'main', headRef: 'earlier' });
    const on = pr({ number: 301, baseRef: 'earlier', headRef: 'tabs' });
    expect(stackLabel(on, [merged, on])).toBeNull();
  });

  it('terminates on a cycle rather than hanging', () => {
    // Two PRs based on each other is something git permits and a person can
    // create. There is no correct position in a cycle, so the claim is only that
    // both members get a coherent label and neither walk runs forever.
    const a = pr({ number: 1, baseRef: 'b', headRef: 'a' });
    const b = pr({ number: 2, baseRef: 'a', headRef: 'b' });
    expect(stackLabel(a, [a, b])).toBe('2 of 2 · on #2');
    expect(stackLabel(b, [a, b])).toBe('2 of 2 · on #1');
  });
});

describe('landOrder', () => {
  const sdk = pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 44, headRef: 'sdk-tabs', baseRef: 'main' });
  const first = pr({ number: 301, baseRef: 'main', headRef: 'tabs', dependsOn: ['shepherd/sdk#44'] });
  const second = pr({ number: 305, state: 'draft', baseRef: 'tabs', headRef: 'tab-overflow' });

  it('is base refs within a repo and Depends-on across them', () => {
    expect(landOrder([second, first, sdk]).map(prKey)).toEqual([
      'shepherd/sdk#44',
      'shepherd/v2#301',
      'shepherd/v2#305',
    ]);
  });

  it('leaves out anything already finished', () => {
    const merged = pr({ number: 288, state: 'merged' });
    expect(landOrder([merged, first]).map(prKey)).toEqual(['shepherd/v2#301']);
  });

  it('falls back to a STABLE order rather than reporting a cycle', () => {
    // A list that reorders itself when CI touches a PR is a list whose rows move
    // under the cursor. Order by (repo, number) — never by updatedAt.
    const a = pr({ number: 1, dependsOn: ['shepherd/sdk#2'] });
    const b = pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 2, dependsOn: ['shepherd/v2#1'] });
    expect(landOrder([a, b])).toHaveLength(2);
    expect(landOrder([b, a])).toHaveLength(2);
  });

  it('ignores a Depends-on naming something not in the set', () => {
    expect(landOrder([pr({ dependsOn: ['other/repo#9'] })]).map(prKey)).toEqual(['shepherd/v2#301']);
  });
});

describe('what is stopping this', () => {
  it('refuses to call an unknown merge state mergeable', () => {
    // `unknown` is what GitHub answers for the first seconds of every PR's life.
    expect(canMerge(pr({ mergeState: 'unknown' }))).toBe(false);
    expect(canMerge(pr({ mergeState: 'clean' }))).toBe(true);
    expect(canMerge(pr({ mergeState: 'clean', checks: [check('a', 'failed')] }))).toBe(false);
    expect(canMerge(pr({ state: 'draft', mergeState: 'clean' }))).toBe(false);
  });

  it('names the EARLIEST blocker, since the later ones may only be blocked by it', () => {
    const sdk = pr({
      repo: 'shepherd/sdk',
      repoKey: 'sdk',
      number: 44,
      headRef: 'sdk-tabs',
      checks: [check('typecheck', 'failed')],
    });
    const later = pr({ number: 301, dependsOn: ['shepherd/sdk#44'], mergeState: 'blocked' });
    expect(blockedBy([later, sdk])?.number).toBe(44);
  });

  it('is null when every PR can land', () => {
    expect(blockedBy([pr({ checks: green(3) })])).toBeNull();
  });
});

describe('the task-level rollup', () => {
  it('is the worst thing true of any live PR', () => {
    const failing = pr({ number: 44, checks: [check('typecheck', 'failed')] });
    const approved = pr({ number: 301, approvals: ['jane'], checks: green(12) });
    expect(rollUp([approved, failing])).toBe('failed');
    expect(rollUp([approved, pr({ number: 9, changesRequested: ['sam'] })])).toBe('waiting');
    expect(rollUp([approved, pr({ number: 9, checks: [check('t', 'running')] })])).toBe('running');
  });

  it('is approved only when EVERY live PR is', () => {
    const approved = pr({ number: 301, approvals: ['jane'] });
    expect(rollUp([approved])).toBe('approved');
    expect(rollUp([approved, pr({ number: 9 })])).toBe('open');
    // A draft cannot be approved, so a stack with one in it is not approved.
    expect(rollUp([approved, pr({ number: 9, state: 'draft' })])).toBe('open');
  });

  it('reports merged only once nothing is live', () => {
    const merged = pr({ number: 288, state: 'merged' });
    expect(rollUp([merged])).toBe('merged');
    expect(rollUp([merged, pr({ number: 301 })])).toBe('open');
    expect(rollUp([])).toBe('none');
    expect(rollUp([pr({ state: 'closed' })])).toBe('none');
  });

  it('says the count and the reason, or nothing when there is no PR', () => {
    expect(rollUpSaid([])).toBeNull();
    expect(rollUpSaid([pr({ checks: [check('typecheck', 'failed')] })])).toBe('#301 · a check failed');
    expect(rollUpSaid([pr({ number: 1 }), pr({ number: 2, checks: [check('t', 'failed')] })])).toBe(
      '2 PRs · a check failed',
    );
    expect(rollUpSaid([pr({ number: 309, state: 'merged' })])).toBe('#309 merged');
  });
});
