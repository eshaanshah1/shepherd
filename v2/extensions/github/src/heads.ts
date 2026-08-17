import type { ProcessAPI } from '@shepherd/sdk';

/**
 * The commit a task's checkout is on — the one input `model/ownership.ts` needs
 * to tell this task's merged PR from a stranger's on a branch of the same name.
 *
 * Deliberately NOT memoized, which is the opposite of `Remotes` next door and
 * for the opposite reason: a repo's `origin` is set at clone and edited about
 * once a career, while HEAD moves every time an agent commits. A cached HEAD
 * would judge today's PRs against yesterday's work, and the whole point of the
 * read is to be current. It stays affordable because `needsHead` asks first —
 * an ordinary task, whose PRs are all open, never gets here at all.
 *
 * `rev-parse` is read-only in the sense that matters: unlike `git status` it
 * does not refresh and rewrite the index, so it cannot wake a filesystem watcher
 * that then runs it again.
 */
export function readHead(process: ProcessAPI, repoPath: string): Promise<string | null> {
  return process
    .gitRead(['rev-parse', 'HEAD'], {
      cwd: repoPath,
      // The same two seconds `Remotes` allows itself, for the same reason: a
      // checkout on a stalled network mount must not hold a sync open.
      timeoutMs: 2_000,
    })
    .then((result) => {
      // An empty repo, a directory that has gone, a worktree not yet
      // provisioned: each exits non-zero, and each is "cannot judge" rather than
      // a failure worth a word on screen. `isTaskWork` reads null as "keep".
      if (!result.ok) return null;
      const oid = result.stdout.trim();
      return oid === '' ? null : oid;
    })
    .catch(() => null);
}
