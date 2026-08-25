import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileAt, writeFileAt } from './files.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-files-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readFileAt', () => {
  it('returns the text and a stamp', () => {
    writeFileSync(join(root, 'a.ts'), 'hello\n');
    const read = readFileAt(root, 'a.ts');
    expect(read).toMatchObject({ text: 'hello\n' });
    expect('stamp' in read && read.stamp.size).toBe(6);
  });

  it('refuses a path that escapes the root', () => {
    // A path is a string from a renderer. `../` in it is a request to read
    // somewhere the pane was never opened on.
    expect(readFileAt(root, '../outside.ts')).toEqual({ error: 'outside the root' });
  });

  it('refuses an escape that has no leading ..', () => {
    // `a/../../b` contains no leading `..` and still leaves the root, which is
    // why the guard resolves and compares rather than pattern-matching.
    expect(readFileAt(root, 'a/../../outside.ts')).toEqual({ error: 'outside the root' });
  });

  it('refuses an absolute path', () => {
    expect(readFileAt(root, '/etc/hosts')).toEqual({ error: 'outside the root' });
  });

  it('reports a missing file rather than throwing', () => {
    expect(readFileAt(root, 'nope.ts')).toMatchObject({ error: expect.any(String) });
  });
});

describe('writeFileAt', () => {
  it('writes when the stamp still matches', () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    const wrote = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    expect(wrote).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('REFUSES when the file changed underneath, and does not write', () => {
    // The case this whole design exists for: an agent edited the file between
    // the read and the save.
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    writeFileSync(join(root, 'a.ts'), 'AGENT WROTE THIS\n');

    const wrote = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    expect(wrote).toEqual({ error: 'stale' });
    // The agent's work is still there. This is the assertion that matters.
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('AGENT WROTE THIS\n');
  });

  it('REFUSES on a same-size change, which mtime is the only witness to', () => {
    // `one\n` → `two\n` is the same length. Size alone would call this fresh.
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    writeFileSync(join(root, 'a.ts'), 'two\n');
    // Force a distinct mtime. A write inside the same filesystem tick can
    // otherwise carry the same timestamp — a real race, and the reason this
    // test sets the time explicitly rather than sleeping and hoping.
    const later = new Date(read.stamp.mtimeMs + 5_000);
    utimesSync(join(root, 'a.ts'), later, later);

    expect(writeFileAt(root, 'a.ts', 'three\n', read.stamp)).toEqual({ error: 'stale' });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('writes a file that does not exist yet', () => {
    // Absent is not stale. A new file has nothing to have moved under us.
    const wrote = writeFileAt(root, 'new.ts', 'fresh\n', { mtimeMs: 0, size: 0 });
    expect(wrote).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('fresh\n');
  });

  it('returns a NEW stamp, so a second save in the same session is not stale', () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    const first = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    if (!('stamp' in first)) throw new Error('first write refused');
    const second = writeFileAt(root, 'a.ts', 'three\n', first.stamp);
    expect(second).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('three\n');
  });

  it('refuses a path that escapes the root, and writes nothing', () => {
    expect(writeFileAt(root, '../outside.ts', 'x', { mtimeMs: 0, size: 0 })).toEqual({
      error: 'outside the root',
    });
  });
});
