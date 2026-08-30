import { describe, expect, it } from 'vitest';
import { NO_TOASTS, crossings, dismiss, enqueue, prune, standingOf, toRaise, visible } from './raise.ts';
import type { TriageEntry } from './triage.ts';
import type { Place } from './nav.ts';

const entry = (over: Partial<TriageEntry> & { id: string }): TriageEntry => ({
  label: over.id,
  rowId: over.id,
  mark: 'resting',
  place: false,
  facts: {},
  viewType: 'tasks.tree',
  ...over,
});

const HOME: Place = { kind: 'home' };
const on = (id: string): Place => ({ kind: 'task', id, root: `task:${id}`, face: 'agents' });

describe('crossings', () => {
  it('fires on the edge into Needs you, not on sitting there', () => {
    /*
     * The view mechanism re-reads a tree WHOLE on every nudge, so a rule about
     * the state rather than the change would raise the same toast a few times a
     * minute for as long as the question went unanswered.
     */
    const working = [entry({ id: 'a', mark: 'working' })];
    const asking = [entry({ id: 'a', mark: 'waiting' })];
    expect(crossings(standingOf(working), asking).map((each) => each.id)).toEqual(['a']);
    expect(crossings(standingOf(asking), asking)).toEqual([]);
  });

  it('says nothing about a row it has never seen', () => {
    // The first push after launch carries every task at once. Treating that as
    // news is a toast per blocked task at startup, before you have done a thing.
    expect(crossings(new Map(), [entry({ id: 'a', mark: 'waiting' })])).toEqual([]);
  });

  it('does not fire for a task that merely changed inside Needs you', () => {
    // A finished turn becoming a question is still one thing asking for you.
    const was = standingOf([entry({ id: 'a', mark: 'ready' })]);
    expect(crossings(was, [entry({ id: 'a', mark: 'waiting' })])).toEqual([]);
  });

  it('fires when a snooze wakes into a question', () => {
    const asleep = standingOf([
      entry({ id: 'a', mark: 'waiting', facts: { snooze: { label: 'later today' } } }),
    ]);
    expect(crossings(asleep, [entry({ id: 'a', mark: 'waiting' })]).map((e) => e.id)).toEqual(['a']);
  });
});

describe('visible', () => {
  it('counts HOME as looking at it, because the picture IS the notification', () => {
    const asking = entry({ id: 'a', mark: 'waiting' });
    expect(visible(HOME, asking)).toBe(true);
    expect(toRaise(HOME, [asking])).toEqual([]);
  });

  it('counts the task itself, and only that task', () => {
    const a = entry({ id: 'a', mark: 'waiting' });
    expect(visible(on('a'), a)).toBe(true);
    expect(visible(on('b'), a)).toBe(false);
    expect(toRaise(on('b'), [a]).map((each) => each.id)).toEqual(['a']);
  });

  it('raises over the shells, which show nothing about your work', () => {
    const a = entry({ id: 'a', mark: 'waiting' });
    expect(visible({ kind: 'shells' }, a)).toBe(false);
  });
});

describe('the queue', () => {
  it('shows one and holds the rest', () => {
    const queue = enqueue(NO_TOASTS, ['a', 'b', 'c']);
    expect(queue).toEqual({ showing: 'a', waiting: ['b', 'c'] });
  });

  it('collapses a repeat, because a second copy says nothing new', () => {
    const queue = enqueue(enqueue(NO_TOASTS, ['a', 'b']), ['a', 'b']);
    expect(queue).toEqual({ showing: 'a', waiting: ['b'] });
  });

  it('promotes the next when the one on screen goes', () => {
    expect(dismiss(enqueue(NO_TOASTS, ['a', 'b']), 'a')).toEqual({ showing: 'b', waiting: [] });
  });

  it('drops a waiting one without disturbing the one on screen', () => {
    expect(dismiss(enqueue(NO_TOASTS, ['a', 'b']), 'b')).toEqual({ showing: 'a', waiting: [] });
  });

  it('NEVER dequeues the task — dismissing is about the card', () => {
    /*
     * The promise the whole surface makes. `esc` on a toast takes the card off
     * the screen and the task stays exactly where it was, so the queue and the
     * triage cannot disagree about whether you still owe it an answer.
     */
    const entries = [entry({ id: 'a', mark: 'waiting' }), entry({ id: 'b', mark: 'waiting' })];
    const queue = dismiss(enqueue(NO_TOASTS, ['a', 'b']), 'a');
    expect(prune(queue, entries)).toEqual({ showing: 'b', waiting: [] });
    // …and `a` is still in the list it was in.
    expect(entries.map((each) => each.id)).toContain('a');
  });

  it('prunes a card whose task stopped asking', () => {
    // Answered from Home, or from another window, or simply finished. A card
    // offering to take you to a question that is already answered is worse
    // than no card.
    const queue = enqueue(NO_TOASTS, ['a', 'b']);
    expect(prune(queue, [entry({ id: 'b', mark: 'waiting' })])).toEqual({ showing: 'b', waiting: [] });
    expect(prune(queue, [])).toEqual(NO_TOASTS);
  });
});
