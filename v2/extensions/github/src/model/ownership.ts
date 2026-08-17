import { isLive, type PullRequest } from './pr.ts';

/**
 * Whether a PR found by branch name is actually THIS task's work.
 *
 * The whole extension rests on one join: a task's slug is its branch, so "which
 * PRs belong to this task" is `pullRequests(headRefName: <slug>)` rather than a
 * guess. That join is right almost always and wrong in one specific way — a
 * branch NAME is not unique over time. `uniqueSlug` only dedupes against tasks
 * that currently exist, so a deleted task's slug is free again; a repo that
 * predates Shepherd has its own history of branch names; and a multi-repo task
 * asks the same name of every one of its repos. In each case GitHub answers
 * truthfully about a branch called `fix-login` and means somebody else's.
 *
 * What separates the two is the commit. A PR that is this task's work has the
 * task's own HEAD somewhere in it; one that merged before this task existed has
 * a HEAD it has never seen. So:
 *
 *   - **an open or draft PR always belongs.** Its head ref is a branch that
 *     exists right now, on the remote this task pushes to, under the name this
 *     task owns — two live PRs cannot share that, and treating one as foreign
 *     would hide the PR an agent just opened while it was still pushing to it.
 *   - **a merged or closed one belongs only if the task's HEAD is in it** —
 *     either its tip, or one of its commits (a branch updated from the web, or
 *     a merge queue's own commit, leaves HEAD inside the PR without being its
 *     tip).
 *
 * **A question this cannot answer is answered `true`.** No HEAD (git unreadable,
 * a worktree that has gone) and no `headOid` from GitHub both land there. The
 * failure modes are not symmetric: an extra merged PR on a row is noise a user
 * can read past, and a missing one reads as the integration being broken.
 */
export function isTaskWork(pr: PullRequest, headOid: string | null): boolean {
  if (isLive(pr)) return true;
  if (headOid === null || headOid === '') return true;
  if (pr.headOid === '') return true;
  return pr.headOid === headOid || pr.commits.some((commit) => commit.sha === headOid);
}

/**
 * The PRs of one repo that are this task's, and the ones dropped.
 *
 * Both halves, because a caller has to be able to SAY what it dropped. A silent
 * filter reads as "that is all of them", which is the same mistake as a silent
 * truncation — and this one hides a PR the user may well have been looking for.
 */
export function ownedByTask(
  prs: readonly PullRequest[],
  headOid: string | null,
): { readonly kept: readonly PullRequest[]; readonly dropped: readonly PullRequest[] } {
  const kept: PullRequest[] = [];
  const dropped: PullRequest[] = [];
  for (const pr of prs) (isTaskWork(pr, headOid) ? kept : dropped).push(pr);
  return { kept, dropped };
}

/**
 * Does judging this set need the task's HEAD at all?
 *
 * Reading HEAD is a subprocess, and the overwhelmingly common answer — a task
 * with one open PR, or with none — needs no judgement. Asked before the read so
 * the ordinary case costs nothing.
 */
export const needsHead = (prs: readonly PullRequest[]): boolean => prs.some((pr) => !isLive(pr));
