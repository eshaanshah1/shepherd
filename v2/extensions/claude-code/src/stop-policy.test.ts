import { describe, expect, it } from 'vitest';
import type { AgentState } from '@shepherd/ext-agents-core/state';
import { applyEvent, backgroundTaskCount, sessionEventAccepted, type HookInput } from './stop-policy.ts';

/**
 * Ported from `spike/seam1/Tests/StopPolicyTests.swift`, case for case.
 *
 * The thing under test is telling a real turn-end `Stop` from a `Stop` that only
 * pauses while background work is in flight — plus the ordering guard and the
 * viewing landing, which are the two behaviours most likely to be "fixed" by
 * somebody who does not know why they are there.
 */

const fold = (parts: Partial<HookInput> & { event: string; current: AgentState }) =>
  applyEvent({ ...parts });

describe('applyEvent — turn boundaries', () => {
  it('UserPromptSubmit starts a turn from any state', () => {
    for (const current of ['idle', 'shell', 'needsCheck', 'error'] as const) {
      const t = fold({ event: 'UserPromptSubmit', current });
      expect(t.state).toBe('working');
      expect(t.applied).toBe(true);
    }
  });

  it('SessionStart is idle and clears the title', () => {
    const t = fold({ event: 'SessionStart', current: 'shell' });
    expect(t.state).toBe('idle');
    expect(t.clearTitle).toBe(true);
  });

  it('SessionEnd drops back to a plain shell', () => {
    expect(fold({ event: 'SessionEnd', current: 'working' }).state).toBe('shell');
  });
});

describe('applyEvent — the compaction restart (ADR 0046)', () => {
  it('writes nothing when a SessionStart is a compaction', () => {
    const t = fold({ event: 'SessionStart', sessionSource: 'compact', current: 'working' });
    expect(t.applied).toBe(false);
    expect(t.state).toBe('working');
    expect(t.clearTitle).toBe(false);
  });

  it('keeps the reason a compacting turn already had', () => {
    const t = fold({ event: 'SessionStart', sessionSource: 'compact', current: 'blocked', reason: 'kept' });
    expect(t.state).toBe('blocked');
    expect(t.reason).toBe('kept');
  });

  it('still lands idle for every other source', () => {
    // Fail-safe in the same direction as `backgroundTaskCount`: an unknown source
    // — or a plugin too old to send one — gets the plain behaviour, never a state
    // with no way out.
    for (const sessionSource of ['startup', 'resume', 'clear', '']) {
      const t = fold({ event: 'SessionStart', sessionSource, current: 'shell' });
      expect(t.state).toBe('idle');
      expect(t.clearTitle).toBe(true);
      expect(t.applied).toBe(true);
    }
  });

  it('carries a turn through the compactions a real session fired', () => {
    // Recorded from an interactive `claude` run at CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // =60000, which auto-compacted twice mid-turn. Before the guard this reached
    // the final `Stop` at `idle`, so the guard discarded it: no `needsCheck` and
    // no notification for a turn that really had ended.
    const recorded = [
      'SessionStart:startup',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PreCompact',
      'SubagentStop',
      'SessionStart:compact',
      'PostCompact',
      'PreToolUse',
      'PostToolUse',
      'PreCompact',
      'SubagentStop',
      'SessionStart:compact',
      'PostCompact',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ];

    let state: AgentState = 'shell';
    let finished = false;
    for (const entry of recorded) {
      const [event, sessionSource = ''] = entry.split(':');
      const t = fold({ event: event as string, sessionSource, current: state });
      if (t.applied) state = t.state;
      finished = t.turnFinished;
    }

    expect(state).toBe('needsCheck');
    expect(finished).toBe(true);
  });
});

describe('applyEvent — Stop, decided by the background-task count', () => {
  it('finishes the turn with no background tasks', () => {
    const t = fold({ event: 'Stop', current: 'working', backgroundTasks: 0 });
    expect(t.state).toBe('needsCheck');
    expect(t.heldForBackground).toBe(false);
    expect(t.applied).toBe(true);
  });

  it('stays working with one background task — the turn only paused', () => {
    const t = fold({ event: 'Stop', current: 'working', backgroundTasks: 1 });
    expect(t.state).toBe('working');
    expect(t.heldForBackground).toBe(true);
    expect(t.applied).toBe(true);
  });

  it('stays working with several background tasks', () => {
    const t = fold({ event: 'Stop', current: 'working', backgroundTasks: 3 });
    expect(t.state).toBe('working');
    expect(t.heldForBackground).toBe(true);
  });

  it('finishes when no count was supplied at all', () => {
    // Fail-safe: an unparseable payload reverts to plain finish-on-Stop rather
    // than sticking at `working` with no way out.
    const t = fold({ event: 'Stop', current: 'working' });
    expect(t.state).toBe('needsCheck');
    expect(t.heldForBackground).toBe(false);
  });

  it('ignores a stray Stop when not mid-turn, even with a background task', () => {
    const t = fold({ event: 'Stop', current: 'needsCheck', backgroundTasks: 1 });
    expect(t.applied).toBe(false);
    expect(t.state).toBe('needsCheck');
  });
});

