import { describe, expect, it } from 'vitest';
import { seqVerdict } from './envelope.ts';
import { callerLabel, externalCallerSchema } from './caller.ts';
import { isErr, isOk } from './result.ts';
import { extensionId, sessionId } from './ids.ts';

describe('seqVerdict', () => {
  it('accepts the first event it ever sees', () => {
    expect(seqVerdict(undefined, 1)).toBe('in-order');
    // …even if the subscriber joined late. There is nothing to compare against,
    // so calling this a gap would make every fresh subscription report one.
    expect(seqVerdict(undefined, 97)).toBe('in-order');
  });

  it('names the three outcomes apart', () => {
    expect(seqVerdict(4, 5)).toBe('in-order');
    expect(seqVerdict(4, 4)).toBe('duplicate');
    expect(seqVerdict(4, 3)).toBe('duplicate');
    expect(seqVerdict(4, 6)).toBe('gap');
  });

  it('a gap is a distinct answer from a duplicate because the response differs', () => {
    // A duplicate is dropped. A gap is LOGGED and the event processed anyway —
    // refusing it would turn one lost message into two. This is the detection
    // v1's hook channel lacked entirely: a reordered PreToolUse silently
    // overwrote `blocked` with `working` and nothing could tell.
    expect(seqVerdict(10, 12)).toBe('gap');
    expect(seqVerdict(10, 10)).toBe('duplicate');
  });
});

describe('callerLabel', () => {
  it('is greppable and carries the identity, for every kind', () => {
    expect(callerLabel({ kind: 'user' })).toBe('user');
    expect(callerLabel({ kind: 'kernel' })).toBe('kernel');
    expect(callerLabel({ kind: 'extension', id: extensionId('shepherd.tasks') })).toBe('extension:shepherd.tasks');
    expect(callerLabel({ kind: 'device', deviceId: 'pixel-9' })).toBe('device:pixel-9');
    expect(callerLabel({ kind: 'agent', sessionId: sessionId('s-1') })).toBe('agent:s-1');
  });
});

describe('externalCallerSchema', () => {
  it('parses the three remote kinds', () => {
    expect(isOk(externalCallerSchema.parse({ kind: 'device', deviceId: 'pixel-9' }))).toBe(true);
    expect(isOk(externalCallerSchema.parse({ kind: 'agent', sessionId: 's-1' }))).toBe(true);
    expect(isOk(externalCallerSchema.parse({ kind: 'extension', id: 'shepherd.tasks' }))).toBe(true);
  });

  it('REFUSES a socket client claiming to be the user or the kernel', () => {
    // The difference between an attributed caller and a self-declared one. A
    // `user` caller is minted in-process, by the thing that saw the keystroke;
    // `kernel` is core acting on its own behalf and is authorized unconditionally,
    // so a transport being able to claim it would be a straight bypass.
    expect(isErr(externalCallerSchema.parse({ kind: 'user' }))).toBe(true);
    expect(isErr(externalCallerSchema.parse({ kind: 'kernel' }))).toBe(true);
  });

  it('refuses a kind it does not know, and a missing identity', () => {
    expect(isErr(externalCallerSchema.parse({ kind: 'daemon', id: 'x' }))).toBe(true);
    expect(isErr(externalCallerSchema.parse({ kind: 'device' }))).toBe(true);
  });
});
