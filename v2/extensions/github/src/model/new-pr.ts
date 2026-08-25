/**
 * What a pull request opened from the rail says, before anybody edits it.
 *
 * Pure, because it is the only part of `github.createPr` worth asserting
 * without a network: the rest is a push and one REST call.
 */

/** The commit subjects, oldest first — `git log <base>..HEAD --format=%s`. */
export function bodyFrom(subjects: readonly string[]): string {
  const lines = subjects.map((subject) => subject.trim()).filter((subject) => subject !== '');
  /*
   * An empty body rather than a heading over nothing. A PR with one commit
   * whose subject IS the title would otherwise open with a bullet list
   * repeating it, which is worse than saying nothing.
   */
  if (lines.length <= 1) return '';
  return lines.map((subject) => `- ${subject}`).join('\n');
}

/**
 * Why this repo cannot have a PR yet, or nothing.
 *
 * Said BEFORE the push rather than after, so the button is absent with a reason
 * instead of present and failing. The three cases are the ones a task's
 * worktree is actually in: nothing committed, the base branch unknown, or the
 * branch IS the base.
 */
export function refuseReason(input: {
  readonly branch: string | null;
  readonly base: string | null;
  readonly ahead: number;
}): string | null {
  if (input.branch === null) return 'this worktree is not on a branch';
  if (input.base === null) return 'cannot tell which branch to open against';
  if (input.branch === input.base) return `this worktree is on ${input.base}`;
  if (input.ahead === 0) return 'nothing committed on this branch yet';
  return null;
}
