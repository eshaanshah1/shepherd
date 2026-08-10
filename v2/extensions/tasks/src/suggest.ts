import { readdirSync, statSync } from 'node:fs';
import { fuzzyMatch } from '@shepherd/sdk';
import { completionTarget } from './model/path-complete.ts';

/**
 * The filesystem half of the repo picker — one `readdir`, and nothing else.
 *
 * `path-complete.ts` decides WHERE to look and WHAT to match there, and is pure
 * so that rule is testable without a disk. This is the part that has to touch
 * one, kept in its own file for the same reason `provision.ts` is: it is the
 * only place in the feature that can fail because of the machine.
 *
 * **No index, no cache, no crawler.** A directory listing is ~10ms here, which
 * is cheaper than the keystroke that asked for it, and the alternative is a
 * background pass keeping a copy of the filesystem that is wrong the moment
 * anybody runs `git clone`.
 */

export interface DirCandidate {
  readonly path: string;
  /** Whether it holds a `.git`. Marked, never used to exclude — see `index.ts`. */
  readonly isRepo: boolean;
  readonly score: number;
  /** Which characters of `path` the query hit — the field paints these. */
  readonly positions: readonly number[];
}

/** `statSync` rather than `existsSync`, so a file named like a directory is not one. */
function isDirectory(path: string): boolean {
  // `throwIfNoEntry: false` is the whole reason this is stat and not lstat in a
  // try/catch: a path that does not exist is the ORDINARY case while somebody is
  // typing one, and it must not cost an exception per keystroke.
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Is this repo path a git repo?
 *
 * `.git` is a directory in a normal clone and a FILE in a linked worktree, so
 * this asks whether the entry exists at all rather than what kind it is.
 */
export function looksLikeRepo(path: string): boolean {
  return statSync(`${path}/.git`, { throwIfNoEntry: false }) !== undefined;
}

/**
 * The path as typed, when what you typed is itself a repo.
 *
 * `completionTarget` answers a path that IS a directory with its children, which
 * is right for a directory you are passing through and wrong for the one you
 * meant. Typing a repo's full path offered `.claude` — first child alphabetically
 * — and ⏎ takes the completion over the field, so the picker overrode the one
 * input that could not have been ambiguous, and the task was built on a
 * directory with no `.git`.
 *
 * A REPO rather than any directory, deliberately: a repo is a terminal choice
 * and a plain directory is a waypoint, so `~/dev/tools` still lists what is
 * under it and still completes with ↹.
 */
export function exactRepoPath(path: string): string | null {
  const typed = path.trim().replace(/(?!^)\/+$/, '');
  if (typed === '') return null;
  return isDirectory(typed) && looksLikeRepo(typed) ? typed : null;
}

/**
 * Complete one typed path against the filesystem, one level deep.
 *
 * `path` is expected home-expanded — `~` is a shell's job and `expandHome` is
 * where this codebase does it, once, for the field and the CLI flag alike.
 */
export function completeDirectories(path: string, home: string): readonly DirCandidate[] {
  const target = completionTarget({ path, home, isDirectory });
  if (target === null) return [];

  let entries: readonly string[];
  try {
    entries = readdirSync(target.dir, { withFileTypes: true })
      // A symlink to a directory is a directory here: a repo parked under a
      // linked folder is exactly the case somebody types a path by hand for.
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    // Unreadable (permissions, a directory that vanished mid-keystroke) is not
    // an error the picker reports — it is simply nothing to complete with.
    return [];
  }

  const prefix = target.dir === '/' ? '/' : `${target.dir}/`;
  const candidates: DirCandidate[] = [];
  for (const name of entries) {
    const hit = fuzzyMatch(target.partial, name);
    if (hit === null) continue;
    const full = `${prefix}${name}`;
    if (!isDirectory(full)) continue;
    candidates.push({
      path: full,
      isRepo: looksLikeRepo(full),
      score: hit.score,
      // The match happened against the NAME; the picker draws the whole path,
      // so the indices are shifted into it here rather than re-derived there.
      positions: hit.positions.map((at) => at + prefix.length),
    });
  }

  // Best match first, then alphabetical — which is the whole order for an empty
  // partial, where every entry scores zero.
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
