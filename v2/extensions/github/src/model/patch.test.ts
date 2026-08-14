import { describe, expect, it } from 'vitest';
import { hunksOf, isLineInDiff, unifiedPatch } from './patch.ts';

/**
 * The adaptation a real diff renderer forced, and it is worth its own test
 * because the failure was silent-looking: `PatchDiff` threw *"Provided patch
 * must contain exactly 1 file diff"* for a patch that looked perfectly fine to
 * a human, because GitHub sends hunks with no file header at all.
 */

const hunks = '@@ -58,4 +58,11 @@\n context\n+added\n-gone';

describe('unifiedPatch', () => {
  it('gives GitHub’s hunks the header every reader needs', () => {
    const patch = unifiedPatch({ path: 'src/tree.ts', added: 1, removed: 1, patch: hunks });
    expect(patch).toBe(
      ['diff --git a/src/tree.ts b/src/tree.ts', '--- a/src/tree.ts', '+++ b/src/tree.ts', hunks].join('\n'),
    );
  });

  it('leaves a patch that already has one alone, rather than heading it twice', () => {
    const whole = `diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunks}`;
    expect(unifiedPatch({ path: 'x', added: 1, removed: 1, patch: whole })).toBe(whole);
  });

  it('answers null when there is no patch, which is the ordinary case on a poll', () => {
    // Patches are fetched only when the Files tab asks; every other read has none.
    expect(unifiedPatch({ path: 'x', added: 1, removed: 0 })).toBeNull();
    expect(unifiedPatch({ path: 'x', added: 1, removed: 0, patch: '' })).toBeNull();
  });

  it('does NOT guess at a new or deleted file', () => {
    // git marks those with `new file mode` / `deleted file mode`, and inventing
    // one from a line count would label a file that merely has no deletions as
    // newly added.
    const added = unifiedPatch({ path: 'x', added: 9, removed: 0, patch: hunks });
    expect(added).not.toContain('new file mode');
    const gone = unifiedPatch({ path: 'x', added: 0, removed: 9, patch: hunks });
    expect(gone).not.toContain('deleted file mode');
  });
});

describe('hunksOf', () => {
  it('reads both sides of a hunk header', () => {
    expect(hunksOf('@@ -58,4 +58,11 @@ context')).toEqual([
      { removedStart: 58, removedCount: 4, addedStart: 58, addedCount: 11 },
    ]);
  });

  it('reads the count-less form, which means one', () => {
    // `@@ -1 +1 @@` is legal and common for a single-line change.
    expect(hunksOf('@@ -1 +1 @@')).toEqual([{ removedStart: 1, removedCount: 1, addedStart: 1, addedCount: 1 }]);
  });

  it('finds every hunk in a multi-hunk patch, and nothing else', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' a', '+b', '@@ -40,1 +41,1 @@', '-c', '+d'].join('\n');
    expect(hunksOf(patch)).toHaveLength(2);
    // A line that merely starts with `@` is not a header.
    expect(hunksOf('@decorator\n@@ nope')).toEqual([]);
  });
});

describe('isLineInDiff', () => {
  const patch = '@@ -58,4 +58,11 @@\n context';

  /**
   * The question a review comment forces. A thread naming a file is not the
   * same as a thread the diff can SHOW: its line may have moved out of the
   * change since it was written. Pinning it anyway puts the remark against
   * whatever code now occupies that line number.
   */
  it('answers for the side the comment was left on', () => {
    expect(isLineInDiff(patch, 'right', 61)).toBe(true);
    expect(isLineInDiff(patch, 'right', 68)).toBe(true);
    expect(isLineInDiff(patch, 'right', 69)).toBe(false);
    // The old side is a different range entirely — 58..61.
    expect(isLineInDiff(patch, 'left', 61)).toBe(true);
    expect(isLineInDiff(patch, 'left', 62)).toBe(false);
  });

  it('is exclusive at the end, so a count of 4 covers four lines', () => {
    expect(isLineInDiff('@@ -1,4 +1,4 @@', 'right', 4)).toBe(true);
    expect(isLineInDiff('@@ -1,4 +1,4 @@', 'right', 5)).toBe(false);
  });

  it('says no for a patch with no hunks at all', () => {
    expect(isLineInDiff('', 'right', 1)).toBe(false);
  });
});
