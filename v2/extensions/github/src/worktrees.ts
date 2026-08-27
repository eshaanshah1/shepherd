import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which checkouts a task actually has, read from its root rather than from its
 * record.
 *
 * The record is the repos the user picked in the composer, and a task can hold
 * more than that. An agent given a task with no repos does the obvious thing and
 * runs `git worktree add` itself, and the result is a real checkout, on the
 * task's branch, that `tasks.list` has never heard of. Trusting the record there
 * left the changes pane iterating an empty list and telling the user nothing had
 * changed while five modified files sat under the task root.
 *
 * So the record is treated as the NAMING half — it is what puts a repo first and
 * in the order the user picked — and the disk is treated as the existence half.
 * A repo named by the record is kept whether or not it is on disk: a shelved
 * task has no worktrees, and dropping its repos would make the pane disagree
 * with the card about which repos the task even has.
 */

/** One checkout under a task root. */
export interface TaskWorktree {
  /** The directory under the task root, which is what the pane names it by. */
  readonly name: string;
  /** The checkout itself — where git is asked, and what a pull request pushes. */
  readonly worktree: string;
}

export interface WorktreeSubject {
  readonly root: string;
  readonly repos: readonly { readonly name: string }[];
}

export function worktreesOf(task: WorktreeSubject): readonly TaskWorktree[] {
  const named = task.repos.map((repo) => repo.name);
  const found = checkoutsIn(task.root).filter((name) => !named.includes(name));
  return [...named, ...found].map((name) => ({ name, worktree: join(task.root, name) }));
}

/**
 * The directories under a task root that are checkouts, in name order.
 *
 * A worktree's `.git` is a FILE holding a `gitdir:` line rather than a
 * directory, so existence is the test and `isDirectory` is not. Dot-prefixed
 * entries are skipped because `.claude` is linked into every task root and is
 * not this task's work — one the user actually picked arrives through the record
 * instead, which is why skipping it here costs nothing.
 */
function checkoutsIn(root: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // A root that is gone is a shelved task, not an error. Its record still
    // names its repos and the pane still draws them, emptily.
    return [];
  }
  return entries
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && existsSync(join(root, name, '.git')))
    .sort((left, right) => left.localeCompare(right));
}
