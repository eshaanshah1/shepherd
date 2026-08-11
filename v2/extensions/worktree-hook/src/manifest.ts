import type { Manifest, SettingsPage } from '@shepherd/sdk';

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

/**
 * `tasks.taskProvisioned`, spelled out for `REPO_PROVISIONED_POINT_ID`'s reason
 * and pinned the same way in `manifest.test.ts`.
 */
export const TASK_PROVISIONED_POINT_ID = 'tasks.taskProvisioned';

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
} as const;

/**
 * The editor's UI module, resolved by the renderer's table (ADR 0033).
 *
 * Still a NAME rather than code — that part is unchanged — but it is no longer a
 * view: it is a settings PAGE (see `WORKTREE_HOOK_PAGE`), so there is no view type
 * registered for it and no accelerator that raises it. ⌘, and the nav are how you
 * get here.
 */
export const WORKTREE_HOOK_VIEW = 'worktree-hook.editor';

/**
 * The editor, where it always belonged.
 *
 * `index.ts` carried the note "a view of its own ONLY because v2 has no settings
 * surface yet. When there is one this belongs inside it." This is that — and it is
 * the component escape hatch's first consumer, which is what makes the hatch a
 * mechanism rather than a paragraph in a spec: a per-repo script editor is not a
 * row of widgets, and a schema stretched until it could express one would be a UI
 * toolkit in a JSON file.
 *
 * No `settings` keys of its own: the scripts stay in this extension's KV, where
 * `storage`'s comment says why (a hook copies THIS machine's `.env`, so it must
 * never be committable), and the page is how you edit them.
 */
export const WORKTREE_HOOK_PAGE: SettingsPage = {
  id: 'worktreeHook.editor',
  title: 'Worktree hooks',
  description: 'Scripts that run when a worktree is created. Three scopes, run in the order below.',
  order: 200,
  component: WORKTREE_HOOK_VIEW,
};

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
   * `views` is GONE with the overlay: the editor is a settings page now, and a
   * page needs no view registration — so the grant would be one nothing uses, and
   * an unused permission in a manifest is a grant nobody can justify at review.
   */
  permissions: ['storage', 'process.exec'],
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
    ],
    settings: [WORKTREE_HOOK_PAGE],
  },
};
