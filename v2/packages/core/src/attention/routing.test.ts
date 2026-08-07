import { describe, expect, it } from 'vitest';
import type { AttentionLevel } from '@shepherd/sdk';
import { route, wantsAttention, type RoutingInput } from './routing.ts';

const LEVELS: readonly AttentionLevel[] = ['none', 'info', 'attention', 'urgent'];

function input(patch: Partial<RoutingInput> = {}): RoutingInput {
  return {
    level: 'attention',
    viewing: false,
    appActive: true,
    away: false,
    turnFinished: true,
    ...patch,
  };
}

describe('viewing suppresses every channel', () => {
  it('a turn finishing under your eyes is not an event', () => {
    // ADR 0020: the pane is in front of you, so a banner, a chime, a push and a
    // badge would all be telling you something you are already looking at.
    const decision = route(input({ viewing: true }));
    expect(decision).toMatchObject({ banner: false, chime: false, push: false, badge: false });
    expect(decision.reason).toContain('viewing');
  });

  it('suppresses an urgent level too', () => {
    expect(route(input({ level: 'urgent', viewing: true }))).toMatchObject({
      banner: false,
      chime: false,
      push: false,
      badge: false,
    });
  });
});

describe('a shut lid is not a pair of eyes', () => {
  it('pushes even while `viewing` is true', () => {
    // THE negative control. v1: `NSApp.isActive` and `isFrontPane` both stay true
    // in clamshell, so a turn finishing there suppressed the banner (right — nobody
    // can see it) AND the phone push (wrong — that is the only surface left).
    // v1 filtered `away` in both `isViewing` and this policy; here `Presence`
    // carries no `away`, so this function is the ONLY place the filter can live.
    const decision = route(input({ viewing: true, away: true }));
    expect(decision).toMatchObject({ banner: false, chime: false, push: true, badge: true });
    expect(decision.reason).toContain('away');
  });

  it('away routes the phone instead of the desktop', () => {
    expect(route(input({ away: true, appActive: false }))).toMatchObject({
      banner: false,
      chime: false,
      push: true,
      badge: true,
    });
  });
});

describe('present but not looking', () => {
  it('app active ⇒ banner + chime + badge, never push', () => {
    // You are at the machine: the phone is not the surface that reaches you.
    expect(route(input({ appActive: true }))).toMatchObject({
      banner: true,
      chime: true,
      push: false,
      badge: true,
    });
  });

  it('app inactive and not away ⇒ the same, because the banner is what pulls you back', () => {
    expect(route(input({ appActive: false }))).toMatchObject({
      banner: true,
      chime: true,
      push: false,
      badge: true,
    });
  });

  it('urgent routes the same channels as attention — ordering is the store\'s job', () => {
    const attention = route(input({ level: 'attention' }));
    const urgent = route(input({ level: 'urgent' }));
    expect({ ...urgent, reason: '' }).toEqual({ ...attention, reason: '' });
  });
});

describe('the quiet levels', () => {
  it('`none` decides nothing, and still says so', () => {
    const decision = route(input({ level: 'none' }));
    expect(decision).toMatchObject({ banner: false, chime: false, push: false, badge: false });
    expect(decision.reason).not.toBe('');
  });

  it('`info` never chimes, never pushes, never banners and never badges', () => {
    // CLAUDE.md's nudge rule: a conflict is a CONDITION, not an event, and is
    // always downstream of something that already alerted. It reaches the dot
    // (`aggregate`) and nothing else.
    for (const away of [false, true]) {
      expect(route(input({ level: 'info', away }))).toMatchObject({
        banner: false,
        chime: false,
        push: false,
        badge: false,
      });
    }
  });
});

describe('turnFinished', () => {
  it('changes no channel — it only reaches the reason', () => {
    // Recorded deliberately: nothing in the routing rules keys off it, so it is
    // evidence in the log line rather than an input to a decision.
    const finished = route(input({ turnFinished: true }));
    const not = route(input({ turnFinished: false }));
    expect({ ...finished, reason: '' }).toEqual({ ...not, reason: '' });
    expect(finished.reason).not.toBe(not.reason);
  });
});

describe('every branch composes a reason', () => {
  it('over the whole input matrix', () => {
    for (const level of LEVELS) {
      for (const viewing of [false, true]) {
        for (const appActive of [false, true]) {
          for (const away of [false, true]) {
            for (const turnFinished of [false, true]) {
              const decision = route({ level, viewing, appActive, away, turnFinished });
              // "I heard nothing on my phone" is otherwise unanswerable: push is
              // deliberately suppressed unless this Mac is away, and without this
              // nothing records which branch ran.
              expect(decision.reason.length, JSON.stringify({ level, viewing, away })).toBeGreaterThan(0);
              if (!wantsAttention(level)) {
                expect(decision, JSON.stringify({ level })).toMatchObject({
                  banner: false,
                  chime: false,
                  push: false,
                  badge: false,
                });
              }
              if (viewing && !away) {
                expect(decision.banner || decision.chime || decision.push || decision.badge).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});

describe('wantsAttention', () => {
  it('is attention and urgent, and is the ONE predicate the badge and the ring share', () => {
    expect(LEVELS.filter(wantsAttention)).toEqual(['attention', 'urgent']);
  });
});
