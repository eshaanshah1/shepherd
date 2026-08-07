/**
 * Archiving a task's worktree — the decisions, not the git.
 *
 * v1's archive is **better than expected in the place everyone assumes it is
 * worse**: probe 2 ran it end-to-end on a fixture with staged edits, unstaged
 * edits, both-on-one-file, staged and unstaged deletions, and untracked files in
 * new directories, and `git status --porcelain` before and after is byte-
 * identical. The classic untracked-file gap is not there, because `add -A`
 * captures them into the worktree tree and `read-tree <staged>` excludes them on
 * the way back. That shape ports unchanged — two commits, pinned under
 * `refs/shepherd/…`, local-only.
 *
 * What it gets wrong is all here, and all measured:
 *
 *   - **A conflicted worktree cannot be archived at all.** `write-tree` fails
 *     with `fatal: git-write-tree: error building trees`, exit 128. v1 discovers
 *     this by failing inside git; we refuse up front, with the way out in the
 *     message. This is the case a user most wants — a task stopped mid-merge is
 *     exactly the one worth shelving.
 *   - **Gitignored files are silently destroyed.** `add -A` skips them, then
 *     `worktree remove --force` deletes them. `.env`, `node_modules`, build
 *     output — gone, no warning anywhere. They still go; the user is told first.
 *   - **A detached worktree restores to the wrong commit.** v1 kept only the
 *     branch and skipped `symbolic-ref` when it was empty, so HEAD came back as
 *     the *archive* commit. The sha is recorded beside the branch, and restore
 *     branches on which one it has.
 */

export interface WorktreeState {
  /** The checked-out branch, or `''` when the worktree is detached. */
  readonly branch: string;
  /** Where HEAD actually is — recorded because the branch may not exist. */
  readonly headSha: string;
  /** Whether anything is unmerged. `git write-tree` cannot run if so. */
  readonly hasConflicts: boolean;
  /** Ignored files that live here and will not survive. */
  readonly ignoredPaths: readonly string[];
}

/** What an archive must remember to put the worktree back where it was. */
export interface ArchiveRecord {
  readonly branch: string;
  readonly headSha: string;
}

export type ArchivePlan =
  | { readonly ok: true; readonly record: ArchiveRecord; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function planArchive(state: WorktreeState): ArchivePlan {
  if (state.hasConflicts) {
    return {
      ok: false,
      reason:
        'this worktree has unmerged files, and git cannot write a tree from a conflicted index. ' +
        'Resolve the conflicts, or finish or abort the merge/rebase/cherry-pick, then archive.',
    };
  }

  const warnings =
    state.ignoredPaths.length === 0
      ? []
      : [
          `${state.ignoredPaths.length} ignored file(s) will be DELETED and are not in the archive: ` +
            `${state.ignoredPaths.join(', ')}. Git-ignored files are not captured by the snapshot.`,
        ];

  return { ok: true, record: { branch: state.branch, headSha: state.headSha }, warnings };
}

/**
 * Where a restored worktree's HEAD goes.
 *
 * Two cases and no third: a branch to reattach, or a sha to detach onto. Doing
 * *nothing* — v1's behaviour for a detached worktree — leaves HEAD wherever the
 * restore machinery happened to put it, which is the archive commit.
 */
export function planRestore(record: ArchiveRecord): { readonly args: readonly string[] } {
  if (record.branch !== '') {
    return { args: ['symbolic-ref', 'HEAD', `refs/heads/${record.branch}`] };
  }
  return { args: ['checkout', '--detach', record.headSha] };
}
