import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProcessAPI } from '@shepherd/sdk';
import { resolveBranch, type RepoRefs } from './model/branch.ts';
import { planArchive, planRestore, type ArchiveRecord, type WorktreeState } from './model/archive.ts';
import type { TaskRoot } from './model/root-synth.ts';

/**
 * Making a task real — the half that touches disk and git.
 *
 * The decisions are all in `model/`: `TaskRootSynth` says what the root should
 * contain and `resolveBranch` says which git invocation to run. This file only
 * performs them, which is why the interesting cases are table-tested without a
 * filesystem and the ones here are about what a filesystem does to you.
 *
 * `fs` is deliberately available to an extension (`boundaries.js` keeps
 * `fs`/`path`/`url` out of its OS-API deny-list). Spawning is not, which is why
 * git goes through `ProcessAPI`.
 */

export interface MaterializeResult {
  readonly linked: number;
  /** Links that could not be made, each with a reason. Degraded, not fatal. */
  readonly failed: readonly string[];
}

/**
 * Write the generated `CLAUDE.md` and the per-entry symlinks.
 *
 * **Idempotent, and a link is replaced rather than kept.** A repo can move, and
 * a stale symlink pointing at where it used to be is worse than no link at all —
 * it resolves to nothing and reports no error, so a skill silently stops
 * existing. Re-materializing is also the repair path.
 *
 * **A failed link degrades the task rather than failing it.** One missing skill
 * is not a reason to refuse to create work; the count and the reasons come back
 * so a caller can say so.
 */
