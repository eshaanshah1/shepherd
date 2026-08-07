import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '@shepherd/sdk';
import { debounce } from './debounce.ts';

describe('debounce', () => {
  it('fires once after the quiet period, not once per call', () => {
    const clock = manualClock(0);
    const fn = vi.fn();
    const d = debounce(clock, 100, fn);

    d.schedule();
    d.schedule();
    d.schedule();
    expect(fn).not.toHaveBeenCalled();

    clock.advance(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('each call pushes the deadline out', () => {
    const clock = manualClock(0);
    const fn = vi.fn();
    const d = debounce(clock, 100, fn);

    d.schedule();
    clock.advance(90);
    d.schedule();
    clock.advance(90);
    expect(fn).not.toHaveBeenCalled();

    clock.advance(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a later call after firing starts a new window', () => {
    const clock = manualClock(0);
    const fn = vi.fn();
    const d = debounce(clock, 50, fn);

    d.schedule();
    clock.advance(50);
    d.schedule();
    clock.advance(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('flush() runs pending work NOW — the thing app-quit needs', () => {
    // A debounced write with no flush on teardown loses whatever was in the
    // window. That is v1's `save()` discipline read backwards: batching writes
    // is only safe if quitting is one of the things that ends a batch.
    const clock = manualClock(0);
    const fn = vi.fn();
    const d = debounce(clock, 5_000, fn);

    d.schedule();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // …and the timer it cancelled does not fire a second time later.
    clock.advance(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending does nothing', () => {
    const clock = manualClock(0);
    const fn = vi.fn();
    debounce(clock, 100, fn).flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('dispose() drops pending work without running it', () => {
    const clock = manualClock(0);
    const fn = vi.fn();
    const d = debounce(clock, 100, fn);
    d.schedule();
    d.dispose();
    clock.advance(1_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports whether work is waiting', () => {
    const clock = manualClock(0);
    const d = debounce(clock, 100, () => {});
    expect(d.pending).toBe(false);
    d.schedule();
    expect(d.pending).toBe(true);
    clock.advance(100);
    expect(d.pending).toBe(false);
  });

  it('a throwing callback still clears the pending flag', () => {
    // Otherwise one failed write wedges the debouncer and every later schedule()
    // is a no-op — a silent stop, which is the failure mode we log about.
    const clock = manualClock(0);
    const d = debounce(clock, 10, () => {
      throw new Error('disk full');
    });
    d.schedule();
    expect(() => clock.advance(10)).toThrow('disk full');
    expect(d.pending).toBe(false);
  });
});
