/**
 * A repo path as the user typed it → a path git can use.
 *
 * `~/dev/shepherd` is what a person writes and what every shell expands before
 * a program ever sees it. Nothing expands it here: the composer sends the field
 * verbatim and the CLI passes its flag through, so git was handed a literal `~`
 * directory, `worktree add` failed, and the task was created with a repo that
 * never provisioned. Measured in the packaged app — one `CLAUDE.md` in the task
 * root and no worktree beside it.
 *
 * Only a LEADING `~/` (or a bare `~`) is expanded, which is what a shell does:
 * `~user` is a different lookup this cannot perform, and a `~` anywhere else in
 * a path is an ordinary character in an ordinary directory name.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (!path.startsWith('~/')) return path;
  return `${home}${path.slice(1)}`;
}
