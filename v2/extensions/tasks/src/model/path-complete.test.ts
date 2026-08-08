import { describe, expect, it } from 'vitest';
import { commonPrefix, completionTarget } from './path-complete.ts';

const HOME = '/Users/eshaan';

/** A fake tree, so the rule is testable without touching a disk. */
const DIRS = new Set([
  '/',
  HOME,
  `${HOME}/Home`,
  `${HOME}/Home/dev`,
  `${HOME}/Home/dev/shepherd`,
  `${HOME}/Downloads`,
]);

const target = (path: string) =>
  completionTarget({ path, home: HOME, isDirectory: (candidate) => DIRS.has(candidate) });

describe('completionTarget', () => {
  it('lists the children of what you typed, when what you typed IS a directory', () => {
    expect(target(`${HOME}/Home`)).toEqual({ dir: `${HOME}/Home`, partial: '' });
    expect(target(`${HOME}/Home/`)).toEqual({ dir: `${HOME}/Home`, partial: '' });
  });

  it('lists the parent and matches the last segment, when what you typed is partial', () => {
    expect(target(`${HOME}/Home/dev/sh`)).toEqual({ dir: `${HOME}/Home/dev`, partial: 'sh' });
    expect(target(`${HOME}/Ho`)).toEqual({ dir: HOME, partial: 'Ho' });
  });

  it('never enumerates home itself on a bare `~/`', () => {
    // The state that means "I have not told you anything yet". The honest answer
    // is the history, not every directory in the home folder.
    expect(target(`${HOME}/`)).toBeNull();
    expect(target(HOME)).toBeNull();
  });

  it('does list home once you have typed something to match against it', () => {
    expect(target(`${HOME}/D`)).toEqual({ dir: HOME, partial: 'D' });
  });

  it('answers nothing for an empty field, or for a bare word with no separator', () => {
    // A word with no `/` names no directory to look in, and completing it
    // against the process cwd would complete against a directory the user
    // cannot see and did not choose.
    expect(target('')).toBeNull();
    expect(target('   ')).toBeNull();
    expect(target('shepherd')).toBeNull();
  });

  it('answers nothing when the parent does not exist', () => {
    expect(target('/nowhere/at/all')).toBeNull();
  });

  it('keeps `/` as a directory rather than reducing it to the empty string', () => {
    expect(target('/Us')).toEqual({ dir: '/', partial: 'Us' });
  });

  it('is one level and only one level', () => {
    // The property the whole feature rests on: whatever you type, the answer
    // names exactly ONE directory to read.
    const deep = target(`${HOME}/Home/dev/sh`);
    expect(deep?.dir).toBe(`${HOME}/Home/dev`);
    expect(deep?.partial).not.toContain('/');
  });
});

describe('commonPrefix', () => {
  it('is the whole string when there is one candidate', () => {
    expect(commonPrefix(['/a/b/dev'])).toBe('/a/b/dev');
  });

  it('advances as far as the answer is unambiguous', () => {
    expect(commonPrefix(['/a/dev', '/a/devops'])).toBe('/a/dev');
  });

  it('is empty when the candidates share nothing', () => {
    expect(commonPrefix(['alpha', 'beta'])).toBe('');
  });

  it('is empty for no candidates', () => {
    expect(commonPrefix([])).toBe('');
  });

  it('is case-sensitive, because a path is', () => {
    expect(commonPrefix(['/a/Dev', '/a/dev'])).toBe('/a/');
  });
});
