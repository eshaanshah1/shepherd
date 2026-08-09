import { s, type ActivateFn } from '@shepherd/sdk';
import type { RepoProvisioned, RepoProvisionedFact } from '@shepherd/ext-tasks/manifest';
import {
  REPO_PROVISIONED_POINT_ID,
  WORKTREE_HOOK_COMMANDS,
  WORKTREE_HOOK_KEY,
  WORKTREE_HOOK_VIEW,
} from './manifest.ts';
import { createStore } from './store.ts';
import { runHooks } from './runner.ts';

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
   * `repo` absent means the global hook.
   *
   * One optional field rather than a `--global` switch, because two flags can
   * disagree — `--global --repo ~/x` has no meaning and would need a rule
   * nobody would remember.
   */
  const target = s.object({ repo: s.optional(s.string()) });

  ctx.subscriptions.push(
    commands.register(WORKTREE_HOOK_COMMANDS.get, {
      title: 'Worktree Hook: Show',
      schema: target,
      handler: (args) => ({
        scope: args.repo ?? 'global',
        script: args.repo === undefined ? store.global() : store.forRepo(args.repo),
        // Always, so one call fills the editor: the thing it draws is the whole
        // set, and a second round-trip to list it would be a second chance to
        // show a stale one.
        repos: store.listRepos(),
      }),
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.set, {
      title: 'Worktree Hook: Set',
      schema: s.object({ repo: s.optional(s.string()), script: s.string() }),
      handler: (args) => {
        if (args.repo === undefined) store.setGlobal(args.script);
        else store.setForRepo(args.repo, args.script);
        // Reported, because setting a hook to nothing is how you delete one and
        // the caller should be told that is what just happened.
        return { scope: args.repo ?? 'global', cleared: args.script.trim() === '' };
      },
    }),

    commands.register(WORKTREE_HOOK_COMMANDS.clear, {
      title: 'Worktree Hook: Clear',
      schema: target,
      handler: (args) => {
        if (args.repo === undefined) store.setGlobal('');
        else store.setForRepo(args.repo, '');
        return { scope: args.repo ?? 'global', cleared: true };
      },
    }),

    /**
     * v1's "Test run" (`spike/seam1/Sources/SettingsView.swift:373-396`).
     *
     * It exists because a hook is otherwise only testable by creating a task,
     * and what it catches — a typo, a path that is not there on this machine —
     * is what you want to find before a worktree exists rather than after.
     *
     * The directory is the CALLER's to make and to remove. An extension that
     * created temp directories would acquire a cleanup problem, and `os.tmpdir`
     * is exactly the OS API `boundaries.js` keeps out of here.
     */
    commands.register(WORKTREE_HOOK_COMMANDS.testRun, {
      title: 'Worktree Hook: Test Run',
      schema: s.object({ repo: s.optional(s.string()), script: s.string(), at: s.string() }),
      handler: async (args) =>
        runHooks(process_, {
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
        }),
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
    }),
  );

  ctx.log.info(
    `ready — ${store.listRepos().length} repo hook(s), global hook ${store.global() === undefined ? 'unset' : 'set'}`,
  );
};
