/**
 * Where an extension keeps things a human will look at — D1b.
 *
 * `boundaries.js` denies `os`/`node:os` to `extensions/**` and to the process
 * that hosts them, so an extension cannot call `homedir()` and cannot compute a
 * path at all. That is the boundary working: a path the host hands over is
 * reviewable, testable, and varies correctly between the dev and production
 * builds (which is why `~/.shepherd/v2-dev` exists). A path an extension derived
 * from `$HOME` would be none of those.
 *
 * It hangs off `support` rather than `userData` because these are files people
 * open: `support` is already documented as "long-lived state we own outside
 * Electron's control (sockets, worktrees)", and a task's worktrees are exactly
 * that. `userData` is Electron's, and nobody browses it.
 *
 * **The last segment, not the full id**, because an agent's cwd will be one of
 * these and `~/.shepherd/v2/tasks/fix-login/api` is the difference between a
 * path somebody can hold in their head and one they cannot. The full id is the
 * fallback the moment two extensions want the same segment — determinism beats
 * prettiness there, since activation order is not stable and whoever ran first
 * must not win a directory.
 *
 * **One thing that must stay true of everything above this directory** (probe 1,
 * measured): Claude Code walks UP from its cwd looking for `.claude/` and
 * `CLAUDE.md`, from at least three levels. So `<support>/` and `~/.shepherd/`
 * must never contain either, or every task root silently inherits it.
 */

export function extensionDataDir(
  id: string,
  allIds: readonly string[],
  support: string,
): string {
  const segment = lastSegment(id);
  const shared = allIds.filter((other) => lastSegment(other) === segment).length > 1;
  return `${support}/${sanitize(shared ? id : segment)}`;
}

function lastSegment(id: string): string {
  const parts = id.split('.');
  return parts[parts.length - 1] ?? id;
}

/**
 * An id comes from a manifest, and a third party writes the manifest — so it is
 * untrusted input that is about to become a directory name. Anything outside a
 * conservative set collapses to `-`, which makes traversal unrepresentable
 * rather than filtered: there is no sequence of characters left that means "up".
 */
function sanitize(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\.{2,}/g, '-');
  return safe.replace(/^[.-]+|[.-]+$/g, '') || 'extension';
}
