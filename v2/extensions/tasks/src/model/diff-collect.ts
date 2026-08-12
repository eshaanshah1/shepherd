import {
  NO_DIFF,
  combineRepoDiff,
  numstatPaths,
  parseNumstat,
  sumDiff,
  type DiffStats,
} from './diff-stats.ts';

/**
 * The git half of the diff line — one repo at a time, then summed.
 *
 * Everything about *reading* numstat is in `diff-stats.ts` and is pure. What is
 * here is the part that needs a process, and the three decisions it embodies:
 *
 *   - **The base is resolved LOCALLY, never over the network.** v1's
 *     `Git.defaultBaseRef` fell back to `git remote set-head origin --auto`, a
 *     round-trip, and this runs on a timer. No local base means the committed
 *     half is skipped and the card shows uncommitted work only — which is a
 *     smaller lie than a hang, and it is the common case for a task that has not
 *     committed yet anyway.
 *   - **It is read-only in the strong sense.** `gitRead` already forces
 *     `GIT_OPTIONAL_LOCKS=0`, which is what stops a read from rewriting
 *     `.git/index` and waking whatever watches it. That fix is structural here
 *     rather than remembered, which is why this file does not restate it in
 *     every call.
 *   - **A failure is `null`, not zero.** A repo whose worktree has been removed,
 *     or a path that is not a repo at all, has an UNKNOWN diff — and `+0 −0` is
 *     a claim that nothing changed. The card draws nothing for null.
 */

export interface GitReader {
  gitRead(
    args: readonly string[],
    opts: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false }>;
}

/**
 * Bounded, because this runs on a timer across every repo of every live task.
 *
 * Two seconds is far above a local `git diff` on any repo that fits on a laptop
 * and far below anything a user would notice, and a git call that has not
 * answered in two seconds is wedged rather than slow.
 */
export const DIFF_TIMEOUT_MS = 2000;

/**
 * The branch this work is measured AGAINST, resolved without a network call.
 *
 * `origin/HEAD` is the honest answer when it exists — it is what the remote says
 * its default branch is. It usually does not exist locally until something has
 * run `git remote set-head`, so the fallbacks are the two names that are right
 * ~always in practice, checked for EXISTENCE rather than assumed.
 *
 * Returns null when none of them resolve, and the caller then measures only
 * uncommitted work. A guessed base is worse than no base: `main` on a repo whose
 * trunk is `master` resolves to nothing, and `HEAD...` against nothing is either
 * an error or — worse — the entire history.
 */
export async function resolveBase(git: GitReader, cwd: string): Promise<string | null> {
  const head = await git.gitRead(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (head.ok) {
    const ref = head.stdout.trim();
    if (ref !== '') return ref;
  }

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    // `--verify` on a ref that does not exist exits non-zero and prints nothing,
    // which is exactly the check wanted — and it costs no network.
    const found = await git.gitRead(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      cwd,
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (found.ok && found.stdout.trim() !== '') return candidate;
  }
  return null;
}

/**
 * One repo's diff: what is on this branch and not on the base, plus everything
 * uncommitted.
 *
 * The committed half uses `<base>...HEAD` — three dots, the symmetric-difference
 * form, which diffs against the MERGE BASE rather than against the tip. With two
 * dots, every commit that landed on the trunk after this task branched would
 * count as a removal by this task, and a card would report hundreds of deleted
 * lines nobody deleted. That is the single most consequential character here.
 *
 * The uncommitted half is `git diff HEAD`, which covers staged and unstaged in
 * one call. Untracked files are deliberately NOT counted: a task that dropped a
 * build directory in its worktree has not written 40,000 lines, and `--others`
 * would say it had.
 */
export async function collectRepoDiff(git: GitReader, cwd: string): Promise<DiffStats | null> {
  const uncommitted = await git.gitRead(['diff', '--numstat', 'HEAD'], { cwd, timeoutMs: DIFF_TIMEOUT_MS });
  // Failing here means this is not a usable repo — not that it is clean.
  if (!uncommitted.ok) return null;

  const base = await resolveBase(git, cwd);
  const committed = base === null
    ? { ok: true as const, stdout: '' }
    : await git.gitRead(['diff', '--numstat', `${base}...HEAD`], { cwd, timeoutMs: DIFF_TIMEOUT_MS });

  const committedOut = committed.ok ? committed.stdout : '';
  const paths = new Set([...numstatPaths(committedOut), ...numstatPaths(uncommitted.stdout)]);
  return combineRepoDiff(parseNumstat(committedOut), parseNumstat(uncommitted.stdout), paths);
}

/**
 * A whole task's diff line — every repo it touches, summed.
 *
 * A repo that cannot be read contributes nothing rather than failing the task's
 * whole line: one archived worktree among three should not blank the card. If
 * NONE of them read, the answer is null and the card draws no diff line, which
 * is the difference between "nothing changed" and "we do not know".
 */
export async function collectTaskDiff(
  git: GitReader,
  repoPaths: readonly string[],
): Promise<DiffStats | null> {
  if (repoPaths.length === 0) return null;
  const perRepo = await Promise.all(repoPaths.map((cwd) => collectRepoDiff(git, cwd)));
  const readable = perRepo.filter((stats): stats is DiffStats => stats !== null);
  if (readable.length === 0) return null;
  return readable.length === 1 ? (readable[0] ?? NO_DIFF) : sumDiff(readable);
}
