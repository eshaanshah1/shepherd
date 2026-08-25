/**
 * Which task a tab belongs to, and where its work is.
 *
 * The editor opens on a DIRECTORY, and the right one for a task's tab is the
 * task ROOT — the synthesized directory its repos have worktrees under — not
 * the focused pane's cwd. Those differ whenever the pane is a shell that has
 * `cd`'d anywhere, which is most of the time, and the difference is the pane
 * opening on `<root>/<repo>/v2` instead of on the task.
 */
export interface ListedTask {
  readonly id: string;
  /** The DIRECTORY the worktrees sit under — NOT the pane group. */
  readonly root: string;
  /** The pane group its tabs live in, `task:<id>`. */
  readonly group: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * What `tasks.list` answered, read rather than cast: it crossed a port.
 *
 * A row with no id or no root is DROPPED. Both are identifiers, and an invented
 * root would open the tree on a directory belonging to nobody. `tasks.list`
 * reports the directory as `root` and the pane group as `group`, which are
 * confusingly similar names for entirely different things — github's reader
 * carries the same warning.
 */
export function readTasks(value: unknown): readonly ListedTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ListedTask[] => {
    if (!isRecord(entry)) return [];
    const id = str(entry['id']);
    const root = str(entry['root']);
    if (id === undefined || root === undefined) return [];
    return [{ id, root, group: str(entry['group']) ?? null }];
  });
}

/** The task whose tabs live in this pane group, if any. */
export function taskInGroup(
  tasks: readonly ListedTask[],
  group: string | undefined,
): ListedTask | undefined {
  if (group === undefined) return undefined;
  return tasks.find((task) => task.group === group);
}
