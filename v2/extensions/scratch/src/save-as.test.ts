import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAs } from './save-as.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scratch-saveas-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('saveAs', () => {
  it('writes the text', () => {
    expect(saveAs(root, 'notes.md', 'hello\n')).toEqual({ ok: true });
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('hello\n');
  });

  it('creates the parent directories', () => {
    expect(saveAs(root, 'docs/plans/notes.md', 'hello\n')).toEqual({ ok: true });
    expect(readFileSync(join(root, 'docs/plans/notes.md'), 'utf8')).toBe('hello\n');
  });

  it('REFUSES to overwrite an existing file', () => {
    // Saving a note is CREATING a document, not replacing one. Silently
    // clobbering a file the user already has is a different verb.
    writeFileSync(join(root, 'notes.md'), 'mine\n');
    expect(saveAs(root, 'notes.md', 'new\n')).toEqual({ ok: false, reason: 'already exists' });
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses a path that escapes the root, and writes nothing', () => {
    expect(saveAs(root, '../escape.md', 'x')).toEqual({ ok: false, reason: 'outside the root' });
    expect(existsSync(join(root, '../escape.md'))).toBe(false);
  });

  it('refuses an escape with no leading ..', () => {
    expect(saveAs(root, 'a/../../escape.md', 'x')).toEqual({
      ok: false,
      reason: 'outside the root',
    });
  });

  it('refuses an absolute path', () => {
    expect(saveAs(root, '/tmp/escape.md', 'x')).toEqual({
      ok: false,
      reason: 'outside the root',
    });
  });
});
