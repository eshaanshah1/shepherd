import type { ExecErr, ExecOk } from '@shepherd/sdk';
import { treePaths } from './paths.ts';
import { readStatus, type StatusEntry } from './status.ts';
import { walk, type Walked } from './walk.ts';

/**
 * Only the one method used, so a test is an object literal and no host.
 *
 * `gitRead` and never `exec`: it passes `GIT_OPTIONAL_LOCKS=0`, and a plain
 * `git status` through `exec` **rewrites `.git/index`** — which in v1 woke the
 * watcher that had just run it, and the two sustained each other with nothing
 * happening in the repo.
 */
export interface GitRunner {
  gitRead(
    args: readonly string[],
    opts: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<ExecOk | ExecErr>;
}

const LIST_MS = 10_000;
const DIFF_MS = 20_000;

/**
 * The tree's paths for one root.
 *
 * Two calls, because git draws the ignored-file / ignored-directory line and we
 * do not (`paths.ts` says why). A root that is not a repository fails the first
 * and falls through to the walk.
 */
export async function listPaths(git: GitRunner, root: string): Promise<Walked> {
  const opts = { cwd: root, timeoutMs: LIST_MS };
  const [tracked, ignored] = await Promise.all([
    git.gitRead(['ls-files', '--cached', '--others', '--exclude-standard'], opts),
    git.gitRead(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], opts),
  ]);

  /*
   * `git ls-files` outside a repository exits 128, and only the FIRST call
   * decides: a repo with nothing ignored answers empty rather than failing, and
   * treating that as "not a repo" would walk a real checkout — node_modules and
   * all — for the crime of having a clean .gitignore.
   */
  if (!tracked.ok) return walk(root);

  return {
    paths: treePaths(tracked.stdout, ignored.ok ? ignored.stdout : ''),
    truncated: false,
  };
}

/**
 * The marks, or none. A failure here costs decoration, never the tree.
 *
 * TWO calls, and the second is not optional. `git status --porcelain` reports
 * paths relative to the REPOSITORY ROOT while `git ls-files` reports them
 * relative to the CWD, so a pane opened on a subdirectory gets marks in a
 * vocabulary its rows do not share — `status.ts` records what that looked like.
 * `--show-prefix` is git's own name for the difference: `''` at the root,
 * `v2/` inside it.
 *
 * A failed prefix read falls back to `''`, which is right for the common case
 * (a pane on the repo root) and merely restores the old behaviour otherwise.
 */
export async function listStatus(git: GitRunner, root: string): Promise<readonly StatusEntry[]> {
  const opts = { cwd: root, timeoutMs: LIST_MS };
  const [result, prefix] = await Promise.all([
    git.gitRead(['status', '--porcelain', '-z'], opts),
    git.gitRead(['rev-parse', '--show-prefix'], opts),
  ]);
  if (!result.ok) return [];
  return readStatus(result.stdout, prefix.ok ? prefix.stdout.trim() : '');
}

/**
 * One file's patch.
 *
 * An untracked file has nothing in `HEAD` to diff against, so it goes through
 * `--no-index` from `/dev/null`, which produces a real all-added patch with the
 * `new file mode` line. Better than synthesising one: git writes the header the
 * renderer wants, and `@pierre/diffs` refuses a patch that does not say which
 * file it is drawing.
 *
 * **`git diff` exits 1 when there ARE differences**, which for `--no-index`
 * against `/dev/null` is always. So a not-ok result carrying output is the
 * success case here, and reading `ok` alone would mean no new file ever
 * renders. The answer is therefore taken from `stdout` in both branches.
 */
export async function filePatch(
  git: GitRunner,
  root: string,
  rel: string,
  untracked: boolean,
): Promise<string | null> {
  const args = untracked
    ? ['diff', '--no-index', '--', '/dev/null', rel]
    : ['diff', 'HEAD', '--', rel];
  const result = await git.gitRead(args, { cwd: root, timeoutMs: DIFF_MS });
  return result.stdout === '' ? null : result.stdout;
}