describe('applyEvent — the viewing landing (ADR 0020)', () => {
  it('a Stop while viewing goes straight to idle', () => {
    const t = fold({ event: 'Stop', current: 'working', backgroundTasks: 0, viewing: true });
    expect(t.state).toBe('idle');
    expect(t.applied).toBe(true);
    expect(t.turnFinished).toBe(true);
  });

  it('sets turnFinished on BOTH landings', () => {
    // Side effects keyed off "a turn ended" must read this, never
    // `state === 'needsCheck'`, which misses the viewing landing entirely.
    expect(fold({ event: 'Stop', current: 'working', backgroundTasks: 0 }).turnFinished).toBe(true);
    expect(
      fold({ event: 'Stop', current: 'working', backgroundTasks: 0, viewing: true }).turnFinished,
    ).toBe(true);
  });

  it('a held background Stop is not a turn end, even while viewing', () => {
    const t = fold({ event: 'Stop', current: 'working', backgroundTasks: 2, viewing: true });
    expect(t.state).toBe('working');
    expect(t.turnFinished).toBe(false);
    expect(t.heldForBackground).toBe(true);
  });

  it('an ignored Stop is not a turn end', () => {
    expect(fold({ event: 'Stop', current: 'idle', backgroundTasks: 0 }).turnFinished).toBe(false);
  });

  it('viewing does not soften blocked or error', () => {
    // These want you whether or not you are looking — an unanswered question does
    // not answer itself because the pane is on screen.
    expect(
      fold({ event: 'PreToolUse', detail: 'AskUserQuestion', current: 'working', viewing: true }).state,
    ).toBe('blocked');
    expect(
      fold({ event: 'StopFailure', detail: 'overloaded_error', current: 'working', viewing: true }).state,
    ).toBe('error');
  });
});

describe('applyEvent — the ordering guard (ADR 0004)', () => {
  it('ignores every mid-turn event when the turn has already ended', () => {
    for (const event of [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
      'SubagentStop',
      'ElicitationResult',
      'Elicitation',
      'PermissionRequest',
      'StopFailure',
    ]) {
      expect(fold({ event, current: 'needsCheck' }).applied).toBe(false);
    }
  });

  it('applies mid-turn events while blocked, not only while working', () => {
    // `blocked` IS mid-turn: an approved permission is followed by more tool use,
    // and a guard that only accepted `working` would strand the session.
    expect(fold({ event: 'PostToolUse', current: 'blocked' }).state).toBe('working');
  });

  it('ignores an unknown event rather than guessing', () => {
    const t = fold({ event: 'SomeFutureHook', current: 'working' });
    expect(t.applied).toBe(false);
    expect(t.state).toBe('working');
  });

  it('preserves the existing reason on an ignored event', () => {
    const t = fold({ event: 'PostToolUse', current: 'needsCheck', reason: 'kept' });
    expect(t.applied).toBe(false);
    expect(t.reason).toBe('kept');
  });
});

describe('applyEvent — blocking and its reasons', () => {
  it('AskUserQuestion blocks with "answer needed"', () => {
    const t = fold({ event: 'PreToolUse', detail: 'AskUserQuestion', current: 'working' });
    expect(t.state).toBe('blocked');
    expect(t.reason).toBe('answer needed');
  });

  it('ExitPlanMode blocks for plan approval, from either event', () => {
    expect(fold({ event: 'PreToolUse', detail: 'ExitPlanMode', current: 'working' }).reason).toBe(
      'plan approval',
    );
    expect(
      fold({ event: 'PermissionRequest', detail: 'ExitPlanMode', current: 'working' }).reason,
    ).toBe('plan approval');
  });

  it('names the tool a permission request is about', () => {
    expect(fold({ event: 'PermissionRequest', detail: 'Bash', current: 'working' }).reason).toBe(
      'approve Bash',
    );
    expect(fold({ event: 'PermissionRequest', current: 'working' }).reason).toBe('approval needed');
  });

  it('falls back to a generic API error when StopFailure carries no type', () => {
    expect(fold({ event: 'StopFailure', current: 'working' }).reason).toBe('API error');
  });

  it('Elicitation blocks on input', () => {
    expect(fold({ event: 'Elicitation', current: 'working' }).reason).toBe('input requested');
  });
});

