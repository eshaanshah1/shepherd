import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walk, WALK_MAX_ENTRIES } from './walk.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-walk-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walk', () => {
  it('lists files relative to the root', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'src', 'a.ts'), '');
    expect(walk(root).paths).toEqual(['README.md', 'src/a.ts']);
  });

  it('prunes .git', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), '');
    writeFileSync(join(root, 'a.ts'), '');
    expect(walk(root).paths).toEqual(['a.ts']);
  });

  it('keeps other dotfiles — .env is the reason this pane exists', () => {
    writeFileSync(join(root, '.env'), '');
    expect(walk(root).paths).toContain('.env');
  });

  it('stops at the cap and SAYS SO', () => {
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.ts`), '');
    const walked = walk(root, 3);
    expect(walked.paths).toHaveLength(3);
    // A truncated listing that does not announce itself reads as a complete
    // one, and the file you wanted is simply absent with no explanation.
    expect(walked.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', () => {
    writeFileSync(join(root, 'a.ts'), '');
    expect(walk(root, 3).truncated).toBe(false);
  });

  it('caps at 25,000 by default', () => {
    expect(WALK_MAX_ENTRIES).toBe(25_000);
  });

  it('is empty for an empty directory rather than throwing', () => {
    expect(walk(root)).toEqual({ paths: [], truncated: false });
  });
});
