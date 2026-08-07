import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code. `manifest.test.ts` asserts it matches `package.json`'s `shepherd` key —
 * a built-in is held to the same validation as anybody else.
 */
export const TASKS_ID = 'shepherd.tasks';

export const TASK_COMMANDS = {
  create: 'tasks.create',
  list: 'tasks.list',
  spawn: 'tasks.spawn',
  archive: 'tasks.archive',
  restore: 'tasks.restore',
} as const;

/**
 * The point THIS extension defines, so the repo picker's ranking is somebody
 * else's to replace (D5, core-design §4.7).
 *
 * The canonical third-party case is an extension that reads the prompt text and
 * guesses which repos a task is about; the built-in usage-and-recency ranking is
 * just the default provider, registered through the same call a third party
 * makes. Exported so an id nobody can typo.
 *
 * The seam is coarse on purpose — **publish questions, not steps**. "Given this
 * input, which repos?" is answerable and stable. A hook per provisioning step
 * would freeze this extension's internals as public API and let a third party
 * corrupt invariants it cannot see.
 */
export const REPO_SUGGESTIONS_POINT = 'tasks.repoSuggestions';

export const tasksManifest: Manifest = {
  id: TASKS_ID,
  name: 'Tasks',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `process.exec` is here because a task IS worktrees: provisioning runs git
   * (P4). `storage` holds the task store, which is the authority — the folder is
   * derived from it and must be reconstructible from it alone.
   *
   * Deliberately absent: `attention`. A task's `needs-you` is DERIVED from its
   * sessions' attention at read time (D4), and `agents-core` is the only writer
   * of agent attention (ADR 0026) — enforced by being the only extension in the
   * repo that declares it. `tasks` asking for it would break that by manifest.
   */
  permissions: ['storage', 'process.exec', 'sessions', 'views'],
  contributes: {
    commands: [
      { id: TASK_COMMANDS.create, title: 'Tasks: New Task' },
      { id: TASK_COMMANDS.list, title: 'Tasks: List' },
      { id: TASK_COMMANDS.spawn, title: 'Tasks: Spawn a Session' },
      { id: TASK_COMMANDS.archive, title: 'Tasks: Archive' },
      { id: TASK_COMMANDS.restore, title: 'Tasks: Restore' },
    ],
  },
};
