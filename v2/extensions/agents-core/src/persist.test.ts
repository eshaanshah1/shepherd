import { describe, expect, it } from 'vitest';
import { restorable } from './persist.ts';

/**
 * The snapshot is read back from disk after a restart, so every test here is
 * about refusing to trust it: a session that is gone, an entry a newer build
 * wrote, a blob somebody hand-edited.
 */

const live = (...ids: string[]): ReadonlySet<string> => new Set(ids);

const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'session-1',
  kindId: 'claude-code',
  state: 'working',
  slot: { ownerLock: 'claude-abc' },
  ...over,
});

describe('restorable', () => {
  it('keeps a live session whole', () => {
    const entry = stored({ reason: 'approve Bash' });

    expect(restorable([entry], live('session-1'))).toEqual([
      {
        sessionId: 'session-1',
        kindId: 'claude-code',
        state: 'working',
        reason: 'approve Bash',
        slot: { ownerLock: 'claude-abc' },
      },
    ]);
  });

  it('drops a session the kernel no longer reports', () => {
    // The pty went with the last run. Restoring it would put a working dot on a
    // pane that does not exist, and nothing would ever clear it — the sweep only
    // looks at sessions `sessions.list` names.
    expect(restorable([stored()], live('session-2'))).toEqual([]);
  });

  it('drops a shell entry', () => {
    // A plain terminal is not an agent, so there is nothing to preserve.
    expect(restorable([stored({ state: 'shell' })], live('session-1'))).toEqual([]);
  });

  it('drops one malformed entry without losing its neighbours', () => {
    // THE case. A single unreadable row must not cost every other agent its
    // state — which is what a whole-blob schema would do, since `KV.get` answers
    // `undefined` for a parse failure and the restore would restore nothing.
    const rows = [
      stored({ state: 'nonsense-from-a-newer-build' }),
      stored({ sessionId: 'session-2', kindId: 42 }),
      'not an object',
      stored({ sessionId: 'session-3', state: 'blocked' }),
    ];

    const kept = restorable(rows, live('session-1', 'session-2', 'session-3'));

    expect(kept.map((entry) => entry.sessionId)).toEqual(['session-3']);
    expect(kept[0]?.state).toBe('blocked');
  });

  it('reads an entry written by a build with extra fields', () => {
    // Lenient about ADDITIONS, for the reason `s.stored` exists: an unknown key
    // means a newer build wrote it, and refusing the row would lose a state that
    // is otherwise perfectly readable.
    const kept = restorable([stored({ somethingNew: true })], live('session-1'));

    expect(kept).toHaveLength(1);
    expect(kept[0]?.state).toBe('working');
  });

  it('restores an entry with no slot as one with an empty slot', () => {
    // A kind that recorded nothing still gets a slot object, because `reduce`
    // writes into whatever it is handed.
    expect(restorable([stored({ slot: undefined })], live('session-1'))[0]?.slot).toEqual({});
  });

  it('answers nothing for a key that was never written', () => {
    expect(restorable(undefined, live('session-1'))).toEqual([]);
  });
});
