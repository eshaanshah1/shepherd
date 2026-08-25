/**
 * The tree's path list, from git's two answers about what is in the directory.
 *
 * **Why not just `git ls-files --cached --others --exclude-standard`.** That is
 * gitignore-aware, so it hides `.env` — and an ignored file is very often
 * exactly the file the editor was opened to change. The opposite (an unpruned
 * walk) puts a hundred thousand `node_modules` entries into a list that
 * `useFileTree` holds in full: its `paths` is flat and eager, with no
 * async-children hook, so there is no version of this that lists lazily.
 *
 * The line that resolves it is **ignored FILES versus ignored DIRECTORIES**.
 * `.env`, `.env.local` and `*.log` are ignored files you edit; `node_modules/`,
 * `dist/` and `.next/` are ignored directories you never open. Git draws that
 * line itself — `--directory` collapses a fully-ignored directory to a single
 * entry WITH A TRAILING SLASH — so the slash is the whole test, at any depth.
 */
export function treePaths(tracked: string, ignored: string): readonly string[] {
  const all = new Set<string>(lines(tracked));
  for (const entry of lines(ignored)) {
    // The trailing slash means "and everything under here", which is precisely
    // the set we are refusing to enumerate.
    if (entry.endsWith('/')) continue;
    all.add(entry);
  }
  return [...all].sort();
}

/**
 * Git's output is newline-TERMINATED, not newline-separated, so a plain split
 * ends in `''` — which would reach the tree as a path with no name and render
 * as a blank row above everything else.
 */
function lines(out: string): readonly string[] {
  return out.split('\n').filter((line) => line !== '');
}
