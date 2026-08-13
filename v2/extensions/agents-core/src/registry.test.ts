import { describe, expect, it } from 'vitest';
import { AgentRegistry, SWEEP_QUIET_TICKS, type AgentChange } from './registry.ts';
import type { AgentDecision, AgentKind, AgentEventInput } from './kind.ts';
import type { AgentState } from './state.ts';

/**
 * The registry is the one writer, and these tests are mostly about the two
 * things that must NOT be able to write through it: a vendor reducer that said
 * "not applied", and a sweep reading that is merely uncertain.
 */

const transition = (state: AgentState, extra: Partial<AgentChange> = {}): AgentDecision => ({
  kind: 'transition',
  to: {
    state,
    clearTitle: false,
    applied: true,
    heldForBackground: false,
    turnFinished: extra.turnFinished ?? false,
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  },
});

/** A kind that answers however the test tells it to, and records what it saw. */
function fakeKind(
  id: string,
  answer: (input: AgentEventInput) => AgentDecision,
  topics: readonly string[] = ['test.hook'],
): AgentKind & { seen: AgentEventInput[] } {
  const seen: AgentEventInput[] = [];
  return {
    id,
    topics,
    seen,
    reduce(input) {
      seen.push(input);
      return answer(input);
    },
  };
}

const S = 'session-1';

describe('adoption', () => {
  it('adopts a session when a kind first answers with a transition', () => {
    const kind = fakeKind('claude-code', () => transition('idle'));
    const registry = new AgentRegistry();
    expect(registry.get(S)).toBeUndefined();

    const { change } = registry.handle(S, 'test.hook', {}, [kind]);

    expect(change?.to).toBe('idle');
    expect(registry.get(S)?.kindId).toBe('claude-code');
    // A plain shell becomes an agent because its agent said so through a hook —
    // never because anything matched a process name, which on a real machine
    // matches nothing (claude's binary is named after its version).
    expect(kind.seen[0]?.current).toBe('shell');
  });

  it('does not adopt on an ignore, and says why', () => {
    const kind = fakeKind('claude-code', () => ({ kind: 'ignore', why: 'foreign session' }));
    const registry = new AgentRegistry();

    const result = registry.handle(S, 'test.hook', {}, [kind]);

    expect(result.change).toBeUndefined();
    expect(registry.get(S)).toBeUndefined();
    // The reason has to survive: an ordering guard that is working and a wire
    // that is dead look identical without it.
    expect(result.ignored).toContain('foreign session');
  });

  it('offers an unadopted session only to kinds handling the topic', () => {
    const wrong = fakeKind('other', () => transition('idle'), ['other.hook']);
    const registry = new AgentRegistry();

    const result = registry.handle(S, 'test.hook', {}, [wrong]);

    expect(result.change).toBeUndefined();
    expect(wrong.seen).toHaveLength(0);
    expect(result.ignored).toContain('no kind handles test.hook');
  });

  it('consults only the owning kind once a session is adopted', () => {
    const owner = fakeKind('claude-code', () => transition('working'));
    const other = fakeKind('codex', () => transition('error'));
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [owner]);
    other.seen.length = 0;

    registry.handle(S, 'test.hook', {}, [owner, other]);

    // A second vendor's events on somebody else's session are ignored rather
    // than fought over.
    expect(other.seen).toHaveLength(0);
    expect(registry.get(S)?.kindId).toBe('claude-code');
  });
});

describe('the ordering guard is not a state write', () => {
  it('a reducer answering applied:false changes nothing', () => {
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition('working'))]);

    const guarded = fakeKind('k', () => ({
      kind: 'transition',
      to: {
        state: 'needsCheck',
        clearTitle: false,
        applied: false,
        heldForBackground: false,
        turnFinished: false,
      },
    }));
    const result = registry.handle(S, 'test.hook', {}, [guarded]);

    expect(result.change).toBeUndefined();
    expect(registry.get(S)?.state).toBe('working');
    expect(result.ignored).toContain('mid-turn guard');
  });
});

describe('the viewing mirror', () => {
  it('threads the mirrored value into the reducer rather than being asked for it', () => {
    const kind = fakeKind('k', () => transition('working'));
    const registry = new AgentRegistry();
    registry.setViewing(S, true);

    registry.handle(S, 'test.hook', {}, [kind]);

    expect(kind.seen[0]?.viewing).toBe(true);
  });

  it('clears a finished turn when the user looks at it, and only that', () => {
    const registry = new AgentRegistry();
    const land = (state: AgentState): void => {
      registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition(state))]);
    };

    land('needsCheck');
    expect(registry.observeViewed(S)?.to).toBe('idle');

    // Looking at a permission prompt is not answering it, and a failed turn is
    // not un-failed by being seen. v1's table, exactly.
    for (const state of ['blocked', 'error', 'working'] as const) {
      land(state);
      expect(registry.observeViewed(S), state).toBeUndefined();
      expect(registry.get(S)?.state).toBe(state);
    }
  });
});

