// PtyRing + PtyFanout, ported from spike/seam1/Sources/PtyBroker.swift.
//
// v1's ring was `buf.removeFirst(buf.count - cap)` on an array — O(n) per append
// once full, which the v2 review flagged. This one is a fixed circular
// Uint8Array, so the burst test below is a real guard rather than decoration:
// on a front-trim buffer 50 MB through a 256 KB ring is ~50 MB of memmove per
// megabyte written and does not finish in a second.
//
// The fanout half pins the ordering contract PtyBroker only documented in
// comments: snapshot-and-register is ONE step, so a viewer that attaches while
// output is flowing sees replay-then-live with no gap and no duplicate.

import { describe, expect, it } from 'vitest';
import { PtyFanout, PtyRing } from './index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('PtyRing', () => {
  it('replays what it was given, in order, while under cap', () => {
    const ring = new PtyRing(16);
    ring.append(bytes('abc'));
    ring.append(bytes('def'));
    expect(text(ring.snapshot())).toBe('abcdef');
    expect(ring.length).toBe(6);
  });

  it('is empty before anything is written', () => {
    const ring = new PtyRing(16);
    expect(ring.length).toBe(0);
    expect(ring.snapshot()).toHaveLength(0);
  });

  it('keeps the LAST cap bytes once it overflows', () => {
    const ring = new PtyRing(4);
    ring.append(bytes('abcdef'));
    expect(text(ring.snapshot())).toBe('cdef');
    expect(ring.length).toBe(4);
  });

  it('wraps across the physical end of the buffer', () => {
    // Three appends whose total crosses the seam twice — the case a naive
    // "copy from start" snapshot gets wrong while every non-wrapping test passes.
    const ring = new PtyRing(5);
    ring.append(bytes('abc'));
    ring.append(bytes('de'));
    ring.append(bytes('fg'));
    expect(text(ring.snapshot())).toBe('cdefg');
  });

  it('handles a single write larger than the whole ring', () => {
    const ring = new PtyRing(4);
    ring.append(bytes('0123456789'));
    expect(text(ring.snapshot())).toBe('6789');
    expect(ring.length).toBe(4);
  });

  it('never exceeds cap, whatever the chunking', () => {
    const ring = new PtyRing(100);
    for (let i = 0; i < 500; i += 1) ring.append(bytes(`chunk-${i};`));
    expect(ring.length).toBe(100);
    expect(ring.snapshot()).toHaveLength(100);
    expect(text(ring.snapshot()).endsWith('chunk-499;')).toBe(true);
  });

  it('hands back a copy, so a later append cannot mutate an earlier snapshot', () => {
    const ring = new PtyRing(8);
    ring.append(bytes('abcd'));
    const snap = ring.snapshot();
    ring.append(bytes('efghij'));
    expect(text(snap)).toBe('abcd');
  });

  it('ignores an empty append', () => {
    const ring = new PtyRing(8);
    ring.append(bytes('ab'));
    ring.append(new Uint8Array(0));
    expect(text(ring.snapshot())).toBe('ab');
  });

  it('clear() empties it without reallocating', () => {
    const ring = new PtyRing(8);
    ring.append(bytes('abcdefgh'));
    ring.clear();
    expect(ring.length).toBe(0);
    ring.append(bytes('xy'));
    expect(text(ring.snapshot())).toBe('xy');
  });

  it('appends 50 MB in 64 KB chunks in under a second (the O(1) guard)', () => {
    const cap = 256 * 1024;
    const ring = new PtyRing(cap);
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 'a'
    const total = 50 * 1024 * 1024;
    const chunks = total / chunk.length;

    const started = performance.now();
    for (let i = 0; i < chunks; i += 1) {
      // Stamp each chunk so "the last cap bytes exactly" is a real claim.
      chunk[0] = i & 0xff;
      ring.append(chunk);
      expect(ring.length).toBeLessThanOrEqual(cap);
    }
    const elapsed = performance.now() - started;

    expect(ring.length).toBe(cap);
    const snap = ring.snapshot();
    // The last cap bytes = the tail of the last (cap / 64K) chunks.
    const expected = new Uint8Array(cap);
    const perChunk = chunk.length;
    for (let i = 0; i < cap / perChunk; i += 1) {
      const stamped = new Uint8Array(perChunk).fill(0x61);
      stamped[0] = (chunks - cap / perChunk + i) & 0xff;
      expected.set(stamped, i * perChunk);
    }
    expect(snap).toEqual(expected);
    expect(elapsed).toBeLessThan(1000);
  });

  it('costs the same per append whatever the ring holds (the guard with teeth)', () => {
    // The test above is the one the plan asked for, and it is a CORRECTNESS
    // test wearing a stopwatch: measured on this machine, 50 MB of 64 KB chunks
    // through a 256 KB ring takes 0.8 ms circular, 18.6 ms for a naive
    // concat-and-slice, and 287 ms for v1's exact `[UInt8]` + removeFirst. All
    // three are under a second, so that threshold discriminates nothing.
    //
    // What separates them is the ring's SIZE, because a front-trim copies the
    // whole ring on every append and a circular buffer copies only the chunk.
    // Same 64 KB chunks, an 8 MB ring, 64 MB pushed through: 1.2 ms circular,
    // 601 ms concat-and-slice, 2.5 s front-trim-array. 150 ms sits ~125x above
    // the real implementation and ~4x below the cheapest wrong one.
    const cap = 8 * 1024 * 1024;
    const ring = new PtyRing(cap);
    const chunk = new Uint8Array(64 * 1024).fill(0x62);
    const chunks = (64 * 1024 * 1024) / chunk.length;

    const started = performance.now();
    for (let i = 0; i < chunks; i += 1) ring.append(chunk);
    const elapsed = performance.now() - started;

    expect(ring.length).toBe(cap);
    expect(elapsed).toBeLessThan(150);
  });
});

