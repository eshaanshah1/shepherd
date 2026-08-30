import { beforeEach, describe, expect, it } from 'vitest';
import { sessionId, type SessionID } from '@shepherd/sdk';
import { ViewerRegistry } from './viewers.ts';

let viewers: ViewerRegistry;
const S1 = sessionId('s1');
const S2 = sessionId('s2');

beforeEach(() => {
  viewers = new ViewerRegistry();
});

describe('the set of principals viewing a session', () => {
  it('starts empty, and an unviewed session is not viewed', () => {
    expect(viewers.viewersOf(S1)).toEqual([]);
    expect(viewers.isViewed(S1)).toBe(false);
  });

  it('aggregates two clients looking at the same session', () => {
    viewers.report('app', S1, true);
    viewers.report('device:phone', S1, true);
    expect(viewers.viewersOf(S1)).toEqual(['app', 'device:phone']);
    expect(viewers.isViewed(S1)).toBe(true);
  });

  it('stays viewed while ANY principal is still looking', () => {
    // The whole reason this is a set: nothing may push for a session another
    // client is looking at.
    viewers.report('app', S1, true);
    viewers.report('device:phone', S1, true);
    viewers.report('app', S1, false);
    expect(viewers.isViewed(S1)).toBe(true);
    expect(viewers.viewersOf(S1)).toEqual(['device:phone']);
  });

  it('stops being viewed once the last principal looks away', () => {
    viewers.report('app', S1, true);
    viewers.report('app', S1, false);
    expect(viewers.isViewed(S1)).toBe(false);
    expect(viewers.viewersOf(S1)).toEqual([]);
  });

  it('keeps each session\'s set apart', () => {
    viewers.report('app', S1, true);
    viewers.report('device:phone', S2, true);
    expect(viewers.viewersOf(S1)).toEqual(['app']);
    expect(viewers.viewersOf(S2)).toEqual(['device:phone']);
  });
});

describe('onDidChange', () => {
  it('announces the SET, not the edge', () => {
    const seen: [SessionID, readonly string[]][] = [];
    viewers.onDidChange((session, set) => seen.push([session, set]));
    viewers.report('app', S1, true);
    viewers.report('device:phone', S1, true);
    expect(seen).toEqual([
      [S1, ['app']],
      [S1, ['app', 'device:phone']],
    ]);
  });

  it('does not fire when a principal repeats what it already said', () => {
    // A client re-reporting on every frame must not wake every subscriber.
    let count = 0;
    viewers.report('app', S1, true);
    viewers.onDidChange(() => count++);
    viewers.report('app', S1, true);
    viewers.report('device:phone', S1, false);
    expect(count).toBe(0);
  });

  it('stops on dispose', () => {
    let count = 0;
    const subscription = viewers.onDidChange(() => count++);
    subscription.dispose();
    viewers.report('app', S1, true);
    expect(count).toBe(0);
  });
});

describe('forget', () => {
  it('drops everything a principal was viewing when it disconnects', () => {
    // A client that dies holding "I am looking at this" would suppress that
    // session's notifications for the life of the process.
    viewers.report('device:phone', S1, true);
    viewers.report('device:phone', S2, true);
    viewers.report('app', S1, true);

    const changed = viewers.forget('device:phone');

    expect(new Set(changed)).toEqual(new Set([S1, S2]));
    expect(viewers.viewersOf(S1)).toEqual(['app']);
    expect(viewers.isViewed(S2)).toBe(false);
  });

  it('announces each session it dropped', () => {
    const seen: SessionID[] = [];
    viewers.report('device:phone', S1, true);
    viewers.onDidChange((session) => seen.push(session));
    viewers.forget('device:phone');
    expect(seen).toEqual([S1]);
  });

  it('answers nothing for a principal that was viewing nothing', () => {
    expect(viewers.forget('device:phone')).toEqual([]);
  });
});

describe('viewed', () => {
  it('lists every session anybody is looking at', () => {
    viewers.report('app', S1, true);
    viewers.report('device:phone', S2, true);
    viewers.report('app', S1, false);
    expect(viewers.viewed()).toEqual([S2]);
  });
});
