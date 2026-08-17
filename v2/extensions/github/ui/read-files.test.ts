import { describe, expect, it } from 'vitest';
import { readFiles } from './review-data.ts';

/**
 * This reader dropped fields twice, one layer apart, and both times the symptom
 * was a renamed file claiming its contents were identical. A reader that names
 * fields silently loses the ones nobody added, so the model growing is exactly
 * when it needs a test.
 */
describe('readFiles', () => {
  it('carries what a rename is made of', () => {
    const [file] = readFiles([
      { path: 'new.ts', added: 0, removed: 0, status: 'renamed', previousPath: 'old.ts' },
    ]);
    expect(file?.status).toBe('renamed');
    expect(file?.previousPath).toBe('old.ts');
  });

  it('carries the patch, and leaves it absent when there is none', () => {
    const [withPatch] = readFiles([{ path: 'a.ts', added: 1, removed: 0, patch: '@@ -1 +1 @@' }]);
    const [without] = readFiles([{ path: 'b.ts', added: 1, removed: 0 }]);
    expect(withPatch?.patch).toBe('@@ -1 +1 @@');
    expect(without?.patch).toBeUndefined();
  });

  it('drops an entry with no path, because nothing can address it', () => {
    expect(readFiles([{ added: 1, removed: 0 }, 'nonsense', null])).toEqual([]);
  });

  it('answers empty for anything that is not a list', () => {
    // It reads an answer off a port: `ok` says the call succeeded, not that the
    // value has a shape.
    expect(readFiles(undefined)).toEqual([]);
    expect(readFiles({ files: [] })).toEqual([]);
  });
});
