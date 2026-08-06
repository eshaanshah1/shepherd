import { describe, expect, it } from 'vitest';
import { disposeAll, toDisposable } from './disposable.ts';

describe('toDisposable', () => {
  it('runs the cleanup exactly once however often it is disposed', () => {
    let count = 0;
    const d = toDisposable(() => {
      count += 1;
    });
    d.dispose();
    d.dispose();
    expect(count).toBe(1);
  });
});

describe('disposeAll', () => {
  it('disposes in reverse registration order and empties the list', () => {
    const seen: string[] = [];
    const items = [
      toDisposable(() => seen.push('first')),
      toDisposable(() => seen.push('second')),
    ];
    disposeAll(items);
    expect(seen).toEqual(['second', 'first']);
    expect(items).toHaveLength(0);
  });

  it('disposes the rest even when one throws, then rethrows the first error', () => {
    const seen: string[] = [];
    const items = [
      toDisposable(() => seen.push('a')),
      toDisposable(() => {
        throw new Error('boom');
      }),
      toDisposable(() => seen.push('c')),
    ];
    expect(() => disposeAll(items)).toThrowError('boom');
    expect(seen).toEqual(['c', 'a']);
  });
});
