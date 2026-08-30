import { describe, expect, it } from 'vitest';
import { sessionId } from '@shepherd/sdk';
import { reconcile } from './reconcile.ts';

const s = sessionId;

describe('reconcile', () => {
  it('adopts a claim whose session the authority still has', () => {
    const out = reconcile({
      claims: [{ pane: 'p1', session: s('a') }],
      live: [s('a')],
      held: [],
    });
    expect(out.adopted).toEqual([{ pane: 'p1', session: 'a' }]);
    expect(out.dropped).toEqual([]);
  });

  it('drops a claim whose session has ended', () => {
    // ADR 0036's second rung: the binding is a CLAIM, and this is it failing by
    // being checked rather than by being impossible.
    const out = reconcile({ claims: [{ pane: 'p1', session: s('a') }], live: [], held: [] });
    expect(out.adopted).toEqual([]);
    expect(out.dropped).toEqual([{ pane: 'p1', session: 'a' }]);
  });

  it('reports a live session nobody claimed as an ORPHAN', () => {
    // ADR 0036 named this case and nothing ever computed it: a pty running with
    // nothing pointing at it, invisible and unkillable from any UI.
    const out = reconcile({ claims: [{ pane: 'p1', session: s('a') }], live: [s('a'), s('b')], held: [] });
    expect(out.orphans).toEqual(['b']);
  });

  it('does not call a session an orphan because THIS client did not claim it', () => {
    // Another client holding it is the ordinary multi-client case, and calling
    // it an orphan is how a reaper would kill somebody else's agent.
    const out = reconcile({ claims: [], live: [s('a')], held: [s('a')] });
    expect(out.orphans).toEqual([]);
  });

  it('gives a session claimed by two panes to the FIRST, and drops the rest', () => {
    // Two panes resolving to one pty is the defect `pane-sessions.ts` documents,
    // arriving through the front door. Silently adopting both would put two
    // views on one agent with neither knowing.
    const out = reconcile({
      claims: [
        { pane: 'p1', session: s('a') },
        { pane: 'p2', session: s('a') },
      ],
      live: [s('a')],
      held: [],
    });
    expect(out.adopted).toEqual([{ pane: 'p1', session: 'a' }]);
    expect(out.dropped).toEqual([{ pane: 'p2', session: 'a' }]);
    expect(out.orphans).toEqual([]);
  });

  it('answers nothing at all for a client with nothing running and nothing claimed', () => {
    expect(reconcile({ claims: [], live: [], held: [] })).toEqual({
      adopted: [],
      dropped: [],
      orphans: [],
    });
  });

  it('is stable in the order the authority listed', () => {
    const out = reconcile({ claims: [], live: [s('b'), s('a')], held: [] });
    expect(out.orphans).toEqual(['b', 'a']);
  });
});
