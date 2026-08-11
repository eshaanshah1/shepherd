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
  it('is the agents rollup for a running task, not the lifecycle', () => {
    // The whole point: `running` covered working AND idle, so both were blue.
    expect(displayState('running', ['working'])).toBe('working');
    expect(displayState('running', ['idle'])).toBe('idle');
  });

  it('is loudest-wins across the task’s sessions', () => {
    expect(displayState('running', ['working', 'blocked'])).toBe('blocked');
  });

  it('is idle for a running task whose sessions report nothing', () => {
    // A task whose panes have no plugin loaded is genuinely quiet, and saying so
    // is the honest answer. This is the case that will look like a regression.
    expect(displayState('running', [])).toBe('idle');
  });

  it('is idle for a draft, which has no sessions yet', () => {
    expect(displayState('draft', [])).toBe('idle');
  });

  it('is archived whatever the agents say, because archived is not an activity', () => {
    // A stale live session must not make an archived task report as live. In
    // practice they agree — an archived task's sessions are gone — and the
    // carve-out is what makes that a guarantee rather than a coincidence.
    expect(displayState('archived', ['working'])).toBe('archived');
    expect(displayState('archived', [])).toBe('archived');
  });

  it.each(['draft', 'running', 'review', 'done'] as const)(
    'yields to the rollup for %s',
    (lifecycle) => {
      expect(displayState(lifecycle, ['blocked'])).toBe('blocked');
    },
  );
});
