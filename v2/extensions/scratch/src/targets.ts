/**
 * Where a skill can be installed, as a list somebody can pick from.
 *
 * Pure, and it takes the repos rather than finding them: locating the task that
 * owns a tab is two command round trips (`layout.listRoots`, then `tasks.list`),
 * and neither of them is a decision. What IS a decision is the ORDER and what
 * counts as a duplicate, and that is what this file is.
 */

/** A repo, as `tasks` publishes one. Structural, so no type crosses the boundary. */
export interface RepoLike {
  readonly path: string;
  readonly name: string;
}

export interface SkillTarget {
  /** Stable, and carries the path so a caller need not hold a parallel list. */
  readonly id: string;
  /** What it is CALLED — `User`, or the repo's own name. */
  readonly label: string;
  /** The directory a provider's skills path hangs off. Absolute. */
  readonly root: string;
  readonly kind: 'user' | 'repo';
  /** The root as a person writes it, home collapsed. What a row draws. */
  readonly display: string;
}

export const USER_TARGET = 'user';

/** A path as a person writes it. `tasks`' own repo picker collapses the same way. */
export function collapseHome(path: string, homeDir: string): string {
  if (homeDir === '' || !path.startsWith(homeDir)) return path;
  const rest = path.slice(homeDir.length);
  if (rest === '') return '~';
  return rest.startsWith('/') ? `~${rest}` : path;
}

/**
 * User first, then this task's repos in the order the task carries them.
 *
 * **User first because it is the answer most of the time**, and because a repo
 * install is the one that commits a file somebody else pulls. Putting the
 * shared-consequence option second is the same instinct as refusing to overwrite:
 * the default is the one that only affects you.
 *
 * A repo is dropped when it duplicates a target already listed — by path, and
 * including the home directory itself, which a repo checked out at `~` would
 * otherwise list twice under two names.
 */
export function skillTargets(homeDir: string, repos: readonly RepoLike[]): readonly SkillTarget[] {
  const targets: SkillTarget[] = [
    { id: USER_TARGET, label: 'User', root: homeDir, kind: 'user', display: collapseHome(homeDir, homeDir) },
  ];
  const seen = new Set([homeDir]);

  for (const repo of repos) {
    const root = repo.path.replace(/\/+$/, '');
    if (root === '' || seen.has(root)) continue;
    seen.add(root);
    targets.push({
      id: `repo:${root}`,
      // A repo with no name is a path somebody typed; its last component is the
      // name every other surface in the app would have shown for it.
      label: repo.name === '' ? (root.split('/').pop() ?? root) : repo.name,
      root,
      kind: 'repo',
      display: collapseHome(root, homeDir),
    });
  }

  return targets;
}

/** The chosen target, or `undefined` for an id that names none. */
export function findTarget(targets: readonly SkillTarget[], id: string): SkillTarget | undefined {
  return targets.find((target) => target.id === id);
}
