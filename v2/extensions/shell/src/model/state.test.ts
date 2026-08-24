import { describe, expect, it } from 'vitest';
import { URGENCY, rollUp, tintFor } from './state.ts';

describe('the urgency order', () => {
  it('ranks anything that wants you above anything merely busy', () => {
    expect(URGENCY.blocked).toBeLessThan(URGENCY.working);
    expect(URGENCY.error).toBeLessThan(URGENCY.working);
    expect(URGENCY.needsCheck).toBeLessThan(URGENCY.working);
  });

  it('ranks a bare prompt last, level with idle', () => {
    expect(URGENCY.shell).toBe(URGENCY.idle);
    expect(URGENCY.working).toBeLessThan(URGENCY.idle);
  });
});

describe('the rollup', () => {
  it('answers with the loudest state present', () => {
    expect(rollUp(['idle', 'blocked', 'working'])).toBe('blocked');
    expect(rollUp(['working', 'idle'])).toBe('working');
  });

  it('is undefined when nothing is happening anywhere', () => {
    // A rail of plain shells is not five states, it is NOTHING happening, and a
    // row that declares no tint draws no mark.
    expect(rollUp([])).toBeUndefined();
    expect(rollUp(['idle', 'shell'])).toBeUndefined();
  });

  it('folds a word it has never seen in with the quiet case', () => {
    // These crossed a port from an extension this code has never seen: `ok` says
    // the call succeeded, not that the value has a shape.
    expect(rollUp(['sleeping'])).toBeUndefined();
    expect(rollUp(['sleeping', 'blocked'])).toBe('blocked');
  });
});

describe('the tint a state reaches the rail as', () => {
  it('spells needsCheck the way the shell resolves it', () => {
    // `view-dock`'s TINT_STATES maps `needs-check` to the READY mark, a green
    // square: a finished turn is not the same signal as a blocked one.
    expect(tintFor('needsCheck')).toBe('needs-check');
  });

  it('passes the rest through', () => {
    expect(tintFor('blocked')).toBe('blocked');
    expect(tintFor('working')).toBe('working');
    expect(tintFor('error')).toBe('error');
  });

  it('has no tint for the quiet states, so their rows draw no mark', () => {
    expect(tintFor('idle')).toBeUndefined();
    expect(tintFor('shell')).toBeUndefined();
  });
});
