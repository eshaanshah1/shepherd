import { describe, expect, it } from 'vitest';
import { checkPrompt, reviewPrompt, threadPrompt } from './prompt.ts';
import type { PullRequest, ReviewThread } from './pr.ts';

const PR: PullRequest = {
  repo: 'shepherd/sdk',
  repoKey: 'sdk',
  number: 44,
  title: 'Tab rows in the sdk',
  state: 'open',
  baseRef: 'main',
  headRef: 'tasks/add-multiple-task-tabs',
  headOid: '4f2b91c0d7a3e58146bb0c29fd7e4a1b6c0d3e82',
  url: 'u',
  added: 41,
  removed: 2,
  changedFiles: 3,
  checks: [],
  approvals: [],
  changesRequested: [],
  threads: [],
  comments: [],
  commits: [],
  reviewers: [],
  body: '',
  author: 'someone',
  openedAt: 0,
  updatedAt: 0,
  mergeState: 'blocked',
  dependsOn: [],
};

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'T1',
  author: 'sam',
  at: 0,
  path: 'src/tree.ts',
  line: 61,
  side: 'right',
  resolved: false,
  body: 'this drops the empty case',
  ...over,
});

describe('checkPrompt', () => {
  it('names the check and quotes what it said', () => {
    const prompt = checkPrompt(PR, {
      name: 'typecheck',
      state: 'failed',
      summary: "Type 'string' is not assignable to type 'TabMark'.",
    });
    expect(prompt).toContain('`typecheck` check is failing on shepherd/sdk#44');
    expect(prompt).toContain("Type 'string' is not assignable to type 'TabMark'.");
    expect(prompt).toContain('run the same check locally');
  });

  it('still asks for the fix when GitHub gave nothing but a red tick', () => {
    const prompt = checkPrompt(PR, { name: 'smoke', state: 'failed' });
    expect(prompt).toContain('`smoke` check is failing');
    expect(prompt).not.toContain('What it reported');
  });
});

describe('threadPrompt', () => {
  it('gives the location as path:line, because the agent has files and no browser', () => {
    expect(threadPrompt(PR, thread())).toContain('src/tree.ts:61');
  });

  it('does not invent a line for a comment whose line has gone', () => {
    // A fabricated line number sends the agent to the wrong place with
    // confidence, and the comment is still worth addressing.
    const prompt = threadPrompt(PR, thread({ line: null }));
    expect(prompt).toContain('src/tree.ts');
    expect(prompt).not.toContain(':null');
  });

  it('tells the agent not to change code it disagrees with', () => {
    expect(threadPrompt(PR, thread())).toContain('do not change the code');
  });
});

describe('reviewPrompt', () => {
  it('gathers every unresolved thread into ONE prompt', () => {
    // N prompts would be N agents: `tasks.spawn` opens a pane per call, and a PR
    // with six comments would fill the task with six sessions.
    const prompt = reviewPrompt({
      ...PR,
      threads: [thread(), thread({ id: 'T2', author: 'jane', path: 'src/a.ts', line: 3, body: 'rename this' })],
    });
    expect(prompt).toContain('2 unresolved review comments');
    expect(prompt).toContain('1. @sam on src/tree.ts:61');
    expect(prompt).toContain('2. @jane on src/a.ts:3');
  });

  it('leaves resolved threads out, and says nothing when they all are', () => {
    expect(reviewPrompt({ ...PR, threads: [thread({ resolved: true })] })).toBeNull();
    expect(reviewPrompt(PR)).toBeNull();
  });

  it('counts one comment in the singular', () => {
    expect(reviewPrompt({ ...PR, threads: [thread()] })).toContain('1 unresolved review comment on');
  });
});
