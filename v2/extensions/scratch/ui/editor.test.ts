import { describe, expect, it } from 'vitest';
import { openable, urlAt } from './editor.ts';

describe('openable', () => {
  it('accepts http and https', () => {
    expect(openable('https://example.com')).toBe(true);
    expect(openable('http://example.com')).toBe(true);
  });

  it('refuses file, and every other scheme', () => {
    // The URL came from the user's own typing, so the question is what open(1)
    // is being asked to launch.
    for (const url of ['file:///etc/passwd', 'ftp://x', 'javascript:alert(1)', 'x-devonthink://x', '/etc/passwd']) {
      expect(openable(url), url).toBe(false);
    }
  });
});

describe('urlAt', () => {
  it('finds the destination of an inline link', () => {
    expect(urlAt('see [docs](https://x.com) now', 0, 6)).toBe('https://x.com');
  });

  it('finds a bare URL', () => {
    expect(urlAt('see https://x.com now', 0, 6)).toBe('https://x.com');
  });

  it('offsets by the line start', () => {
    expect(urlAt('[a](https://x.com)', 100, 102)).toBe('https://x.com');
  });

  it('is undefined where there is no link', () => {
    expect(urlAt('nothing here', 0, 3)).toBeUndefined();
  });

  it('picks the link the position is inside, not the first on the line', () => {
    const line = '[one](https://one.com) and [two](https://two.com)';
    expect(urlAt(line, 0, 30)).toBe('https://two.com');
  });

  it('ignores a link title after the URL', () => {
    expect(urlAt('[a](https://x.com "the title")', 0, 2)).toBe('https://x.com');
  });
});
