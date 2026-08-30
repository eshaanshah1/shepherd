import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, manualClock, sessionId, type LogRecord, type Logger, type SessionID } from '@shepherd/sdk';
import { SessionLifetime } from './lifetime.ts';

let ended: SessionID[];
let records: LogRecord[];
let logger: Logger;

beforeEach(() => {
  ended = [];
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
});

function build(): SessionLifetime {
  return new SessionLifetime({ end: (id) => void ended.push(id), logger });
}

const S1 = sessionId('s1');

/** A holder that answers for exactly the sessions it was handed. */
function holder(principal: string, reason: string, held: SessionID[]) {
  return { reason, principals: (id: SessionID) => (held.includes(id) ? [principal] : []) };
}

describe('release', () => {
  it('ends a session nobody else holds', () => {
    const lifetime = build();
    const outcome = lifetime.release(S1, 'app');
    expect(outcome.ended).toBe(true);
    expect(ended).toEqual([S1]);
  });

  it('does NOT end one another principal holds', () => {
    // The whole point of Stage 1: one client closing its view must not kill an
    // agent a second client is watching.
    const lifetime = build();
    lifetime.addHolder(holder('device:phone', 'viewing', [S1]));
    const outcome = lifetime.release(S1, 'app');
    expect(outcome.ended).toBe(false);
    expect(outcome.heldBy).toEqual(['device:phone']);
    expect(ended).toEqual([]);
  });

  it('ignores the RELEASING principal\'s own holds', () => {
    // The app releases as it closes the pane, and its own viewing entry has not
    // been re-evaluated yet. A principal cannot hold a session against itself.
    const lifetime = build();
    lifetime.addHolder(holder('app', 'the pane is still being looked at', [S1]));
    expect(lifetime.release(S1, 'app').ended).toBe(true);
    expect(ended).toEqual([S1]);
  });

  it('ends it once the last other principal lets go', () => {
    const lifetime = build();
    const phone = { held: [S1] };
    lifetime.addHolder({ reason: 'viewing', principals: (id) => (phone.held.includes(id) ? ['device:phone'] : []) });
    expect(lifetime.release(S1, 'app').ended).toBe(false);
    phone.held = [];
    expect(lifetime.release(S1, 'device:phone').ended).toBe(true);
    expect(ended).toEqual([S1]);
  });

  it('says who is holding it, so "my pane closed and the agent lived" is answerable', () => {
    const lifetime = build();
    lifetime.addHolder(holder('device:phone', 'viewing', [S1]));
    lifetime.release(S1, 'app');
    const said = records.map((r) => r.message).join('\n');
    expect(said).toContain('device:phone');
    expect(said).toContain('viewing');
  });

  it('drops a holder that was disposed', () => {
    const lifetime = build();
    const subscription = lifetime.addHolder(holder('device:phone', 'viewing', [S1]));
    subscription.dispose();
    expect(lifetime.release(S1, 'app').ended).toBe(true);
  });

  it('survives a throwing holder by treating it as holding nothing, and says so', () => {
    // A holder that cannot answer must not be able to strand a pty forever, and
    // must not be silent about it either.
    const lifetime = build();
    lifetime.addHolder({
      reason: 'viewing',
      principals: () => {
        throw new Error('holder bug');
      },
    });
    expect(lifetime.release(S1, 'app').ended).toBe(true);
    expect(records.map((r) => r.message).some((m) => m.includes('holder bug'))).toBe(true);
  });
});

describe('terminate', () => {
  it('ends the session whatever anyone holds — it is the explicit verb', () => {
    const lifetime = build();
    lifetime.addHolder(holder('device:phone', 'viewing', [S1]));
    lifetime.terminate(S1);
    expect(ended).toEqual([S1]);
  });
});

describe('holdersOf', () => {
  it('lists every principal holding a session, with its reason', () => {
    const lifetime = build();
    lifetime.addHolder(holder('app', 'a pane shows it', [S1]));
    lifetime.addHolder(holder('device:phone', 'viewing', [S1]));
    expect(lifetime.holdersOf(S1)).toEqual([
      { principal: 'app', reason: 'a pane shows it' },
      { principal: 'device:phone', reason: 'viewing' },
    ]);
  });

  it('reports each principal once even when two holders answer for it', () => {
    const lifetime = build();
    lifetime.addHolder(holder('app', 'a pane shows it', [S1]));
    lifetime.addHolder(holder('app', 'viewing', [S1]));
    expect(lifetime.holdersOf(S1).map((h) => h.principal)).toEqual(['app']);
  });

  it('lists every principal ONE holder speaks for — the viewer set is one holder', () => {
    const lifetime = build();
    lifetime.addHolder({ reason: 'viewing', principals: () => ['app', 'device:phone'] });
    expect(lifetime.holdersOf(S1, 'app')).toEqual([{ principal: 'device:phone', reason: 'viewing' }]);
  });
});
