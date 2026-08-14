import type { ChangedFile } from './pr.ts';

/**
 * GitHub's `patch` → a patch a diff renderer will accept.
 *
 * GitHub gives the HUNKS and nothing else: `@@ -58,4 +58,11 @@` and the lines
 * under it, with no file header at all. Every unified-diff reader wants the
 * header — it is where the path comes from, and without it a renderer cannot
 * say which file it is drawing. `@pierre/diffs` refuses outright: *"Provided
 * patch must contain exactly 1 file diff"*, which is the whole reason this
 * function exists rather than the field being passed straight through.
 *
 * So the header is synthesised from what we know. `a/` and `b/` are git's own
 * prefixes and a renderer strips them; the rest is the smallest header that
 * parses.
 *
 * ── the cases that are not a plain edit ──────────────────────────────────────
 *
 * A file with no removals may be new and a file with no additions may be gone,
 * and this **does not guess**: git marks those with `new file mode` /
 * `deleted file mode` lines, and inventing one from a line count would label a
 * file that merely happens to have no deletions as newly added. Drawn as an
 * ordinary edit, a new file reads as a file whose every line is an addition —
 * which is what it is.
 */
export function unifiedPatch(file: ChangedFile): string | null {
  if (file.patch === undefined || file.patch === '') return null;
  // Already a full patch — GitHub does not send one, but a caller reading from
  // `git diff` would, and re-heading it would produce two.
  if (file.patch.startsWith('diff --git')) return file.patch;

  const header = [
    `diff --git a/${file.path} b/${file.path}`,
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
  ].join('\n');
  return `${header}\n${file.patch}`;
}

/**
 * One hunk's line ranges, on both sides.
 *
 * Parsed from the `@@ -58,4 +58,11 @@` header, which is the only place a patch
 * says where its lines are. A count is optional in that syntax and means one —
 * `@@ -1 +1 @@` is legal and common for a single-line change.
 */
export interface Hunk {
  readonly removedStart: number;
  readonly removedCount: number;
  readonly addedStart: number;
  readonly addedCount: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunksOf(patch: string): readonly Hunk[] {
  return patch.split('\n').flatMap((line): Hunk[] => {
    const match = HUNK.exec(line);
    if (match === null) return [];
    return [
      {
        removedStart: Number(match[1]),
        removedCount: match[2] === undefined ? 1 : Number(match[2]),
        addedStart: Number(match[3]),
        addedCount: match[4] === undefined ? 1 : Number(match[4]),
      },
    ];
  });
}

/**
 * Is this line actually IN the diff?
 *
 * The question a review comment forces, and the reason it is asked rather than
 * assumed: **a thread naming a file is not the same as a thread the diff can
 * show.** Its line may have moved out of the change since it was written, or sit
 * in a hunk nobody asked for. Pinning it anyway puts the remark against whatever
 * code now occupies that line number — a comment about a function attached to an
 * import, with nothing saying so.
 *
 * Both outcomes are drawn: a line inside a hunk becomes an annotation on that
 * line, and one outside it is listed above the diff as `not on this diff`.
 * Dropping the second would lose the conversation, which is the other half of
 * the same mistake — and it is v1's recorded workbench behaviour arriving here
 * for the same reason.
 */
export function isLineInDiff(patch: string, side: 'left' | 'right', line: number): boolean {
  return hunksOf(patch).some((hunk) =>
    side === 'left'
      ? line >= hunk.removedStart && line < hunk.removedStart + hunk.removedCount
      : line >= hunk.addedStart && line < hunk.addedStart + hunk.addedCount,
  );
}