export function materializeTaskRoot(root: string, plan: TaskRoot): MaterializeResult {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), plan.claudeMd, 'utf8');

  let linked = 0;
  const failed: string[] = [];
  for (const link of plan.links) {
    const at = join(root, link.linkPath);
    try {
      mkdirSync(dirname(at), { recursive: true });
      // `lstat`, never `existsSync`: a symlink pointing at a deleted target does
      // not "exist" by the second test, so the stale link would survive forever.
      if (lstatSync(at, { throwIfNoEntry: false }) !== undefined) rmSync(at, { recursive: true, force: true });
      if (!existsSync(link.target)) {
        failed.push(`${link.linkPath}: ${link.target} does not exist`);
        continue;
      }
      symlinkSync(link.target, at);
      linked += 1;
    } catch (error) {
      failed.push(`${link.linkPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { linked, failed };
}

export interface ProvisionRepo {
  readonly name: string;
  /** The source repo, as the user picked it. */
  readonly path: string;
}

export type RepoOutcome =
  | { readonly ok: true; readonly name: string; readonly worktree: string }
  | { readonly ok: false; readonly name: string; readonly reason: string };

/**
 * One repo's worktree, on the task's branch — in two halves, and the seam between
 * them is the point.
 *
 * Everything probe 2 measured is honoured by going through `resolveBranch`:
 * three-way resolution (v1's two-way silently forked an origin-only branch off
 * the default with a wrong upstream), no fetch precondition (v1's made a
 * remoteless or offline repo unusable), no DWIM naming (the path basename here is
 * the REPO name, so git would name the branch after it), and a refusal rather
 * than `--force` when a branch is checked out elsewhere.
 *
 * **Why two functions rather than one.** Reading the refs needs only the repo's
 * path, while adding the worktree needs the branch NAME — and the name now comes
 * from a model that takes seconds to answer. Probe 2's numbers are what make the
 * split worth having: one fetch is ~2.5s of network per repo and a `worktree add`
 * is 0.16s, so a caller can start this half immediately and have the name arrive
 * before the last fraction of a second instead of before the first call.
 *
 * Everything a repo's branches look like, and nothing decided yet.
 *
 * The fetch is **opportunistic**: it improves the base ref when it works and is
 * ignored when it does not.
 */
export async function readRepoRefs(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  timeoutMs = 120_000,
): Promise<RepoRefs> {
  const opts = { cwd: repo.path, timeoutMs };
  const lines = async (args: string[]): Promise<string[]> => {
    const out = await process_.gitRead(args, opts);
    return out.ok ? out.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '') : [];
  };

  // Opportunistic, and its failure is not the task's failure.
  await process_.gitRead(['fetch', '--quiet', 'origin'], opts).catch(() => undefined);

  const originHead = async (): Promise<string | undefined> =>
    (await lines(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))[0];

  /**
   * `refs/remotes/origin/HEAD` is written by `git clone` and by `git remote
   * set-head` — not by a fetch, on any git before 2.47. A repo whose remote was
   * added by hand therefore has none, and case 3 of `resolveBranch` would base a
   * brand-new branch on the source repo's own HEAD: whatever branch that
   * checkout happens to be sitting on, half-finished feature branch included.
   *
   * So it is asked for and recorded once. `--auto` costs a round trip, which is
   * why it is skipped whenever the ref is already there, and its failure is
   * ignored for the same reason the fetch's is — offline is not a task's
   * failure, and `undefined` still falls back to `HEAD`.
   */
  let defaultBase = await originHead();
  if (defaultBase === undefined) {
    await process_.gitWrite(['remote', 'set-head', 'origin', '--auto'], opts).catch(() => undefined);
    defaultBase = await originHead();
  }

  return {
    localBranches: await lines(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    remoteBranches: await lines(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    // Every branch some worktree of this repo already holds. A branch belongs to
    // one worktree, so this is what makes the refusal possible instead of a
    // `--force` that would give two worktrees one branch.
    checkedOutBranches: await lines([
      'worktree',
      'list',
      '--porcelain',
    ]).then((rows) =>
      rows.filter((row) => row.startsWith('branch ')).map((row) => row.slice('branch refs/heads/'.length)),
    ),
    defaultBase,
  };
}

/**
 * The 0.16s that needs the branch name. Every decision it makes is
 * `resolveBranch`'s; this runs it.
 */
export async function addWorktree(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  branch: string,
  dest: string,
  refs: RepoRefs,
  timeoutMs = 120_000,
): Promise<RepoOutcome> {
  const plan = resolveBranch(branch, dest, refs);
  if (!plan.ok) return { ok: false, name: repo.name, reason: plan.reason };

  const added = await process_.gitWrite([...plan.args], { cwd: repo.path, timeoutMs });
  if (!added.ok) return { ok: false, name: repo.name, reason: added.stderr.trim() || `git exited ${added.code}` };
  return { ok: true, name: repo.name, worktree: dest };
}

/**
 * Both halves in order — what every caller wanted before the branch name became a
 * question that takes seconds to answer.
 */
export async function provisionRepo(
  process_: ProcessAPI,
  repo: ProvisionRepo,
  branch: string,
  dest: string,
  timeoutMs = 120_000,
): Promise<RepoOutcome> {
  const refs = await readRepoRefs(process_, repo, timeoutMs);
  return addWorktree(process_, repo, branch, dest, refs, timeoutMs);
}

/**
 * What a repo's worktree contributes to the task root.
 *
 * Read from the WORKTREE, not the source repo: the branch may add or remove
 * skills, and the agent will be working in the worktree.
 */
export function readContribution(worktree: string): {
  skills: string[];
  agents: string[];
  hasSettings: boolean;
} {
  return {
    skills: entriesOf(join(worktree, '.claude', 'skills')),
    agents: entriesOf(join(worktree, '.claude', 'agents')),
    hasSettings: existsSync(join(worktree, '.claude', 'settings.json')),
  };
}

function entriesOf(dir: string): string[] {
  // A repo with no `.claude/` is the common case, not an error — the throw is
  // the answer "there are none", and swallowing it here is what keeps every
  // caller from having to know that.
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Remove a task's worktrees, after snapshotting what is uncommitted.
 *
 * The SHAPE is v1's and ports unchanged, because probe 2 measured it
 * round-tripping `git status --porcelain` byte-identically — untracked files
 * included, which is the gap everyone assumes is there and is not. What is added
 * is the three things it gets wrong, each measured:
 *
 *   - a **conflicted** worktree is refused up front, because `write-tree` fails
 *     with exit 128 and v1 discovers that by failing inside git
 *   - **gitignored** files are warned about before they are destroyed (`add -A`
 *     skips them, `worktree remove --force` deletes them)
 *   - HEAD's **sha** is recorded beside the branch, so a detached worktree stops
 *     restoring onto the archive commit
 */
export async function archiveWorktree(
  process_: ProcessAPI,
  repoPath: string,
  worktree: string,
  timeoutMs = 120_000,
): Promise<
  | { ok: true; record: ArchiveRecord & { commit: string; stagedTree: string }; warnings: readonly string[] }
  | { ok: false; reason: string }
> {
  const at = { cwd: worktree, timeoutMs };
  const read = async (args: string[]): Promise<string> => {
    const out = await process_.gitRead(args, at);
    return out.ok ? out.stdout.trim() : '';
  };

  const state: WorktreeState = {
    branch: await read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    headSha: await read(['rev-parse', 'HEAD']),
    hasConflicts: (await read(['ls-files', '-u'])) !== '',
    ignoredPaths: (await read(['ls-files', '--others', '--ignored', '--exclude-standard']))
      .split('\n')
      .filter((line) => line !== ''),
  };

  const plan = planArchive(state);
  if (!plan.ok) return plan;

  // v1's two commits, pinned under a ref so `gc` cannot reclaim them. Local
  // only: `refs/shepherd/*` is outside the default push refspec.
  const staged = await read(['write-tree']);
  await process_.gitWrite(['add', '-A'], at);
  const everything = await read(['write-tree']);
  const commit = await read(['commit-tree', everything, '-p', state.headSha, '-m', `shepherd archive ${staged}`]);
  if (commit === '') return { ok: false, reason: 'could not write the archive commit' };
  await process_.gitWrite(['update-ref', `refs/shepherd/archived/${commit}`, commit], { cwd: repoPath, timeoutMs });

  const removed = await process_.gitWrite(['worktree', 'remove', '--force', worktree], { cwd: repoPath, timeoutMs });
  if (!removed.ok) return { ok: false, reason: removed.stderr.trim() || `git exited ${removed.code}` };
  return { ok: true, record: { ...plan.record, commit, stagedTree: staged }, warnings: plan.warnings };
}

/**
 * Remove a worktree for good — the counterpart to `provisionRepo`, and the one
 * operation in this file that destroys work rather than moving it.
 *
 * `--force` is passed because the caller has already decided: a task being
 * deleted is one whose contents are not wanted, and a `worktree remove` that
 * refuses over an untracked file would leave the record gone and the directory
 * behind — half a delete, which is the state nothing can clean up later.
 *
 * The **branch is left alone**, deliberately. It lives in the source repo, it
 * may have commits somebody wants, and `git branch -D` on it is a second,
 * larger destruction the caller did not ask for. What is reported instead is
 * its name, so a caller can say what remains.
 */
export async function removeWorktree(
  process_: ProcessAPI,
  repoPath: string,
  worktree: string,
  timeoutMs = 60_000,
): Promise<{ ok: true; branch: string | null } | { ok: false; reason: string }> {
  const at = { cwd: worktree, timeoutMs };
  const branch = await process_.gitRead(['rev-parse', '--abbrev-ref', 'HEAD'], at);
  const removed = await process_.gitWrite(['worktree', 'remove', '--force', worktree], {
    cwd: repoPath,
    timeoutMs,
  });
  if (!removed.ok) return { ok: false, reason: removed.stderr.trim() || `git exited ${removed.code}` };
  const name = branch.ok ? branch.stdout.trim() : '';
  return { ok: true, branch: name === '' || name === 'HEAD' ? null : name };
}

/**
 * Put the uncommitted work back — the half `worktree add` cannot do.
 *
 * Re-provisioning gives you the branch; it gives you a CLEAN tree, which is not
 * what was archived. This replays the snapshot, and the order is the whole
 * algorithm:
 *
 *   1. `read-tree --reset -u <archive tree>` makes the index AND the working
 *      tree exactly what was captured. `-u` is what updates files on disk and
 *      what removes the ones that were deleted — a plain `checkout -- .` writes
 *      what is in the tree and leaves a deleted file sitting there, restored.
 *   2. `read-tree <staged tree>` then sets the index back to the staged
 *      snapshot WITHOUT touching the working tree. That is what re-splits
 *      staged from unstaged, and it is also why untracked files come back as
 *      untracked: `add -A` captured them into the archive tree, and this step
 *      takes them back out of the index.
 *   3. HEAD goes where `planRestore` says — reattached to the branch, or
 *      detached onto the recorded sha. Skipping step 3 for a detached worktree
 *      is exactly how v1 left HEAD on the archive commit.
 */
export async function restoreWorktree(
  process_: ProcessAPI,
  worktree: string,
  record: ArchiveRecord & { commit: string; stagedTree: string },
  timeoutMs = 120_000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const at = { cwd: worktree, timeoutMs };
  const head = await process_.gitWrite([...planRestore(record).args], at);
  if (!head.ok) return { ok: false, reason: head.stderr.trim() || `git exited ${head.code}` };

  const full = await process_.gitWrite(['read-tree', '--reset', '-u', `${record.commit}^{tree}`], at);
  if (!full.ok) return { ok: false, reason: full.stderr.trim() || `git exited ${full.code}` };

  const staged = await process_.gitWrite(['read-tree', record.stagedTree], at);
  if (!staged.ok) return { ok: false, reason: staged.stderr.trim() || `git exited ${staged.code}` };
  return { ok: true };
}