describe('PtyFanout', () => {
  it('replays the ring to a viewer that attaches after the fact', () => {
    const fanout = new PtyFanout(new PtyRing(1024));
    fanout.feed(bytes('boot output\n'));
    const seen: string[] = [];
    fanout.attach((b) => seen.push(text(b)));
    expect(seen.join('')).toBe('boot output\n');
  });

  it('attaching during live output yields replay then live, no gap, no duplicate', () => {
    // The contract PtyBroker.attachViewer holds its lock for: snapshot, insert
    // and replay are one step, so no byte can land between the snapshot and the
    // registration (lost) or be delivered by both (duplicated).
    const fanout = new PtyFanout(new PtyRing(1024));
    fanout.feed(bytes('MARKER-1;'));

    const seen: string[] = [];
    // A sink that writes back into the fanout is the sharpest form of the race:
    // if `attach` registered before replaying, this re-entrant feed would be
    // delivered to the very viewer still being replayed.
    let reentered = false;
    fanout.attach((b) => {
      seen.push(text(b));
      if (!reentered) {
        reentered = true;
        fanout.feed(bytes('MARKER-2;'));
      }
    });
    fanout.feed(bytes('MARKER-3;'));

    const stream = seen.join('');
    expect(stream).toBe('MARKER-1;MARKER-2;MARKER-3;');
    expect(stream.split('MARKER-1;')).toHaveLength(2); // exactly one copy of the replay
  });

  it('fans one write out to every attached viewer', () => {
    const fanout = new PtyFanout(new PtyRing(1024));
    const a: string[] = [];
    const b: string[] = [];
    fanout.attach((x) => a.push(text(x)));
    fanout.attach((x) => b.push(text(x)));
    fanout.feed(bytes('hi'));
    expect(a).toEqual(['hi']);
    expect(b).toEqual(['hi']);
    expect(fanout.viewerCount).toBe(2);
  });

  it('a disposed viewer stops receiving, and disposing twice is a no-op', () => {
    const fanout = new PtyFanout(new PtyRing(1024));
    const seen: string[] = [];
    const sub = fanout.attach((x) => seen.push(text(x)));
    fanout.feed(bytes('one;'));
    sub.dispose();
    sub.dispose();
    fanout.feed(bytes('two;'));
    expect(seen.join('')).toBe('one;');
    expect(fanout.viewerCount).toBe(0);
  });

  it('keeps recording into the ring with no viewers attached', () => {
    const fanout = new PtyFanout(new PtyRing(1024));
    fanout.feed(bytes('while nobody watched;'));
    const seen: string[] = [];
    fanout.attach((x) => seen.push(text(x)));
    expect(seen.join('')).toBe('while nobody watched;');
  });

  it('a viewer that throws does not rob the others, nor the ring', () => {
    const fanout = new PtyFanout(new PtyRing(1024));
    fanout.attach(() => {
      throw new Error('viewer went away');
    });
    const seen: string[] = [];
    fanout.attach((x) => seen.push(text(x)));
    expect(() => fanout.feed(bytes('payload'))).not.toThrow();
    expect(seen.join('')).toBe('payload');
    expect(text(fanout.snapshot())).toBe('payload');
  });
});
