import { describe, expect, it } from 'vitest';
import { taskRootId } from './root-id.ts';

/**
 * One derivation, everywhere. The interesting property is not the format — it is
 * that four call sites cannot disagree about it, which is what this being a
 * function rather than a template literal buys.
 */
describe('taskRootId', () => {
  it('namespaces the task id, so a task root can never collide with the home root', () => {
    expect(taskRootId('task-1754640000000-0')).toBe('task:task-1754640000000-0');
    expect(taskRootId('task-1')).not.toBe('window-1');
  });
});
