/**
 * Which `git worktree add` to run — the pure decision, separated from running it.
 *
 * This is the file D12b is about: v1's version of this decision had a **silent
 * bug**, and a bug you cannot see is exactly the kind worth making testable.
 *
 * v1 asked one question — does `refs/heads/<name>` exist — and branched two ways.
 * For a branch that exists only on a remote the answer is "no", so v1 created a
 * new branch off origin's default *under that name*. git exits 0. The worktree
 * holds the default branch's content, the upstream points at the wrong branch,
 * nothing errors, and the first symptom is a `git push` failing much later with
 * `fatal: The upstream branch of your current branch does not match the name of
 * your current branch`. Measured in probe 2, then verified in v1's source.
 *
 * So there are **three** cases, not two, and a fourth that is a refusal:
 *
 *   1. the branch exists locally      → check it out
 *   2. it exists only on a remote     → create it TRACKING that remote branch
 *   3. it exists nowhere              → create it off a base
 *   4. it is checked out already      → refuse, because a branch belongs to one
 *                                       worktree and `--force` would hand two
 *                                       worktrees the same branch
 *
 * Two more things measured here rather than assumed. **No fetch precondition**:
 * v1 ran `git fetch origin` first and aborted if it failed, which makes a repo
 * with no remote — or an offline machine — unusable, and its last-resort base was
 * the literal `origin/main`, an invalid ref in such a repo. `HEAD` is the honest
 * fallback. And **never git's DWIM form**: `worktree add <path>` with no branch
 * derives the branch from the path's basename, which under
 * `<root>/<slug>/<repo>` is the *repo* name.
 */

export interface RepoRefs {
  /** Short names under `refs/heads/`. */
  readonly localBranches: readonly string[];
  /** Remote-qualified names, e.g. `origin/fix-login`. Any remote, not just origin. */
  readonly remoteBranches: readonly string[];
  /** Branches already checked out by some worktree of this repo. */
  readonly checkedOutBranches: readonly string[];
  /** Origin's default as a start point, when it is known. Absent is normal. */
  readonly defaultBase: string | undefined;
}

export type BranchPlan =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function resolveBranch(name: string, dest: string, refs: RepoRefs): BranchPlan {
  if (refs.checkedOutBranches.includes(name)) {
    return {
      ok: false,
      reason:
        `branch "${name}" is already checked out by another worktree of this repo. ` +
        `A branch belongs to one worktree at a time.`,
    };
  }

  if (refs.localBranches.includes(name)) {
    return { ok: true, args: ['worktree', 'add', dest, name] };
  }

  // Case 2 — the one v1 got wrong. Matched by SUFFIX so it works for any remote,
  // and matched exactly (`/<name>`) so `fix` does not match `origin/fix-login`.
  const remote = refs.remoteBranches.find((ref) => ref.endsWith(`/${name}`));
  if (remote !== undefined) {
    return { ok: true, args: ['worktree', 'add', '--track', '-b', name, dest, remote] };
  }

  // `HEAD` rather than a guessed `origin/main`: the base only has to be a valid
  // start point, and in a repo with no remote it is the only one that exists.
  return { ok: true, args: ['worktree', 'add', dest, '-b', name, refs.defaultBase ?? 'HEAD'] };
}
