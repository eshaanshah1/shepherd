/**
 * The repo a shell's cwd is inside — the argument `tasks.create` actually takes.
 *
 * **`name` as well as `path`**, because `repoArg` requires both, and the name is
 * the repo directory's basename rather than the cwd's: a shell in
 * `relay/packages/ui` is working on `relay`, and a task rooted at `packages/ui`
 * would try to make a worktree of a directory with no `.git`. So this WALKS UP.
 *
 * Pure and total, with the filesystem injected — the same shape `tasks`'
 * `suggest.ts` uses for `isDirectory`. That is what keeps the walk testable
 * against a fake tree, and it is why this needs no `process.exec`: asking git for
 * `--show-toplevel` would mean granting the heaviest permission in the system for
 * one convenience verb, and the question is answerable by looking.
 */
export interface RepoRef {
  readonly path: string;
  readonly name: string;
}

/**
 * `isRepo` answers whether a path holds a `.git` entry — a DIRECTORY in a normal
 * clone and a FILE in a linked worktree, which is why the caller asks whether it
 * exists at all rather than what kind it is (`suggest.ts` records the same).
 */
export function repoAt(cwd: string, isRepo: (path: string) => boolean): RepoRef | null {
  // A cwd crossed a port. A relative one would make the walk below unbounded.
  if (!cwd.startsWith('/')) return null;

  let at = cwd.replace(/(?!^)\/+$/, '');
  while (at !== '' && at !== '/') {
    if (isRepo(at)) {
      const name = at.slice(at.lastIndexOf('/') + 1);
      // A repo has to be nameable to be a task's repo, and every path that
      // reaches here does — the loop has already excluded `/`.
      return name === '' ? null : { path: at, name };
    }
    at = at.slice(0, at.lastIndexOf('/'));
  }
  /*
   * The filesystem root is deliberately not a candidate, even if it holds a
   * `.git`: it has no basename to be a repo name, and a task rooted at `/` is
   * never what anyone meant.
   */
  return null;
}