describe('the reconciliation sweep', () => {
  const busy = (): AgentRegistry => {
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition('working'))]);
    return registry;
  };

  it('demotes only after consecutive quiet readings', () => {
    const registry = busy();
    for (let i = 1; i < SWEEP_QUIET_TICKS; i += 1) {
      expect(registry.observe(S, false), `reading ${i}`).toBeUndefined();
    }
    const change = registry.observe(S, false);
    expect(change?.to).toBe('needsCheck');
  });

  it('lands needsCheck, never idle, and reports a turn end', () => {
    // A dead agent is exactly something the user has not seen. Landing it `idle`
    // would silently discard the one alert this sweep exists to raise.
    const registry = busy();
    let change: AgentChange | undefined;
    for (let i = 0; i < SWEEP_QUIET_TICKS; i += 1) change = registry.observe(S, false);
    expect(change?.to).toBe('needsCheck');
    expect(change?.turnFinished).toBe(true);
    expect(change?.reason).toBeTruthy();
  });

  it('treats an unreadable tty as no evidence at all', () => {
    // THE case. `undefined` means the tty could not be read — node-pty answers it
    // for a transient failure on a perfectly live agent — so it must neither
    // count toward a demotion nor reset a run that is genuinely quiet.
    const registry = busy();
    for (let i = 0; i < 20; i += 1) {
      expect(registry.observe(S, undefined), `unreadable reading ${i}`).toBeUndefined();
    }
    expect(registry.get(S)?.state).toBe('working');

    // And it did not reset the counter either: two quiet readings still demote.
    for (let i = 0; i < SWEEP_QUIET_TICKS - 1; i += 1) registry.observe(S, false);
    expect(registry.observe(S, undefined)).toBeUndefined();
    expect(registry.observe(S, false)?.to).toBe('needsCheck');
  });

  it('a live reading resets the run', () => {
    const registry = busy();
    for (let i = 0; i < SWEEP_QUIET_TICKS - 1; i += 1) registry.observe(S, false);
    expect(registry.observe(S, true)).toBeUndefined();
    for (let i = 0; i < SWEEP_QUIET_TICKS - 1; i += 1) {
      expect(registry.observe(S, false)).toBeUndefined();
    }
  });

  it('never demotes a session that is not claiming to be busy', () => {
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition('idle'))]);
    for (let i = 0; i < 10; i += 1) expect(registry.observe(S, false)).toBeUndefined();
    expect(registry.get(S)?.state).toBe('idle');
  });

  it('says nothing about a session it does not track', () => {
    expect(new AgentRegistry().observe('unknown', false)).toBeUndefined();
  });

  it('a real transition ends a quiet run', () => {
    const registry = busy();
    for (let i = 0; i < SWEEP_QUIET_TICKS - 1; i += 1) registry.observe(S, false);
    registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition('working'))]);
    // The session is demonstrably alive, so the partial run must not carry over.
    expect(registry.observe(S, false)).toBeUndefined();
  });
});

describe('lifecycle', () => {
  it('drops the record, the slot and the viewing entry together', () => {
    // Snapshot at ENTRY, because the kind writes to the slot before returning —
    // inspecting it afterwards would only prove the kind ran.
    const atEntry: string[][] = [];
    const kind = fakeKind('k', (input) => {
      atEntry.push(Object.keys(input.slot));
      (input.slot as { ownerLock?: string }).ownerLock = 'claude-session-abc';
      return transition('working');
    });
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [kind]);
    registry.handle(S, 'test.hook', {}, [kind]);
    expect(atEntry).toEqual([[], ['ownerLock']]);
    registry.setViewing(S, true);

    expect(registry.forget(S)?.to).toBe('shell');
    expect(registry.get(S)).toBeUndefined();
    expect(registry.isViewing(S)).toBe(false);

    // Re-adopting hands over a FRESH slot. A leaked one would carry a dead
    // session's ownership lock into a new agent, so the new agent's own
    // SessionStart would be judged against a stranger's id and dropped.
    registry.handle(S, 'test.hook', {}, [kind]);
    expect(atEntry.at(-1)).toEqual([]);
  });

  it('a kind sees the same slot across events within one session', () => {
    const kind = fakeKind('k', (input) => {
      const slot = input.slot as { count?: number };
      slot.count = (slot.count ?? 0) + 1;
      return transition('working');
    });
    const registry = new AgentRegistry();
    registry.handle(S, 'test.hook', {}, [kind]);
    registry.handle(S, 'test.hook', {}, [kind]);
    registry.handle(S, 'test.hook', {}, [kind]);
    expect((kind.seen.at(-1)?.slot as { count?: number }).count).toBe(3);
  });

  it('forgetting an untracked session is quiet', () => {
    expect(new AgentRegistry().forget('nope')).toBeUndefined();
  });
});

