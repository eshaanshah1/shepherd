import { s, type ActivateFn } from '@shepherd/sdk';
import type {
  RepoProvisioned,
  RepoProvisionedFact,
  TaskProvisioned,
  TaskProvisionedFact,
} from '@shepherd/ext-tasks/manifest';
import {
  REPO_PROVISIONED_POINT_ID,
  TASK_PROVISIONED_POINT_ID,
  WORKTREE_HOOK_COMMANDS,
  WORKTREE_HOOK_KEY,
  WORKTREE_HOOK_VIEW,
} from './manifest.ts';
import { matchSets, repoName } from './model/index.ts';
import { createStore } from './store.ts';
import { runHooks, runSetHooks } from './runner.ts';

/**
 * `shepherd.worktree-hook` — a script you choose, run inside every worktree a
 * task creates.
 *
 * v1 had this per WORKSPACE (`spike/seam1/Sources/WorktreeHookRunner.swift`),
 * and that unit does not survive the move: a v2 task worktrees several repos at
 * once, and what a hook actually does — copy THIS repo's `.env`, symlink THIS
 * repo's vendored directory — belongs to a repo rather than to the window it
 * happens to be opened in. So the key is the source repo path, with one global
 * hook beside it for the machine-wide setup that genuinely is the same for all
 * of them.
 *
 * The work happens before the task root is written and long before a session
 * opens, which is what `tasks.repoProvisioned` being awaited buys.
 */
