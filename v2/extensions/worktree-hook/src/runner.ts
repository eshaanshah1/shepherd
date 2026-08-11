import type { ProcessAPI } from '@shepherd/sdk';
import type { RepoProvisionedFact, TaskProvisionedFact } from '@shepherd/ext-tasks/manifest';
import {
  describeOutcomes,
  planHooks,
  repoName,
  tail,
  TAIL_LINES,
  type HookOutcome,
  type SetRun,
} from './model/index.ts';

/**
 * A hook, actually run.
 *
 * `/bin/bash -lc <script>` is v1's shape and is kept deliberately. A LOGIN shell,
 * so a hook sees the PATH and tool versions a person's terminal has rather than
 * the stunted environment a GUI app inherits — which is what makes `pnpm`,
 * `mise` and `direnv` work inside a hook at all. And the script as ONE string,
 * so a hook is a shell script rather than an argv.
 *
 * It is spelled as an array because v2's exec never goes through a shell: these
 * words are the argv `execFile` receives, so nothing here is re-parsed and
 * nothing in a path can inject an argument.
 */
const BASH = '/bin/bash';

/**
 * Room for a real dependency install inside a hook — v1 had no timeout at all,
 * and `ExecOptions.timeoutMs` is required, so this is a number that had to be
 * chosen rather than inherited.
 */
export const HOOK_TIMEOUT_MS = 600_000;

/**
 * The environment a hook is handed, on top of the one it inherits.
 *
 * The five unprefixed names are v1's, unchanged, so a script written against v1
 * — `scripts/worktree-hook.sh` in this repo included — runs here untouched. The
 * two `TASK_` names are new, because in v2 a worktree has siblings and a hook may
 * legitimately want to reach them.
 */
export function hookEnv(fact: RepoProvisionedFact): Record<string, string> {
  return {
    WORKTREE_DIR: fact.worktree,
    WORKTREE_SRC: fact.repo.path,
    WORKTREE_BRANCH: fact.branch,
    WORKTREE_NAME: fact.repo.name,
    REPO_NAME: fact.repo.name,
    TASK_SLUG: fact.task.slug,
    TASK_ROOT: fact.task.root,
  };
}

export async function runHooks(
  process_: ProcessAPI,
  input: {
    readonly scripts: { readonly global?: string; readonly repo?: string };
    readonly fact: RepoProvisionedFact;
  },
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  const runs = planHooks(input.scripts);
  if (runs.length === 0) return { ok: true };

  const opts = {
    cwd: input.fact.worktree,
    env: hookEnv(input.fact),
    timeoutMs: HOOK_TIMEOUT_MS,
  };

  const outcomes: HookOutcome[] = [];
  for (const run of runs) {
    // See `plan.ts` for why: the global hook is setup the repo hook may depend
    // on, so running the repo hook after it failed produces a second failure
    // caused by the first.
    if (run.kind === 'repo' && outcomes.some((outcome) => !outcome.ok)) {
      return describeOutcomes(outcomes, { skippedRepoHook: true });
    }

    try {
      const result = await process_.exec([BASH, '-lc', run.script], opts);
      if (result.ok) {
        outcomes.push({ kind: run.kind, ok: true, detail: '' });
        continue;
      }

      const merged = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
      outcomes.push({
        kind: run.kind,
        ok: false,
        detail: tail(
          // A killed hook arrives here as a non-zero exit with two empty
          // streams, which reads as an unexplained failure. Naming the timeout
          // is the difference between "it broke" and "it hung".
          merged.trim() === ''
            ? `exited ${result.code} with no output (a hook that hangs is killed after ${HOOK_TIMEOUT_MS / 1000}s)`
            : `exited ${result.code}\n${merged}`,
          TAIL_LINES,
        ),
      });
    } catch (error) {
      // A hook that cannot even be launched is still the hook's problem, and it
      // must not become the task's — this runs inside somebody's provisioning.
      outcomes.push({
        kind: run.kind,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return describeOutcomes(outcomes);
}

/**
 * The environment a SET hook is handed, on top of the one it inherits.
 *
 * Four names, and the absences are the design: `WORKTREE_DIR`, `WORKTREE_SRC`,
 * `WORKTREE_NAME` and `REPO_NAME` would each have to name a single repo, and
 * this hook has no single repo. A script wanting one checkout says
 * `$TASK_ROOT/alpha` — the worktree's directory name is the repo's name, and a
 * set hook knows its own repos by construction, because it was selected by them.
 *
 * `HOOK_REPOS` exists so a generic loop is writable without hardcoding names:
 * `readarray -t repos <<< "$HOOK_REPOS"`.
 */
export function setHookEnv(fact: TaskProvisionedFact, worktrees: readonly string[]): Record<string, string> {
  return {
    TASK_ROOT: fact.task.root,
    TASK_SLUG: fact.task.slug,
    WORKTREE_BRANCH: fact.branch,
    HOOK_REPOS: worktrees.join('\n'),
  };
}

/**
 * Every matched set hook, at the task root, one at a time.
 *
 * Sequential because they share a cwd: concurrency here is racing writes to a
 * single directory, and there are never many. The order is `matchSets`' — size
 * ascending, then key — and this only preserves it.
 *
 * A failure does not stop the next set. The global→repo skip exists because the
 * second depends on the first; two unrelated repo sets have no such
 * relationship, so each reports independently and the messages join.
 */
export async function runSetHooks(
  process_: ProcessAPI,
  input: {
    readonly sets: readonly SetRun[];
    readonly fact: TaskProvisionedFact;
  },
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  if (input.sets.length === 0) return { ok: true };

  const worktreeOf = new Map(input.fact.repos.map((repo) => [repo.path, repo.worktree]));
  const outcomes: HookOutcome[] = [];

  for (const set of input.sets) {
    // `matchSets` selected these against the same `repos`, so every path
    // resolves; `flatMap` is how that is expressed without an unreachable branch
    // or a silent empty string in the middle of `HOOK_REPOS`.
    const worktrees = set.paths.flatMap((path) => {
      const worktree = worktreeOf.get(path);
      return worktree === undefined ? [] : [worktree];
    });
    // The directories under the task root, which is what a person reading the
    // failure is looking at.
    const scope = set.paths.map((path) => repoName(path)).join(' + ');
    const opts = {
      cwd: input.fact.task.root,
      env: setHookEnv(input.fact, worktrees),
      timeoutMs: HOOK_TIMEOUT_MS,
    };

    try {
      const result = await process_.exec([BASH, '-lc', set.script], opts);
      if (result.ok) {
        outcomes.push({ kind: 'set', ok: true, detail: '', scope });
        continue;
      }

      const merged = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
      outcomes.push({
        kind: 'set',
        ok: false,
        scope,
        detail: tail(
          merged.trim() === ''
            ? `exited ${result.code} with no output (a hook that hangs is killed after ${HOOK_TIMEOUT_MS / 1000}s)`
            : `exited ${result.code}\n${merged}`,
          TAIL_LINES,
        ),
      });
    } catch (error) {
      // A hook that cannot even be launched is still the hook's problem, and it
      // must not become the task's.
      outcomes.push({
        kind: 'set',
        ok: false,
        scope,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return describeOutcomes(outcomes);
}
