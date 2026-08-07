import { describe, expect, it } from 'vitest';
import { slugify, uniqueSlug } from './slug.ts';

/**
 * The slug names a real directory (`~/.shepherd/tasks/<slug>/`), so every test
 * here is really asking one question: can this string hurt a filesystem, and can
 * two different tasks ever end up pointing at one folder.
 */

describe('slugify', () => {
  it('lowercases and hyphenates ordinary prose', () => {
    expect(slugify('Fix the login flow')).toBe('fix-the-login-flow');
  });

  it('collapses runs of punctuation into a single separator', () => {
    expect(slugify('fix   the // login!!! flow')).toBe('fix-the-login-flow');
  });

  it('trims separators from both ends', () => {
    expect(slugify('...leading and trailing...')).toBe('leading-and-trailing');
  });

  it('keeps digits, which carry meaning in issue-shaped titles', () => {
    expect(slugify('PR 1423 follow-up')).toBe('pr-1423-follow-up');
  });

  it.each([
    ['', 'a title of nothing'],
    ['   ', 'whitespace only'],
    ['///', 'punctuation only'],
    ['???', 'non-alphanumeric only'],
    ['🐑🐑', 'emoji only — every character is dropped'],
  ])('falls back rather than returning an empty directory name: %j (%s)', (title) => {
    expect(slugify(title)).toBe('task');
  });

  it.each([
    ['.', 'the current directory'],
    ['..', 'the PARENT directory — the one that escapes the tasks root'],
  ])('never produces %j (%s)', (title) => {
    const slug = slugify(title);
    expect(slug).not.toBe('.');
    expect(slug).not.toBe('..');
    expect(slug).toBe('task');
  });

  it('cannot produce a path separator, so a title can never traverse', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('a/b/c')).toBe('a-b-c');
  });

  it('bounds the length, because a task root nests repo names beneath it', () => {
    const slug = slugify('x'.repeat(500));
    expect(slug.length).toBeLessThanOrEqual(60);
    // Truncation must not leave the separator it cut through.
    expect(slug.endsWith('-')).toBe(false);
  });

  it('does not end in a separator after truncating mid-word', () => {
    const slug = slugify(`${'a'.repeat(59)} bbbb`);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the desired slug when nothing holds it', () => {
    expect(uniqueSlug('fix-login', new Set())).toBe('fix-login');
  });

  it('suffixes rather than reusing a taken slug — two tasks, two folders', () => {
    expect(uniqueSlug('fix-login', new Set(['fix-login']))).toBe('fix-login-2');
  });

  it('keeps counting past the first collision', () => {
    const taken = new Set(['fix-login', 'fix-login-2', 'fix-login-3']);
    expect(uniqueSlug('fix-login', taken)).toBe('fix-login-4');
  });

  it('does not mistake an unrelated longer slug for a collision', () => {
    expect(uniqueSlug('fix', new Set(['fix-login']))).toBe('fix');
  });

  it('respects the length bound when it appends a suffix', () => {
    const long = 'x'.repeat(60);
    expect(uniqueSlug(long, new Set([long])).length).toBeLessThanOrEqual(60);
  });

  it('still yields something unique when the bound forces a truncation', () => {
    const long = 'x'.repeat(60);
    const taken = new Set([long, uniqueSlug(long, new Set([long]))]);
    const third = uniqueSlug(long, taken);
    expect(taken.has(third)).toBe(false);
  });
});
