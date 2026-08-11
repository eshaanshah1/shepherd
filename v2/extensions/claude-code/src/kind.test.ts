import { describe, expect, it } from 'vitest';
import type { AgentEventInput, AgentState } from '@shepherd/ext-agents-core';
import {
  CLAUDE_HOOK_TOPIC,
  claudeKind,
  parseQuick,
  QUICK_MODEL,
  QUICK_MODELS,
  quickArgv,
  reduce,
  type ClaudeSlot,
} from './kind.ts';

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

describe('resumeCommandOf', () => {
  /**
   * The command moved here from `tasks` in R1 (ADR 0036 §3). These are that
   * file's tests, following the behaviour they describe — a resume line is a
   * vendor fact, and this package is the only one allowed to know it.
   */
  it('names the session and carries no prompt', () => {
    // The transcript IS the context. Typing the original brief at a resumed
    // session would restate what it already knows and read as a second
    // instruction — which is exactly what restoring a task used to do.
    expect(claudeKind().resumeCommandOf?.('abc-123')).toBe("claude --resume 'abc-123'");
  });

  it('quotes the target, which came from somewhere else entirely', () => {
    // It is a token this code did not mint, arriving from a vendor's hook
    // payload — so it is quoted rather than trusted.
    expect(claudeKind().resumeCommandOf?.("it's")).toBe("claude --resume 'it'\\''s'");
  });

  it('is one line, because a typed newline is an Enter press (ADR 0034)', () => {
    expect(claudeKind().resumeCommandOf?.('x')).not.toContain('\n');
  });

  it('declares the capability it implements', () => {
    expect(claudeKind().capabilities?.resume).toBe(true);
  });
});

/**
 * The vendor's half of the quick tier: the flags, and the junk its answers arrive
 * wrapped in.
 *
 * Every flag was measured on 2026-08-10 (the spec carries the table) and each is
 * load-bearing. This is the record, so that a later "why so many flags?" has an
 * answer that is not a guess.
 */
describe('the quick tier default', () => {
  it('is Haiku, pinned rather than an alias', () => {
    /**
     * What an unconfigured install spends on the app's own short questions.
     *
     * Both `agents-core` settings default to `null`, which drops through
     * `resolveQuick` to whatever the chosen kind advertises — this constant. Pinned
     * to a dated id rather than the `haiku` alias, deliberately: a DEFAULT should
     * not change under anybody without a release saying so. The aliases are offered
     * as choices (`QUICK_MODELS`) precisely so a user can opt into the moving one.
     */
    expect(QUICK_MODEL).toBe('claude-haiku-4-5');
    expect(QUICK_MODELS[0]).toBe(QUICK_MODEL);
  });

  it('offers the cheaper tiers first, so the list reads as a ramp', () => {
    expect([...QUICK_MODELS]).toEqual(['claude-haiku-4-5', 'haiku', 'sonnet', 'opus']);
  });
});

describe('quickArgv', () => {
  const argv = quickArgv({ prompt: 'name this task', model: QUICK_MODEL });

  it('runs the vendor binary in print mode with the prompt as an argument', () => {
    // An argument rather than stdin: `runExec` reaches `execFile` with an array,
    // so there is no shell and therefore nothing to quote wrongly.
    expect(argv[0]).toBe('claude');
    expect(argv).toContain('-p');
    expect(argv).toContain('name this task');
    expect(argv).toContain('--model');
    expect(argv).toContain(QUICK_MODEL);
  });

  it('disables every customization, because the full CLI is slow and chatty', () => {
    // `--safe-mode` turns off CLAUDE.md discovery (this repo's is ~46k tokens),
    // skills, plugins, hooks — including Shepherd's own `report.sh`, which would
    // otherwise report this nested call's lifecycle as some pane's — MCP servers,
    // custom agents and workflows. Worth ~2s and two whole classes of bug, while
    // auth, model selection and policy settings keep working.
    expect(argv).toContain('--safe-mode');
  });

  it('disables every tool, because the job is to return six words', () => {
    // `--tools ""` is the documented form. NOT a `--settings` deny-list, which
    // would enumerate vendor tool names and rot as that set changes; and
    // `--max-turns` does not exist in the installed CLI.
    const at = argv.indexOf('--tools');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('');
  });

  it('never passes --bare, which cannot authenticate under a managed login pin', () => {
    // `--bare` never reads OAuth or the keychain, and a machine whose managed
    // settings pin `forceLoginMethod` rejects exactly the credential it insists
    // on. It exits 1 in under a second, and no API key changes that.
    expect(argv).not.toContain('--bare');
  });

  it('takes the model it is given rather than reaching for its own', () => {
    // The override exists so a user can choose; a kind that ignored the argument
    // would make `agents.quickModel --model` silently do nothing.
    expect(quickArgv({ prompt: 'p', model: 'something-else' })).toContain('something-else');
  });
});

describe('parseQuick', () => {
  it('takes a plain answer', () => {
    expect(parseQuick('add-a-cheap-model-seam\n')).toBe('add-a-cheap-model-seam');
  });

  it('unwraps backticks, which three of seven measured answers arrived in', () => {
    expect(parseQuick('`cheap-model-task-naming`')).toBe('cheap-model-task-naming');
  });

  it('takes the answer, not a preamble line above it', () => {
    // A model asked for six words sometimes writes a sentence about the six
    // words first. The answer is last.
    expect(parseQuick('Here is a name:\nadd-cheap-model-seam\n')).toBe('add-cheap-model-seam');
  });

  it('has no answer for empty output', () => {
    expect(parseQuick('   \n\n')).toBeUndefined();
    expect(parseQuick('``')).toBeUndefined();
  });
});

describe('claudeKind', () => {
  it('declares a headless half, so it can serve the quick tier', () => {
    expect(claudeKind().headless?.quickModel).toBe(QUICK_MODEL);
  });
});
