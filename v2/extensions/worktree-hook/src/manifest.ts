import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code. `manifest.test.ts` asserts it matches `package.json`'s `shepherd` key.
 */
export const WORKTREE_HOOK_ID = 'shepherd.worktree-hook';
export const TASKS_ID = 'shepherd.tasks';

/**
 * `tasks.repoProvisioned`, spelled out rather than imported.
 *
 * One extension may TYPE-import another and may not VALUE-import it
 * (`tooling/eslint/boundaries.js`), so the id has to be a local constant. The
 * shape it registers with is type-imported and therefore cannot drift; only this
 * string can, and `manifest.test.ts` pins it at compile time against the literal
 * `tasks` declares.
 */
export const REPO_PROVISIONED_POINT_ID = 'tasks.repoProvisioned';

export const WORKTREE_HOOK_COMMANDS = {
  get: 'worktreeHook.get',
  set: 'worktreeHook.set',
  clear: 'worktreeHook.clear',
  /**
   * Run a script against a directory you nominate — v1's "Test run".
   *
   * It exists because a hook is otherwise only testable by creating a task, and
   * the mistakes it catches (a typo, a path that is not there on this machine)
   * are ones you want to find before a worktree exists rather than after.
   */
  testRun: 'worktreeHook.testRun',
  edit: 'worktreeHook.edit',
} as const;

/** The editor's view type, resolved by the renderer's table (ADR 0033). */
export const WORKTREE_HOOK_VIEW = 'worktree-hook.editor';

export const worktreeHookManifest: Manifest = {
  id: WORKTREE_HOOK_ID,
  name: 'Worktree Hook',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `process.exec` is the feature: a hook IS a script, and running it is the
   * whole job. An extension that could not would be an empty settings panel.
   *
   * `storage` holds the scripts, and holding them here rather than in a config
   * file is a decision, not a shortcut: a hook copies THIS machine's `.env` and
   * symlinks THIS machine's caches, so it is reachable through the app and the
   * Shepherd CLI and can never be committed into a repo somebody else clones.
   *
   * `views` is the editor, which exists only because v2 has no settings surface
   * yet — see the README, and delete the view when there is one.
   */
  permissions: ['storage', 'process.exec', 'views'],
  /**
   * Declared, not discovered (§7c). The point this extension registers into
   * belongs to `tasks`, and naming it here is what lets the host activate them
   * in the right order — and refuse to activate this one at all if `tasks` is
   * not there.
   */
  dependencies: [TASKS_ID],
  contributes: {
    commands: [
      { id: WORKTREE_HOOK_COMMANDS.get, title: 'Worktree Hook: Show' },
      { id: WORKTREE_HOOK_COMMANDS.set, title: 'Worktree Hook: Set' },
      { id: WORKTREE_HOOK_COMMANDS.clear, title: 'Worktree Hook: Clear' },
      { id: WORKTREE_HOOK_COMMANDS.testRun, title: 'Worktree Hook: Test Run' },
      { id: WORKTREE_HOOK_COMMANDS.edit, title: 'Worktree Hook: Edit' },
    ],
  },
};
