/**
 * A working directory ⇄ the folder Claude Code keeps its sessions in.
 *
 * **Claude Code replaces `/` AND `.` with `-`.** Measured against a real projects
 * directory: `/Users/me/.shepherd/v2/tasks/x` is stored as
 * `-Users-me--shepherd-v2-tasks-x` — note the double dash where `/.` was.
 * `recall.py`'s `encode_project_name` replaces only `/`, which is why
 * `recall list` inside any Shepherd task prints "no sessions found" and exits 0
 * while `--project all` finds the session immediately.
 *
 * **This encoding is a PREFILTER and never the authority.** It is an undocumented
 * transform in somebody else's program and it is lossy — two paths differing only
 * in `/` vs `.` collide. Every record carries a real `cwd`, so `cwdIsUnder` is
 * what decides which task a session belongs to; the folder name only narrows
 * which folders are worth opening.
 */

function normalize(path: string): string {
  return path.replace(/\/+$/, '');
}

export function encodeProjectDir(path: string): string {
  return normalize(path).replace(/[/.]/g, '-');
}

/**
 * Is this project folder worth opening for any of `dirs`?
 *
 * Prefix rather than equality, so a task's ROOT also selects the worktrees
 * beneath it — `…-fix-login` selects `…-fix-login-api` — and a caller does not
 * have to enumerate them. It over-selects (a sibling task named `fix-login-2`
 * encodes to this prefix plus `-2`), which costs a few files parsed that
 * `cwdIsUnder` then rejects.
 */
export function folderMatchesAny(folder: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => {
    const encoded = encodeProjectDir(dir);
    return folder === encoded || folder.startsWith(`${encoded}-`);
  });
}

/** Is `cwd` one of `dirs`, or inside one? Segment-boundary exact — no prefix trap. */
export function cwdIsUnder(cwd: string | null, dirs: readonly string[]): boolean {
  if (cwd === null) return false;
  const here = normalize(cwd);
  return dirs.some((dir) => {
    const base = normalize(dir);
    return here === base || here.startsWith(`${base}/`);
  });
}
