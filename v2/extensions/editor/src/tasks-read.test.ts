import { describe, expect, it } from 'vitest';
import { readTasks, taskInGroup } from './tasks-read.ts';

describe('readTasks', () => {
  it('reads the directory and the pane group, which are different things', () => {
    // `tasks.list` reports both under confusingly similar names: `root` is a
    // directory on disk, `group` is `task:<id>`.
    expect(readTasks([{ id: 't1', root: '/tasks/wheat', group: 'task:t1' }])).toEqual([
      { id: 't1', root: '/tasks/wheat', group: 'task:t1' },
    ]);
  });

  it('drops a task with no root — an invented one would open somebody s directory', () => {
    expect(readTasks([{ id: 't1' }, { id: 't2', root: '/r' }])).toEqual([
      { id: 't2', root: '/r', group: null },
    ]);
  });

  it('is empty when tasks is not installed, rather than throwing', () => {
    expect(readTasks(undefined)).toEqual([]);
    expect(readTasks({ tasks: [] })).toEqual([]);
  });
});

describe('taskInGroup', () => {
  const tasks = [
    { id: 't1', root: '/tasks/wheat', group: 'task:t1' },
    { id: 't2', root: '/tasks/other', group: 'task:t2' },
  ];

  it('finds the task whose tabs this group holds', () => {
    expect(taskInGroup(tasks, 'task:t2')?.root).toBe('/tasks/other');
  });

  it('is undefined for a loose shell, which belongs to no task', () => {
    expect(taskInGroup(tasks, 'window-1')).toBeUndefined();
    expect(taskInGroup(tasks, undefined)).toBeUndefined();
  });
});