export const activate: ActivateFn = (ctx, api) => {
  const { commands, points, process: process_, views } = api.proposed;
  const store = createStore(ctx.storage, ctx.homeDir);

  const point = points.get<RepoProvisioned>(REPO_PROVISIONED_POINT_ID);
  if (point === undefined) {
    /**
     * Reachable when `tasks` is disabled or failed to activate. Logged rather
     * than thrown: a hook nobody can run is a degraded feature, and a throwing
     * `activate` is a startup failure — the editor below still works, so the
     * scripts you have set are not lost or hidden while this is true.
     */
    ctx.log.warn(`nothing defines ${REPO_PROVISIONED_POINT_ID} — hooks will not run`);
  } else {
    ctx.subscriptions.push(
      point.register(async (fact: RepoProvisionedFact) =>
        runHooks(process_, {
          scripts: { global: store.global(), repo: store.forRepo(fact.repo.path) },
          fact,
        }),
      ),
    );
  }

  /**
   * The second seam: every worktree exists and the root is written, so this is
   * where a hook that wires two checkouts TOGETHER can run.
   *
   * `fact.repos` is already only the ready checkouts, so `matchSets` is the whole
   * gate — a repo that failed to provision, or whose own hook failed, is absent,
   * and every set containing it correctly does not match.
   */
  const taskPoint = points.get<TaskProvisioned>(TASK_PROVISIONED_POINT_ID);
  if (taskPoint === undefined) {
    ctx.log.warn(`nothing defines ${TASK_PROVISIONED_POINT_ID} — set hooks will not run`);
  } else {
    ctx.subscriptions.push(
      taskPoint.register(async (fact: TaskProvisionedFact) =>
        runSetHooks(process_, {
          sets: matchSets(
            store.listSets(),
            fact.repos.map((repo) => repo.path),
          ),
          fact,
        }),
      ),
    );
  }

  /**
   * Which hook the caller means — three scopes on two optional fields.
   *
   * Optional fields rather than a `--global`/`--set` switch, because two flags
   * can disagree: `--global --repo ~/x` has no meaning and would need a rule
   * nobody would remember. The one combination the schema cannot refuse is BOTH
   * of these, so `targetOf` refuses it.
   */
  const target = s.object({
    repo: s.optional(s.string()),
    repos: s.optional(s.array(s.string())),
  });

  type Target =
    | { readonly kind: 'global' }
    | { readonly kind: 'repo'; readonly path: string }
    | { readonly kind: 'set'; readonly paths: readonly string[] };

  const targetOf = (args: { readonly repo?: string; readonly repos?: readonly string[] }): Target => {
    if (args.repo !== undefined && args.repos !== undefined) {
      throw new Error('name one repo with `repo` or a set with `repos`, not both');
    }
    if (args.repos !== undefined) return { kind: 'set', paths: args.repos };
    if (args.repo !== undefined) return { kind: 'repo', path: args.repo };
    return { kind: 'global' };
  };

  /**
   * How a scope is named back to the caller, and in the editor's rows.
   *
   * A set is named from the store's MEMBERS, not from the order the caller typed
   * — `{beta, alpha}` and `{alpha, beta}` are one hook, and naming it after the
   * argument would give one hook two names depending on who asked.
   */
  const scopeName = (at: Target): string => {
    if (at.kind === 'global') return 'global';
    if (at.kind === 'repo') return at.path;
    return store
      .membersOf(at.paths)
      .map((path) => repoName(path))
      .join(' + ');
  };

  const scriptAt = (at: Target): string | undefined => {
    if (at.kind === 'global') return store.global();
    if (at.kind === 'repo') return store.forRepo(at.path);
    return store.forSet(at.paths);
  };

  const writeAt = (at: Target, script: string): void => {
    if (at.kind === 'global') store.setGlobal(script);
    else if (at.kind === 'repo') store.setForRepo(at.path, script);
    else store.setForSet(at.paths, script);
  };

  ctx.subscriptions.push(
    commands.register(WORKTREE_HOOK_COMMANDS.get, {
      title: 'Worktree Hook: Show',
      schema: target,
      handler: (args) => {
        const at = targetOf(args);
        return {
          scope: scopeName(at),
          script: scriptAt(at),
          // Always, so ONE call fills the whole editor: the thing it draws is
          // every hook there is, and a second round-trip to list them would be
          // a second chance to show a stale one.
          repos: store.listRepos(),
          sets: store.listSets(),
        };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.set, {
      title: 'Worktree Hook: Set',
      schema: s.object({
        repo: s.optional(s.string()),
        repos: s.optional(s.array(s.string())),
        script: s.string(),
      }),
      handler: (args) => {
        const at = targetOf(args);
        writeAt(at, args.script);
        // Reported, because setting a hook to nothing is how you delete one and
        // the caller should be told that is what just happened.
        return { scope: scopeName(at), cleared: args.script.trim() === '' };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.clear, {
      title: 'Worktree Hook: Clear',
      schema: target,
      handler: (args) => {
        const at = targetOf(args);
        writeAt(at, '');
        return { scope: scopeName(at), cleared: true };
      },
    }),

    /**
     * v1's "Test run" (`spike/seam1/Sources/SettingsView.swift:373-396`).
     *
     * It exists because a hook is otherwise only testable by creating a task,
     * and what it catches — a typo, a path that is not there on this machine —
     * is what you want to find before a worktree exists rather than after.
     *
     * `repos` picks which KIND of hook is being tested. Without it the script
     * runs as a repo hook, which is what it has always done. With it the script
     * runs as a set hook at `at`, because a set script tested as a repo hook runs
     * with `TASK_ROOT` unset — `cp "$TASK_ROOT/alpha/.env" .` becomes
     * `cp /alpha/.env .` and the test reports a bug that does not exist.
     *
     * The directory is the CALLER's to make and to remove. An extension that
     * created temp directories would acquire a cleanup problem, and `os.tmpdir`
     * is exactly the OS API `boundaries.js` keeps out of here.
     */
    commands.register(WORKTREE_HOOK_COMMANDS.testRun, {
      title: 'Worktree Hook: Test Run',
      schema: s.object({
        repo: s.optional(s.string()),
        repos: s.optional(s.array(s.string())),
        script: s.string(),
        at: s.string(),
      }),
      handler: async (args) => {
        if (args.repos !== undefined) {
          const paths = [...args.repos];
          return runSetHooks(process_, {
            sets: [{ kind: 'set', paths, script: args.script }],
            fact: {
              task: { slug: 'test-run', root: args.at },
              branch: 'test-run',
              // The set's own repos, stood up under the directory named —
              // `repoName` is the same basename rule `tasks` uses for a
              // worktree's directory, so `$TASK_ROOT/alpha` resolves the way it
              // would in a real task.
              repos: paths.map((path) => ({
                path,
                name: repoName(path),
                worktree: `${args.at}/${repoName(path)}`,
              })),
            },
          });
        }

        return runHooks(process_, {
          // Run as a REPO hook and alone: a test run is about the script in
          // front of you, and quietly running the global one first would make a
          // passing test say nothing about the script you typed.
          scripts: { repo: args.script },
          fact: {
            repo: { path: args.repo ?? args.at, name: 'test-run' },
            worktree: args.at,
            branch: 'test-run',
            task: { slug: 'test-run', root: args.at },
          },
        });
      },
    }),
  );

  /**
   * The editor — a view of its own ONLY because v2 has no settings surface yet.
   * When there is one this belongs inside it; see this extension's README.
   *
   * An overlay rather than a dock section for the composer's reason: a form you
   * open, change and dismiss should not sit in the sidebar taking space forever.
   */
  ctx.subscriptions.push(
    views.registerViewType(WORKTREE_HOOK_VIEW, {
      kind: 'component',
      component: WORKTREE_HOOK_VIEW,
      surface: 'overlay',
      key: WORKTREE_HOOK_KEY,
      title: 'Worktree hooks',
      // A gear, not the default `+`. This form CHANGES a setting; drawn as a
      // plus beside the new-task button it read as a second way to create
      // something, and the two controls were indistinguishable.
      icon: 'settings',
    }),
  );

  ctx.log.info(
    `ready — ${store.listRepos().length} repo hook(s), ${store.listSets().length} set hook(s), ` +
      `global hook ${store.global() === undefined ? 'unset' : 'set'}`,
  );
};
