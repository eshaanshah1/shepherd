import { describe, expect, it } from 'vitest';
import type { AgentEventInput, AgentState } from '@shepherd/ext-agents-core';
import { CLAUDE_HOOK_TOPIC, claudeKind, reduce, type ClaudeSlot } from './kind.ts';

/**
 * The vendor half: reading Claude's payload, and the ownership lock that keeps a
 * nested `claude -p` from driving its parent's pane.
 */

function input(
  event: string,
  hook: unknown,
  extra: Partial<AgentEventInput> = {},
): AgentEventInput {
  return {
    topic: CLAUDE_HOOK_TOPIC,
    payload: { event, hook },
    current: extra.current ?? 'working',
    viewing: extra.viewing ?? false,
    slot: extra.slot ?? {},
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  };
}

/** The transition a decision carries, or a failure naming why there wasn't one. */
function transition(decision: ReturnType<typeof reduce>): { state: AgentState; reason?: string } {
  if (decision.kind !== 'transition') throw new Error(`expected a transition, got ignore: ${decision.why}`);
  return decision.to;
}

describe('the envelope', () => {
  it('ignores anything without an event name rather than guessing', () => {
    for (const payload of [{}, { event: '' }, { event: 7 }, null, 'nope']) {
      const decision = reduce({ ...input('x', null), payload });
      expect(decision.kind).toBe('ignore');
    }
  });

  it('reads the state from the event name even when the payload is null', () => {
    // `report.sh` sends `hook: null` when Claude's stdin was empty or unreadable.
    // State is decided by the EVENT, so the turn still tracks and only the
    // cosmetic reason is lost — the failure mode has to be that way round.
    expect(transition(reduce(input('UserPromptSubmit', null))).state).toBe('working');
    expect(transition(reduce(input('Stop', null, { current: 'working' }))).state).toBe('needsCheck');
  });
});

describe('reading the payload', () => {
  it('names the tool a PreToolUse is about', () => {
    const t = transition(reduce(input('PreToolUse', { tool_name: 'AskUserQuestion' })));
    expect(t.state).toBe('blocked');
    expect(t.reason).toBe('answer needed');
  });

  it('names the tool a permission request is about', () => {
    expect(transition(reduce(input('PermissionRequest', { tool_name: 'Bash' }))).reason).toBe('approve Bash');
  });

  it('reads the error type off a StopFailure', () => {
    expect(transition(reduce(input('StopFailure', { error_type: 'overloaded_error' }))).reason).toBe(
      'overloaded_error',
    );
  });

  it('reads the agent type off a subagent event', () => {
    expect(transition(reduce(input('SubagentStart', { agent_type: 'Explore' }))).reason).toBe(
      'subagent: Explore',
    );
  });

  it('survives a payload whose fields are the wrong type', () => {
    // The payload is whatever Claude sent; a field of the wrong type must degrade
    // to "no name", never throw inside a reducer running on the hook path.
    const t = transition(reduce(input('PreToolUse', { tool_name: { nested: true } })));
    expect(t.state).toBe('working');
  });

  it('reduces background_tasks so a paused turn is not read as finished', () => {
    // ADR 0015, now in TypeScript where it is testable — in v1 this was a `jq`
    // filter in a shell script and nothing exercised it.
    const paused = transition(
      reduce(input('Stop', { background_tasks: [{ type: 'subagent' }] }, { current: 'working' })),
    );
    expect(paused.state).toBe('working');

    const monitorOnly = transition(
      reduce(input('Stop', { background_tasks: [{ type: 'monitor' }] }, { current: 'working' })),
    );
    // A passive monitor does not hold the turn.
    expect(monitorOnly.state).toBe('needsCheck');
  });

  it('does not read background_tasks off an event that cannot carry it', () => {
    const t = transition(
      reduce(input('PostToolUse', { background_tasks: [{ type: 'subagent' }] }, { current: 'working' })),
    );
    expect(t.state).toBe('working');
  });
});

describe('the ownership lock', () => {
  it('claims the lock and records the resume target on SessionStart', () => {
    const slot: ClaudeSlot = {};
    reduce(input('SessionStart', { session_id: 'claude-abc' }, { slot, current: 'shell' }));
    expect(slot.ownerClaudeSessionID).toBe('claude-abc');
    expect(slot.resumeSessionID).toBe('claude-abc');
  });

  it('drops a nested `claude -p`’s events without touching the pane', () => {
    // THE bug. A nested claude inherits SHEPHERD_SESSION_ID, so its hooks arrive
    // tagged with the parent's session while carrying their own Claude id.
    // Unchecked, its Stop flips the parent to needs-check mid-turn.
    const slot: ClaudeSlot = {};
    reduce(input('SessionStart', { session_id: 'owner-1' }, { slot, current: 'shell' }));

    const decision = reduce(input('Stop', { session_id: 'nested-2' }, { slot, current: 'working' }));

    expect(decision.kind).toBe('ignore');
    if (decision.kind === 'ignore') expect(decision.why).toContain('nested-2');
    // And it did not steal the resume target on the way past.
    expect(slot.resumeSessionID).toBe('owner-1');
  });

  it('accepts the owning session’s events', () => {
    const slot: ClaudeSlot = {};
    reduce(input('SessionStart', { session_id: 'owner-1' }, { slot, current: 'shell' }));
    expect(transition(reduce(input('Stop', { session_id: 'owner-1' }, { slot, current: 'working' }))).state).toBe(
      'needsCheck',
    );
  });

  it('fails safe when the payload carries no session id at all', () => {
    // Never stricter than having no lock: dropping the REAL agent's events would
    // freeze its indicator, which is worse than the nesting this guards against.
    const slot: ClaudeSlot = { ownerClaudeSessionID: 'owner-1' };
    expect(reduce(input('Stop', {}, { slot, current: 'working' })).kind).toBe('transition');
  });

  it('releases the lock on SessionEnd but KEEPS the resume target', () => {
    // Two facts, not one field (review §Ugly-4). An ended session is precisely
    // the one worth resuming, so clearing both would delete resume; keeping both
    // would refuse the next agent that starts in this pane.
    const slot: ClaudeSlot = {};
    reduce(input('SessionStart', { session_id: 'owner-1' }, { slot, current: 'shell' }));
    reduce(input('SessionEnd', { session_id: 'owner-1' }, { slot, current: 'idle' }));

    expect(slot.ownerClaudeSessionID).toBeUndefined();
    expect(slot.resumeSessionID).toBe('owner-1');

    // And the pane is claimable again by a genuinely new agent.
    reduce(input('SessionStart', { session_id: 'owner-2' }, { slot, current: 'shell' }));
    expect(slot.ownerClaudeSessionID).toBe('owner-2');
    expect(slot.resumeSessionID).toBe('owner-2');
  });
});

describe('the kind itself', () => {
  it('answers to the claude.hook topic and declares its capabilities', () => {
    const kind = claudeKind();
    expect(kind.topics).toEqual([CLAUDE_HOOK_TOPIC]);
    // Declared ahead of the seam that consumes them (§7c), so asking for
    // something a vendor lacks can be a typed error rather than a hang.
    expect(kind.capabilities?.resume).toBe(true);
  });

  it('threads the mirrored viewing value through to the landing', () => {
    // ADR 0020: a turn ending under the user's eyes lands `idle`. The value is
    // handed in — nothing in this process could compute it.
    expect(transition(reduce(input('Stop', {}, { current: 'working', viewing: true }))).state).toBe('idle');
    expect(transition(reduce(input('Stop', {}, { current: 'working', viewing: false }))).state).toBe('needsCheck');
  });
});
