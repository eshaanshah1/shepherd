/**
 * One level of path completion — where to look, and what to match there.
 *
 * **Strictly one `readdir`, never a walk.** Measured on this machine: one level
 * of `~/Home` is 7 entries and of `~` is 19, both under 12ms, so a listing per
 * keystroke is free. A recursive index is what would make this sluggish, and it
 * buys nothing a second keystroke does not — so there is no crawler, no cache
 * and no background pass anywhere in this feature.
 *
 * The rule, which is the whole of it: **if what you have typed IS a directory,
 * list its children; otherwise list its parent and match the last segment.**
 *
 *   `~/Home`  or `~/Home/`   → everything directly inside `~/Home`
 *   `~/Home/dev/sh`          → `~/Home/dev/*`, fuzzy-matched against `sh`
 *   `~/Ho`                   → `~/*`, fuzzy-matched against `Ho`
 *
 * With one carve-out: **home itself is never enumerated with an empty match.**
 * `~/` is what the field looks like the moment anyone starts typing a path, and
 * answering it with every directory in the home folder is answering a question
 * nobody asked — it is the state that means "I have not told you anything yet",
 * and the honest reply is the history. `~/H` is a different thing and does list.
 *
 * Dot-directories are deliberately kept: they are one of the reasons you are
 * typing a path by hand rather than picking from a list.
 *
 * `isDirectory` is injected rather than imported, so this stays pure and the
 * whole rule above is testable without a temp tree.
 */

export interface CompletionTarget {
  /** The single directory to list. Absolute, no trailing slash (except `/`). */
  readonly dir: string;
  /** What to fuzzy-match against the entries. Empty means "show them all". */
  readonly partial: string;
}

export interface CompletionInput {
  /** What the user typed, with `~` already expanded. */
  readonly path: string;
  /** The home directory, for the carve-out above. */
  readonly home: string;
  readonly isDirectory: (path: string) => boolean;
}

/** Trailing slashes off, but never turn `/` into the empty string. */
function withoutTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function completionTarget({ path, home, isDirectory }: CompletionInput): CompletionTarget | null {
  const typed = path.trim();
  if (typed === '') return null;

  let target: CompletionTarget;
  if (isDirectory(typed)) {
    target = { dir: withoutTrailingSlash(typed), partial: '' };
  } else {
    const cut = typed.lastIndexOf('/');
    // No separator at all is a bare word, which names no directory to look in.
    // Completing it against the process's cwd would be completing against a
    // directory the user cannot see and did not choose.
    if (cut === -1) return null;
    target = {
      dir: withoutTrailingSlash(typed.slice(0, cut + 1)),
      partial: typed.slice(cut + 1),
    };
  }

  if (target.partial === '' && target.dir === withoutTrailingSlash(home)) return null;
  if (!isDirectory(target.dir)) return null;
  return target;
}
