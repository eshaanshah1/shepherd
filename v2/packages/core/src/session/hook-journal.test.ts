import { describe, expect, it } from 'vitest';
import { HookJournal } from './hook-journal.ts';

/**
 * What an agent said while nobody was listening.
 *
 * The cap's DIRECTION is the only real decision in here, and it has a reason:
 * a reducer folds these in order and the last ones decide the state, so an
 * overflowing journal must lose its head and keep its tail.
 */

const hook = (event: string, session = 'session-1') => ({
  topic: 'claude.hook',
  sessionId: session,
  payload: { event },
});

const events = (drained: { events: readonly { payload: unknown }[] }): string[] =>
  drained.events.map((e) => (e.payload as { event: string }).event);

describe('HookJournal', () => {
  it('hands back what it recorded, in order', () => {
    const journal = new HookJournal();
    journal.record(hook('UserPromptSubmit'));
    journal.record(hook('PreToolUse'));

    expect(events(journal.drain())).toEqual(['UserPromptSubmit', 'PreToolUse']);
  });

  it('empties on drain, so nothing is replayed twice', () => {
    // A reducer is not idempotent — a second `Stop` folded into a reopened turn
    // is a wrong state, not a no-op — so a delivered event must be gone.
    const journal = new HookJournal();
    journal.record(hook('Stop'));

    expect(journal.drain().events).toHaveLength(1);
    expect(journal.drain().events).toEqual([]);
  });

  it('keeps the newest when it overflows, and reports the loss in the same answer', () => {
    // Two decisions here. The DIRECTION: the tail is what lands the state closest
    // to the truth, while the head is mostly re-assertions that a turn is still
    // working. And the loss riding along WITH the batch rather than being a
    // separate read — a caller that drained first and asked after would be told
    // zero, which is a silent lie about a state that is now wrong.
    const journal = new HookJournal({ limit: 3 });
    for (const event of ['a', 'b', 'c', 'd', 'e']) journal.record(hook(event));

    const drained = journal.drain();

    expect(events(drained)).toEqual(['c', 'd', 'e']);
    expect(drained.dropped).toBe(2);
    // And the next batch starts clean, or the same loss is reported at every
    // launch for the life of the daemon.
    expect(journal.drain().dropped).toBe(0);
  });

  it('counts what it is holding', () => {
    const journal = new HookJournal();
    expect(journal.size).toBe(0);
    journal.record(hook('a'));
    expect(journal.size).toBe(1);
  });
});
