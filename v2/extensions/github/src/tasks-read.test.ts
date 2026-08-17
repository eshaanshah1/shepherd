import { describe, expect, it } from 'vitest';
import { readRoots, readTasks } from './tasks-read.ts';

describe('readTasks', () => {
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 't-1',
    slug: 'add-github-pr-tracking',
    title: 'Add GitHub PR tracking',
    lifecycle: 'running',
    repos: [{ path: '/repos/v2', name: 'v2' }],
    // Both, on purpose: `root` is a DIRECTORY and `group` is the pane group, and
    // reading the wrong one opens a review tab in a group of its own.
    root: '/data/tasks/add-github-pr-tracking',
    group: 'task:t-1',
    sessions: [{ id: 's-1', role: 'orchestrator' }],
    ...over,
  });

  it('reads a task, and keeps the root its worktrees are under', () => {
    // The ROOT rather than a branch: the branch is git's to answer, per worktree,
    // and this is what says where those worktrees are.
    expect(readTasks([task()])).toEqual([
      {
        id: 't-1',
        root: '/data/tasks/add-github-pr-tracking',
        title: 'Add GitHub PR tracking',
        shipped: false,
        repos: [{ path: '/repos/v2', name: 'v2' }],
        group: 'task:t-1',
        agents: [{ id: 's-1', role: 'orchestrator' }],
      },
    ]);
  });

  it('reads an archived task as shipped', () => {
    expect(readTasks([task({ lifecycle: 'archived' })])[0]?.shipped).toBe(true);
  });

  it('drops a record with no id, slug or root rather than inventing one', () => {
    // Each is an identifier; an invented root would read a branch out of some
    // other directory and query somebody else's work.
    expect(
      readTasks([task({ id: undefined }), task({ slug: '' }), task({ root: undefined }), 7, null]),
    ).toEqual([]);
  });

  it('drops a half-formed repo and keeps the rest of the task', () => {
    const [read] = readTasks([task({ repos: [{ path: '/a' }, { name: 'b' }, { path: '/c', name: 'c' }] })]);
    expect(read?.repos).toEqual([{ path: '/c', name: 'c' }]);
  });

  it('survives a shape it has never seen', () => {
    expect(readTasks('not a list')).toEqual([]);
    expect(readTasks([task({ repos: 'nope', group: 12 })])[0]).toMatchObject({ repos: [], group: null });
  });
});

describe('readRoots', () => {
  it('finds the view types a persisted tree holds, at any depth', () => {
    // This is how "does this task already have a review tab" is answered without
    // keeping a record of the panes we opened — a record that would be wrong the
    // moment a user closed one.
    const roots = readRoots([
      {
        root: 'task:t-1/tab-2',
        group: 'task:t-1',
        tree: {
          kind: 'split',
          axis: 'row',
          first: { kind: 'leaf', pane: { id: 'p1' } },
          second: {
            kind: 'split',
            axis: 'column',
            first: { kind: 'leaf', pane: { id: 'p2', view: { type: 'github.review' } } },
            second: { kind: 'leaf', pane: { id: 'p3' } },
          },
        },
      },
    ]);
    expect(roots).toEqual([{ root: 'task:t-1/tab-2', group: 'task:t-1', viewTypes: ['github.review'] }]);
  });

  it('defaults a root with no group to being its own group, as the kernel does', () => {
    expect(readRoots([{ root: 'window-1' }])).toEqual([
      { root: 'window-1', group: 'window-1', viewTypes: [] },
    ]);
  });

  it('survives a tree it cannot read', () => {
    expect(readRoots([{ root: 'r', tree: 'nope' }])[0]?.viewTypes).toEqual([]);
    expect(readRoots(null)).toEqual([]);
  });
});
