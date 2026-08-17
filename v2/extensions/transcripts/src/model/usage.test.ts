import { describe, expect, it } from 'vitest';
import {
  addUsage,
  dedupeKeyOf,
  emptyRollup,
  maxUsage,
  subtractUsage,
  withUsage,
  ZERO_USAGE,
} from './usage.ts';
import type { TranscriptMessage } from './message.ts';

const msg = (over: Partial<TranscriptMessage>): TranscriptMessage =>
  ({
    seq: 0,
    uuid: 'u',
    parentUuid: null,
    role: 'assistant',
    blocks: [],
    ts: null,
    model: null,
    messageId: null,
    requestId: null,
    usage: null,
    isMeta: false,
    isCompactSummary: false,
    isSidechain: false,
    isHarnessNoise: false,
    ...over,
  }) as TranscriptMessage;

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe('dedupeKeyOf', () => {
  it('prefers message id and request id together', () => {
    expect(dedupeKeyOf(msg({ messageId: 'm1', requestId: 'r1' }))).toBe('m1:r1');
  });

  it('falls back to the message id, then the uuid', () => {
    expect(dedupeKeyOf(msg({ messageId: 'm1' }))).toBe('msg:m1');
    expect(dedupeKeyOf(msg({ uuid: 'u1' }))).toBe('uuid:u1');
  });
});

describe('maxUsage', () => {
  it('takes the larger of each field, because a later row can be fuller', () => {
    expect(maxUsage(u(10, 15, 0, 3), u(10, 40, 5, 0))).toEqual(u(10, 40, 5, 3));
  });
});

describe('addUsage', () => {
  it('sums each field', () => {
    expect(addUsage(u(1, 2, 3, 4), u(10, 20, 30, 40))).toEqual(u(11, 22, 33, 44));
  });
});

describe('withUsage', () => {
  it('accumulates per model and in total', () => {
    let r = emptyRollup();
    r = withUsage(r, 'opus', u(1, 2));
    r = withUsage(r, 'opus', u(1, 3));
    r = withUsage(r, 'haiku', u(5, 5));
    expect(r.byModel.opus).toEqual(u(2, 5));
    expect(r.byModel.haiku).toEqual(u(5, 5));
    expect(r.total).toEqual(u(7, 10));
  });

  it('files a model-less row under "unknown"', () => {
    expect(withUsage(emptyRollup(), null, u(1, 0)).byModel.unknown).toEqual(u(1, 0));
  });

  it('starts empty', () => {
    expect(emptyRollup().total).toEqual(ZERO_USAGE);
    expect(emptyRollup().byModel).toEqual({});
  });
});

describe('subtractUsage', () => {
  it('is the exact inverse of withUsage', () => {
    const once = withUsage(emptyRollup(), 'opus', u(1, 2, 3, 4));
    expect(subtractUsage(once, 'opus', u(1, 2, 3, 4))).toEqual({
      byModel: { opus: ZERO_USAGE },
      total: ZERO_USAGE,
    });
  });

  it('backs one contribution out of several', () => {
    let r = withUsage(emptyRollup(), 'opus', u(10, 10));
    r = withUsage(r, 'opus', u(1, 1));
    expect(subtractUsage(r, 'opus', u(1, 1)).total).toEqual(u(10, 10));
  });
});
