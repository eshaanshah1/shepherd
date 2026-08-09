// PtyFanout, ported from spike/seam1/Sources/PtyBroker.swift and rewritten in R0.
//
// The ordering contract is PtyBroker's, and unchanged: a viewer that attaches
// while output is flowing sees replay-then-live with no gap and no duplicate.
// What changed is WHAT is replayed — a screen, not the last 256 KB — and that
// the replay now arrives asynchronously, because the mirror captures at a point
// in its own write queue.
//
// The duplicate direction is a REAL bug here, where against a ring it had no
// single-threaded expression. `attaches during a burst` is the test for it, and
// it fails if `mirror.capture` is made promise-shaped (probe p4).

import { describe, expect, it } from 'vitest';
import { PtyFanout, TerminalMirror } from './index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
/** Attachment replays land on a later tick now. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PtyFanout', () => {
  it('replays a repaintable SCREEN to a viewer that attaches after the fact', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('boot output\r\n'));

    const seen: string[] = [];
    fanout.attach((b) => seen.push(text(b)));
    await settle();

    expect(seen.join('')).toContain('boot output');
  });

  /**
   * The case a byte replay cannot serve, and the reason the mirror exists: the
   * raw stream carries `?1049h` and a series of cursor moves, which a fresh
   * emulator replays into a blank alt screen. The screen carries what was drawn.
   */
  it('replays the ALT SCREEN a full-screen app is showing', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('shell history\r\n'));
    fanout.feed(bytes('\x1b[?1049h\x1b[H\x1b[2J\x1b[3;5HEDITING A FILE'));

    const seen: string[] = [];
    fanout.attach((b) => seen.push(text(b)));
    await settle();

    expect(seen.join('')).toContain('EDITING A FILE');
    expect(fanout.screen().altScreen).toBe(true);
  });

  /**
   * THE contract, in its reachable form.
   *
   * Probe p4: with a promise-shaped capture, the snapshot is taken a microtask
   * late and contains bytes that are ALSO sitting in the queue — 223 of them.
   * Every marker must appear exactly once across the whole delivery.
   */
  it('attaching during a burst yields no gap and no duplicate', async () => {
    const fanout = new PtyFanout(new TerminalMirror({ scrollback: 2000 }));
    for (let i = 0; i < 200; i += 1) fanout.feed(bytes(`M${i}\r\n`));

    const seen: string[] = [];
    fanout.attach((b) => seen.push(text(b)));
    // The window the whole contract is about.
    for (let i = 200; i < 400; i += 1) fanout.feed(bytes(`M${i}\r\n`));
    await settle();

    const stream = seen.join('');
    for (let i = 200; i < 400; i += 1) {
      const hits = stream.match(new RegExp(`M${i}(?![0-9])`, 'g')) ?? [];
      expect(hits, `M${i} appeared ${hits.length} time(s), want 1`).toHaveLength(1);
    }
  });

  /**
   * A sink that writes back into the fanout from inside its own callback is the
   * sharpest form of the race. Its write must land AFTER whatever was already
   * queued for it — draining with a for-of over a snapshot of the array would
   * deliver it first.
   */
  it('keeps order when a sink feeds the fanout from inside its own replay', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('FIRST;'));

    const seen: string[] = [];
    let reentered = false;
    fanout.attach((b) => {
      seen.push(text(b));
      if (!reentered) {
        reentered = true;
        fanout.feed(bytes('REENTRANT;'));
      }
    });
    fanout.feed(bytes('DURING;'));
    await settle();

    const stream = seen.join('');
    expect(stream).toContain('FIRST');
    // Queued before the re-entrant write, so it must arrive before it.
    expect(stream.indexOf('DURING;')).toBeLessThan(stream.indexOf('REENTRANT;'));
    expect(stream.match(/DURING;/g) ?? []).toHaveLength(1);
  });

  it('fans one write out to every attached viewer', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    const a: string[] = [];
    const b: string[] = [];
    fanout.attach((x) => a.push(text(x)));
    fanout.attach((x) => b.push(text(x)));
    await settle();

    fanout.feed(bytes('hi'));
    expect(a.join('')).toContain('hi');
    expect(b.join('')).toContain('hi');
    expect(fanout.viewerCount).toBe(2);
  });

  it('a disposed viewer stops receiving, and disposing twice is a no-op', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    const seen: string[] = [];
    const sub = fanout.attach((x) => seen.push(text(x)));
    await settle();

    fanout.feed(bytes('one;'));
    sub.dispose();
    sub.dispose();
    fanout.feed(bytes('two;'));
    await settle();

    expect(seen.join('')).toContain('one;');
    expect(seen.join('')).not.toContain('two;');
    expect(fanout.viewerCount).toBe(0);
  });

  /** A viewer that goes away mid-capture must not be handed 55 KB of screen. */
  it('does not deliver to a sink disposed before its replay arrives', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('hello\r\n'));

    const seen: Uint8Array[] = [];
    fanout.attach((b) => seen.push(b)).dispose();
    await settle();

    expect(seen).toHaveLength(0);
    expect(fanout.viewerCount).toBe(0);
  });

  it('keeps recording into the screen with no viewers attached', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('while nobody watched;'));

    const seen: string[] = [];
    fanout.attach((x) => seen.push(text(x)));
    await settle();

    expect(seen.join('')).toContain('while nobody watched;');
  });

  it('a viewer that throws does not rob the others, nor the screen', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.attach(() => {
      throw new Error('viewer went away');
    });
    const seen: string[] = [];
    fanout.attach((x) => seen.push(text(x)));
    await settle();

    expect(() => fanout.feed(bytes('payload'))).not.toThrow();
    // `settle` again before reading the screen: `feed` delivers to sinks
    // synchronously but the mirror PARSES asynchronously, so a screen read in
    // the same tick as the feed is a read of the state before it.
    await settle();

    expect(seen.join('')).toContain('payload');
    expect(fanout.screen().text).toContain('payload');
  });

  it('hands the screen to a caller that wants it without attaching', async () => {
    const fanout = new PtyFanout(new TerminalMirror());
    fanout.feed(bytes('no viewers here\r\n'));

    const snapshot = await new Promise<Uint8Array>((resolve) => {
      fanout.snapshot(resolve);
    });
    expect(text(snapshot)).toContain('no viewers here');
    expect(fanout.viewerCount).toBe(0);
  });

  it('resizes the screen with the pty', async () => {
    const fanout = new PtyFanout(new TerminalMirror({ cols: 80, rows: 24 }));
    fanout.feed(bytes('keep me\r\n'));
    fanout.resize(100, 30);
    await settle();

    expect(fanout.screen().cols).toBe(100);
    expect(fanout.screen().rows).toBe(30);
    expect(fanout.screen().text).toContain('keep me');
  });
});
