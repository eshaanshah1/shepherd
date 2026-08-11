import { describe, expect, it } from 'vitest';
import { CORE_NAMESPACE } from '@shepherd/sdk';
import { THEME_KEY } from './settings-keys.ts';

/**
 * The literal, pinned to the constant it mirrors.
 *
 * `settings-keys.ts` may not import a VALUE — the preload bundle loads it and a
 * runtime dependency there fails the whole window. So the prefix is written out,
 * and this is what keeps it honest. A test may import whatever it likes.
 */
describe('the app own setting keys', () => {
  it('sit in the kernel namespace, spelled the way the SDK spells it', () => {
    expect(THEME_KEY).toBe(`${CORE_NAMESPACE}.theme`);
  });

  it('are not in an extension namespace, which nothing may write to', () => {
    expect(THEME_KEY.startsWith(`${CORE_NAMESPACE}.`)).toBe(true);
  });
});
