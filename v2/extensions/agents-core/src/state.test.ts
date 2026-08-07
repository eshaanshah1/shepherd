import { describe, expect, it } from 'vitest';
import { AGENT_STATES, isAgent, isBusy, rollUp, wantsAttention, type AgentState } from './state.ts';

describe('AgentState', () => {
  it('is a closed set with no duplicates', () => {
    expect(new Set(AGENT_STATES).size).toBe(AGENT_STATES.length);
  });

  it('treats only a plain shell as not-an-agent', () => {
    const notAgents = AGENT_STATES.filter((state) => !isAgent(state));
    expect(notAgents).toEqual(['shell']);
  });

  it('pulls the user in for blocked, needsCheck and error, and nothing else', () => {
    expect(AGENT_STATES.filter(wantsAttention)).toEqual(['blocked', 'needsCheck', 'error']);
  });

  it('counts working and everything wanting attention as busy', () => {
    // The keep-awake predicate: an acknowledged idle agent and a plain shell are
    // not reasons to hold the machine awake.
    expect(AGENT_STATES.filter(isBusy)).toEqual(['working', 'blocked', 'needsCheck', 'error']);
  });
});

describe('rollUp', () => {
  it('is shell when there is nothing to roll up', () => {
    expect(rollUp([])).toBe('shell');
    expect(rollUp(['shell', 'shell'])).toBe('shell');
  });

  it('ranks a question you have not answered above a failure you cannot act on', () => {
    expect(rollUp(['error', 'blocked'])).toBe('blocked');
    expect(rollUp(['working', 'error'])).toBe('error');
    expect(rollUp(['idle', 'needsCheck'])).toBe('needsCheck');
    expect(rollUp(['idle', 'working'])).toBe('working');
  });

  it('is order-independent', () => {
    const states: readonly AgentState[] = ['idle', 'working', 'needsCheck', 'blocked', 'error'];
    expect(rollUp(states)).toBe('blocked');
    expect(rollUp([...states].reverse())).toBe('blocked');
  });

  it('reports a single state as itself', () => {
    for (const state of AGENT_STATES) expect(rollUp([state])).toBe(state);
  });
});
