import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * `node:fs` directly, and no permission for it: fs and path are stdlib, and the
 * grant that names a consequence here is `process.exec`, which this extension
 * holds for git. `extensions/scratch/src/install.ts` records the same reasoning.
 */

/**
 * What a file looked like when we read it.
 *
 * mtime AND size, because either alone lies. A same-length edit (`one` → `two`)
 * leaves the size identical; a filesystem with coarse timestamps can leave the
 * mtime identical across two writes in the same tick. Together they are wrong
 * only for an edit that is byte-identical in LENGTH within one tick — a
 * collision this design accepts, because the alternative is hashing every file
 * on every read.
 */
export interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ReadFile {
  readonly text: string;
  readonly stamp: Stamp;
}

export interface IoError {
  readonly error: string;
}

/**
 * A path from the renderer is a STRING, and `../` in it is a request to leave
 * the directory the pane was opened on.
 *
 * Resolved and compared rather than pattern-matched: `a/../../b` contains no
 * leading `..` and still escapes.
 */
function inside(root: string, rel: string): string | undefined {
  if (isAbsolute(rel)) return undefined;
  const full = resolve(join(root, rel));
  const back = relative(resolve(root), full);
  // `''` is the root itself, which is a directory and not a file to read.
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return undefined;
  return full;
}

function stampOf(full: string): Stamp {
  const stat = statSync(full);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

export function readFileAt(root: string, rel: string): ReadFile | IoError {
  const full = inside(root, rel);
  if (full === undefined) return { error: 'outside the root' };
  try {
    // The stamp is taken BEFORE the read, so a write landing between the two
    // makes the next save stale rather than making this read look current.
    const stamp = stampOf(full);
    return { text: readFileSync(full, 'utf8'), stamp };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'could not read' };
  }
}

/**
 * Write, unless the file moved under us.
 *
 * **The refusal is the feature.** An agent is editing this worktree while the
 * user is, and a save that overwrote its work would do so silently and
 * constantly. There is no merge and no "which one wins" prompt that discards
 * the loser unseen: the answer is `stale`, and the pane offers a reload.
 *
 * A file that does not exist yet is not stale — it is new.
 */
export function writeFileAt(
  root: string,
  rel: string,
  text: string,
  stamp: Stamp,
): { readonly stamp: Stamp } | IoError {
  const full = inside(root, rel);
  if (full === undefined) return { error: 'outside the root' };

  let current: Stamp | undefined;
  try {
    current = stampOf(full);
  } catch {
    current = undefined;
  }
  if (current !== undefined && (current.mtimeMs !== stamp.mtimeMs || current.size !== stamp.size)) {
    return { error: 'stale' };
  }

  try {
    writeFileSync(full, text, 'utf8');
    // A FRESH stamp, so the next ⌘S in the same session is not refused by the
    // write this one just made.
    return { stamp: stampOf(full) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'could not write' };
  }
}
