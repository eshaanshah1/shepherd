import { describe, expect, it } from 'vitest';
import { LIFECYCLE_STATES, displayState, isLifecycle } from './lifecycle.ts';

/**
 * D4: the store owns the lifecycle, and `needs-you` is DERIVED — never written.
 *
 * The first test is the one that matters. v1's equivalent bug class (ADR 0026)
 * was two writers for one fact; here the guard is that the written vocabulary
 * cannot express the derived value at all, so a second writer has nothing to
 * write.
 */

describe('the stored vocabulary', () => {
  it('cannot express needs-you — the whole point of D4', () => {
    expect(LIFECYCLE_STATES).not.toContain('needs-you');
    expect(isLifecycle('needs-you')).toBe(false);
  });

  it('is exactly the five lifecycle states', () => {
    expect([...LIFECYCLE_STATES]).toEqual(['draft', 'running', 'review', 'done', 'archived']);
  });

  it('rejects anything else, so a bad stored value is caught at the read', () => {
    expect(isLifecycle('RUNNING')).toBe(false);
    expect(isLifecycle('')).toBe(false);
    expect(isLifecycle('working')).toBe(false);
  });
});

describe('displayState', () => {
  it('is the lifecycle itself when no session wants anything', () => {
    expect(displayState('running', ['none', 'info'])).toBe('running');
  });

  it('is needs-you when a running task has a session at attention', () => {
    expect(displayState('running', ['none', 'attention'])).toBe('needs-you');
  });

  it('is needs-you for urgent too', () => {
    expect(displayState('running', ['urgent'])).toBe('needs-you');
  });

  it('treats info as not wanting you — it is the level that does not alert', () => {
    expect(displayState('running', ['info'])).toBe('running');
  });

  it('is running with no sessions at all', () => {
    expect(displayState('running', [])).toBe('running');
  });

  it.each(['draft', 'review', 'done', 'archived'] as const)(
    'never overrides %s, even with a session still asking for attention',
    (lifecycle) => {
      // A finished task with a straggling session is not a task that needs you;
      // it is a task that needs cleaning up. Overriding here would put archived
      // tasks in the needs-you group forever.
      expect(displayState(lifecycle, ['urgent'])).toBe(lifecycle);
    },
  );
});
