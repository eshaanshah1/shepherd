import { describe, expect, it } from 'vitest';
import { agentName, pickAgent, readAgents, readLive, type TaskAgent } from './agent-pick.ts';

const agents: readonly TaskAgent[] = [
  { id: 's-root', role: 'orchestrator' },
  { id: 's-v2', role: 'workstream', repo: 'v2' },
  { id: 's-sdk', role: 'workstream', repo: 'sdk' },
];

const live = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('pickAgent', () => {
  it('takes the one live agent in the PR’s own repo', () => {
    // It is in that worktree with that code loaded; nothing else comes close.
    expect(pickAgent(agents, live('s-root', 's-v2', 's-sdk'), 'sdk')).toEqual({
      kind: 'one',
      session: 's-sdk',
      because: 'in the repo',
    });
  });

  it('ASKS when two agents are in that repo, rather than inventing a tiebreak', () => {
    /*
     * There is no fact that would break this tie. Every agent of a task shares
     * one branch, so "the one that owns the PR" is recorded nowhere and cannot
     * be recovered from git either — same author, same branch, and the push came
     * out of a worktree they share. Oldest-first and idlest-first are both
     * guesses; the user knows which one they meant.
     */
    const two = [...agents, { id: 's-sdk-2', role: 'workstream', repo: 'sdk' } as const];
    const pick = pickAgent(two, live('s-root', 's-v2', 's-sdk', 's-sdk-2'), 'sdk');
    expect(pick.kind).toBe('choose');
  });

  it('offers EVERY live agent once it is asking, this repo’s first', () => {
    // Hiding an agent from a person who is choosing would be the app deciding on
    // their behalf after saying it would not. The first row is the likeliest, so
    // Enter lands on it without moving.
    const two = [...agents, { id: 's-sdk-2', role: 'workstream', repo: 'sdk' } as const];
    const pick = pickAgent(two, live('s-root', 's-v2', 's-sdk', 's-sdk-2'), 'sdk');
    if (pick.kind !== 'choose') throw new Error('expected a choice');
    expect(pick.candidates.map((agent) => agent.id)).toEqual(['s-sdk', 's-sdk-2', 's-root', 's-v2']);
  });

  it('does not ask when the second agent is in a DIFFERENT repo', () => {
    // One candidate is one candidate. A workstream in another tree is not a
    // second answer to the question.
    expect(pickAgent(agents, live('s-v2', 's-sdk'), 'sdk')).toMatchObject({ kind: 'one', session: 's-sdk' });
  });

  it('falls back to the orchestrator, which can reach every worktree', () => {
    expect(pickAgent(agents, live('s-root', 's-v2'), 'sdk')).toEqual({
      kind: 'one',
      session: 's-root',
      because: 'the orchestrator',
    });
  });

  it('NEVER picks a workstream in another repo on its own', () => {
    // Being told about a file it does not have is worse than not being told.
    expect(pickAgent(agents, live('s-v2'), 'sdk')).toEqual({ kind: 'none' });
  });

  it('answers none when every agent has exited', () => {
    // A real answer, not a failure: the caller's fallback is to spawn one, which
    // beats writing into a pty that is gone.
    expect(pickAgent(agents, live(), 'sdk')).toEqual({ kind: 'none' });
  });
});

describe('readAgents', () => {
  it('reads the shape tasks.list reports', () => {
    expect(readAgents([{ id: 's1', role: 'orchestrator' }, { id: 's2', role: 'workstream', repo: 'v2' }])).toEqual([
      { id: 's1', role: 'orchestrator' },
      { id: 's2', role: 'workstream', repo: 'v2' },
    ]);
  });

  it('drops a session with no id — the placeholder a task records before its pane has one', () => {
    expect(readAgents([{ role: 'orchestrator', pane: 'p1' }, 7, null])).toEqual([]);
  });

  it('reads an unrecognised role as a workstream, which only loses a fallback', () => {
    expect(readAgents([{ id: 's1', role: 'something-new' }])).toEqual([{ id: 's1', role: 'workstream' }]);
  });

  it('survives a shape it has never seen', () => {
    expect(readAgents('nope')).toEqual([]);
  });
});

describe('readLive', () => {
  it('is the set of ids sessions.list reported', () => {
    expect([...readLive([{ id: 'a' }, { id: 'b' }, { nope: 1 }, 3])]).toEqual(['a', 'b']);
    expect([...readLive(undefined)]).toEqual([]);
  });
});

describe('agentName', () => {
  const agent = (over: Partial<TaskAgent> = {}): TaskAgent => ({
    id: 's1',
    role: 'workstream',
    ...over,
  });

  it('is the title of the pane the agent runs in', () => {
    // A pane's name is a layout fact, and the point of it is that a person
    // typed it. The picker has always used it; the Agent block did not, so one
    // agent answered to two names depending which surface you read.
    expect(agentName(agent({ repo: 'v2' }), 'retry-loop')).toBe('retry-loop');
  });

  it('never names the vendor, which the block’s own heading already covers', () => {
    expect(agentName(agent({ kind: 'claude-code', repo: 'v2' }), 'retry-loop')).not.toContain('claude-code');
  });

  it('falls back to the repo, then to where it is rooted', () => {
    expect(agentName(agent({ repo: 'v2' }), undefined)).toBe('v2');
    expect(agentName(agent(), undefined)).toBe('task root');
  });
});