describe('applyEvent — subagents count nothing', () => {
  it('a launched Agent tool just stays working', () => {
    const t = fold({ event: 'PreToolUse', detail: 'Agent', current: 'working' });
    expect(t.state).toBe('working');
    expect(t.applied).toBe(true);
  });

  it('SubagentStop stays working mid-turn and is ignored otherwise', () => {
    expect(fold({ event: 'SubagentStop', detail: 'Explore', current: 'working' }).state).toBe('working');
    expect(fold({ event: 'SubagentStop', detail: 'Explore', current: 'needsCheck' }).applied).toBe(false);
  });

  it('SubagentStart names the agent when it has one', () => {
    expect(fold({ event: 'SubagentStart', detail: 'Explore', current: 'working' }).reason).toBe(
      'subagent: Explore',
    );
    expect(fold({ event: 'SubagentStart', current: 'working' }).reason).toBe('subagent');
  });
});

describe('applyEvent — the bug this whole file exists for', () => {
  /** Folds a sequence exactly as a caller must: an ignored event writes nothing. */
  const run = (steps: readonly (Partial<HookInput> & { event: string })[], from: AgentState): AgentState => {
    let state = from;
    for (const step of steps) {
      const t = applyEvent({ ...step, current: state });
      if (t.applied) state = t.state;
    }
    return state;
  };

  it('a turn paused on a background agent does not falsely finish, then finishes for real', () => {
    let state: AgentState = 'idle';
    const step = (event: string, parts: Partial<HookInput> = {}): AgentState => {
      const t = applyEvent({ ...parts, event, current: state });
      if (t.applied) state = t.state;
      return state;
    };

    expect(step('UserPromptSubmit')).toBe('working');
    expect(step('PreToolUse', { detail: 'Agent' })).toBe('working');
    // The main loop yields to wait — a background task is in flight, so this
    // `Stop` must NOT read as done.
    expect(step('Stop', { backgroundTasks: 1 })).toBe('working');
    expect(step('SubagentStop', { detail: 'Agent' })).toBe('working');
    expect(step('PreToolUse', { detail: 'Read' })).toBe('working');
    // The real end of the turn, with nothing in flight.
    expect(step('Stop', { backgroundTasks: 0 })).toBe('needsCheck');
  });

  it('a foreground subagent still finishes normally', () => {
    const state = run(
      [
        { event: 'PreToolUse', detail: 'Agent' },
        { event: 'SubagentStop', detail: 'Agent' },
        { event: 'Stop', backgroundTasks: 0 },
      ],
      'working',
    );
    expect(state).toBe('needsCheck');
  });
});

describe('backgroundTaskCount — the ADR 0015 allow-list, moved out of bash', () => {
  const stop = (types: readonly string[]): unknown => ({
    background_tasks: types.map((type) => ({ type })),
  });

  it('counts a backgrounded subagent, workflow and shell', () => {
    expect(backgroundTaskCount(stop(['subagent', 'workflow', 'shell']))).toBe(3);
  });

  it('does NOT count a monitor', () => {
    // The whole point of the allow-list: a passive monitor must not hold the
    // "turn done" notification, or a session with one never reports finishing.
    expect(backgroundTaskCount(stop(['monitor']))).toBe(0);
    expect(backgroundTaskCount(stop(['subagent', 'monitor']))).toBe(1);
  });

  it('fails safe to zero on anything it cannot read', () => {
    // Deliberately one-directional: guessing high strands a session at `working`
    // forever, guessing low costs one premature "done" the next event corrects.
    for (const junk of [undefined, null, '', 'nope', 42, {}, { background_tasks: null }, { background_tasks: 'two' }]) {
      expect(backgroundTaskCount(junk)).toBe(0);
    }
  });

  it('ignores malformed entries without discarding the whole array', () => {
    expect(backgroundTaskCount({ background_tasks: [null, { type: 'subagent' }, { nope: 1 }, 7] })).toBe(1);
  });
});

describe('sessionEventAccepted — nested `claude -p` isolation', () => {
  it('an unlocked session accepts anything', () => {
    expect(sessionEventAccepted('abc', undefined)).toBe(true);
    expect(sessionEventAccepted('abc', '')).toBe(true);
  });

  it('a missing session id fails safe and is accepted', () => {
    // A plugin predating the field must behave exactly as before — never stricter.
    expect(sessionEventAccepted('', 'owner-1')).toBe(true);
  });

  it('accepts the owning session and drops a foreign nested one', () => {
    expect(sessionEventAccepted('owner-1', 'owner-1')).toBe(true);
    // A nested `claude -p` reports the parent's Shepherd session with its own id.
    expect(sessionEventAccepted('nested-2', 'owner-1')).toBe(false);
  });
});