describe('surviving a restart', () => {
  const adopted = (state: AgentState, reason?: string): AgentRegistry => {
    const registry = new AgentRegistry();
    const kind = fakeKind('claude-code', (input) => {
      (input.slot as { ownerLock?: string }).ownerLock = 'claude-abc';
      return transition(state, reason === undefined ? {} : { reason });
    });
    registry.handle(S, 'test.hook', {}, [kind]);
    return registry;
  };

  it('snapshots what an entry cannot be rebuilt without', () => {
    expect(adopted('blocked', 'approve Bash').snapshot()).toEqual([
      {
        sessionId: S,
        kindId: 'claude-code',
        state: 'blocked',
        reason: 'approve Bash',
        // The vendor's ownership lock and resume id live in here. Without it a
        // restored session is tracked but cannot be reattached to.
        slot: { ownerLock: 'claude-abc' },
      },
    ]);
  });

  it('omits a session that has dropped back to a shell', () => {
    expect(adopted('shell').snapshot()).toEqual([]);
  });

  it('restores the state, the reason and the kind’s slot', () => {
    const registry = new AgentRegistry();

    registry.restore({
      sessionId: S,
      kindId: 'claude-code',
      state: 'blocked',
      reason: 'approve Bash',
      slot: { ownerLock: 'claude-abc' },
    });

    expect(registry.get(S)).toEqual({
      sessionId: S,
      kindId: 'claude-code',
      state: 'blocked',
      reason: 'approve Bash',
    });
    expect(registry.slotOf(S)).toEqual({ ownerLock: 'claude-abc' });
  });

  it('announces a restore, so attention and every mirror hear about it', () => {
    // A fresh process has published nothing. Without an announcement the dock
    // badge and every extension's mirror would stay empty while the registry
    // knew better.
    const registry = new AgentRegistry();
    const seen: AgentChange[] = [];
    registry.onDidChange((change) => void seen.push(change));

    registry.restore({ sessionId: S, kindId: 'claude-code', state: 'blocked', slot: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.from).toBe('shell');
    expect(seen[0]?.to).toBe('blocked');
    // Nothing ended here — a restore is this process learning a state, not a
    // turn finishing. Reporting otherwise would fire an alert per agent at
    // every launch.
    expect(seen[0]?.turnFinished).toBe(false);
  });

  it('lets the restored kind read the restored state as current', () => {
    // THE bug this exists to fix. The ordering guard applies a mid-turn event
    // only while the session is working or blocked (ADR 0004), so a session
    // restored as untracked reads `shell` and every hook of the turn in flight
    // is discarded — the agent stays grey until the user types the next prompt.
    const registry = new AgentRegistry();
    registry.restore({ sessionId: S, kindId: 'claude-code', state: 'working', slot: {} });
    const kind = fakeKind('claude-code', () => transition('needsCheck'));

    registry.handle(S, 'test.hook', {}, [kind]);

    expect(kind.seen[0]?.current).toBe('working');
    expect(registry.get(S)?.state).toBe('needsCheck');
  });

  it('refuses a session a live event has already adopted', () => {
    // Replay-then-live: an event that landed while the snapshot was being read
    // is newer than the snapshot by construction, so it must not be overwritten.
    const registry = adopted('needsCheck');

    const change = registry.restore({ sessionId: S, kindId: 'claude-code', state: 'working', slot: {} });

    expect(change).toBeUndefined();
    expect(registry.get(S)?.state).toBe('needsCheck');
  });

  it('leaves a restored session open to the sweep', () => {
    // What makes a stale snapshot safe: an agent that finished while the app was
    // down is restored as working and then corrected, rather than believed
    // forever.
    const registry = new AgentRegistry();
    registry.restore({ sessionId: S, kindId: 'claude-code', state: 'working', slot: {} });

    for (let i = 0; i < SWEEP_QUIET_TICKS - 1; i += 1) {
      expect(registry.observe(S, false)).toBeUndefined();
    }
    expect(registry.observe(S, false)?.to).toBe('needsCheck');
  });
});

describe('change notification', () => {
  it('reports every write once, and survives a throwing listener', () => {
    const registry = new AgentRegistry();
    const seen: AgentChange[] = [];
    registry.onDidChange(() => {
      throw new Error('bad subscriber');
    });
    registry.onDidChange((change) => void seen.push(change));

    registry.handle(S, 'test.hook', {}, [fakeKind('k', () => transition('working'))]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.from).toBe('shell');
    expect(seen[0]?.to).toBe('working');
  });
});
