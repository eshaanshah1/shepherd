/**
 * `~/dev/alpha` → `/Users/x/dev/alpha`, the way a shell does it.
 *
 * A local copy of the function `tasks` has under the same name, deliberately:
 * one extension may not value-import another, and a runtime call through
 * `extensions.get` to borrow four lines of string handling costs more than the
 * duplication does. Only a LEADING `~/` (or a bare `~`) expands — `~user` is a
 * different lookup this cannot perform, and a `~` anywhere else is an ordinary
 * character in an ordinary directory name.
 *
 * It matters more here than it does there, because here the path is the KEY: the
 * same repo typed two ways has to be one hook, or a hook silently stops running
 * the moment you spell its repo the other way.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (!path.startsWith('~/')) return path;
  return `${home}${path.slice(1)}`;
}

/**
 * `/Users/x/dev/alpha` → `alpha`.
 *
 * The same basename rule `tasks` uses to name a worktree's directory and the CLI
 * uses to name a picked repo, so a set labelled `alpha + beta` names the two
 * directories that are actually under the task root. A local copy for
 * `expandHome`'s reason above: one extension may not value-import another, and
 * this is one line of string handling.
 */
export function repoName(path: string): string {
  return path.split('/').filter((part) => part !== '').pop() ?? path;
}
