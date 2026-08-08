/**
 * A repo's name, from its path — the worktree's directory name and the
 * namespace a skill collision is resolved under (ADR 0029).
 *
 * Pure, and here rather than in the composer, because the same derivation
 * happens wherever a repo is picked: it must not be `basename` in one caller and
 * "the last segment, unless it ends in a slash" in another, or two tasks over
 * the same repo disagree about what its skills are called.
 */
export function repoName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments[segments.length - 1] ?? path;
}
