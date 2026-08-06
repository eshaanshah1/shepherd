import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from './result.ts';

describe('Result', () => {
  it('narrows through isOk / isErr', () => {
    const good = ok(7);
    const bad = err('nope');

    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);

    if (isOk(good)) expect(good.value).toBe(7);
    if (isErr(bad)) expect(bad.error).toBe('nope');
  });

  it('unwrap yields the value, or throws with the error in the message', () => {
    expect(unwrap(ok('x'))).toBe('x');
    expect(() => unwrap(err('disk full'))).toThrowError(/disk full/);
  });
});
