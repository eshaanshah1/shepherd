import { describe, expect, it } from 'vitest';
import { ROLLUP_PRIORITY, isTaskAgentState, rollUp, tintFor, type TaskAgentState } from './agent-rollup.ts';

/**
 * Loudest wins — v1's `Tab.attentionState()` priority, for its reason: anything
 * wanting you outranks anything merely busy. A blocked agent waits indefinitely
 * and burns nothing, so it is the fact worth surfacing even while four other
 * sessions make progress.
 */

describe('rollUp', () => {
  it('is idle for a task with no sessions at all', () => {
    expect(rollUp([])).toBe('idle');
  });

  it('folds shell to idle — a bare prompt is not an agent', () => {
    expect(rollUp(['shell', 'shell'])).toBe('idle');
  });

  it('folds an unrecognised word to idle rather than throwing', () => {
    // These values crossed a port from an extension this code has never seen.
    // A cast is not a check, and an unknown word is data.
    expect(rollUp(['sleeping', ''])).toBe('idle');
  });

  it('is the state itself when there is only one', () => {
    expect(rollUp(['working'])).toBe('working');
    expect(rollUp(['blocked'])).toBe('blocked');
  });

  it('lets blocked beat working, because working is not waiting on you', () => {
    expect(rollUp(['working', 'blocked', 'idle'])).toBe('blocked');
  });

  it('lets blocked beat error — you can act on one of them', () => {
    expect(rollUp(['error', 'blocked'])).toBe('blocked');
  });

  it('lets error beat a finished turn', () => {
    expect(rollUp(['needsCheck', 'error'])).toBe('error');
  });

  it('lets a finished turn beat working', () => {
    expect(rollUp(['working', 'needsCheck'])).toBe('needsCheck');
  });

  it('lets working beat idle', () => {
    expect(rollUp(['idle', 'working', 'idle'])).toBe('working');
  });

  it('is order-independent — a rollup is about the set, not the arrival order', () => {
    expect(rollUp(['idle', 'blocked', 'working'])).toBe(rollUp(['working', 'blocked', 'idle']));
  });

  it.each(ROLLUP_PRIORITY)('round-trips %s through itself', (state) => {
    expect(rollUp([state])).toBe(state);
  });
});

describe('isTaskAgentState', () => {
  it('accepts every rollup state and nothing else', () => {
    for (const state of ROLLUP_PRIORITY) expect(isTaskAgentState(state)).toBe(true);
    // `shell` is a real AgentState that is deliberately NOT a rollup state.
    expect(isTaskAgentState('shell')).toBe(false);
    expect(isTaskAgentState('archived')).toBe(false);
    expect(isTaskAgentState('')).toBe(false);
  });
});

describe('tintFor', () => {
  /**
   * The words the renderer already resolves. `needsCheck` emits `needs-check`,
   * which the shell paints `success` — green — because a finished turn is not
   * the same signal as a blocked one. The palette names both jobs itself
   * (`pasture` = "done / success", `hay` = "blocked / attention") and v1 shipped
   * it that way for months.
   */
  it('maps every rollup state to a word view-dock already knows', () => {
    const expected: Record<TaskAgentState, string> = {
      blocked: 'blocked',
      error: 'error',
      needsCheck: 'needs-check',
      working: 'working',
      idle: 'idle',
    };
    for (const state of ROLLUP_PRIORITY) expect(tintFor(state)).toBe(expected[state]);
  });

  it('keeps a finished turn and a blocked one on DIFFERENT words', () => {
    // The regression that matters: collapsing both onto `needs-you` made them
    // one amber, distinguishable only by a tooltip.
    expect(tintFor('needsCheck')).not.toBe(tintFor('blocked'));
  });
});
