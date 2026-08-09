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
  /**
   * What the composer asks before it can offer a repo.
   *
   * A command rather than something the page reads directly, because the
   * extension point lives in the utility process with the providers registered
   * against it — the renderer cannot consult it and must not learn how. So the
   * composer asks its own extension a question, and the extension asks the
   * point (D5).
   */
  suggestRepos: 'tasks.suggestRepos',
  /**
   * Gone for good — the verb the model was missing.
   *
   * Without it a task created to try something out is permanent: `archive`
   * keeps it (that is its job) and nothing else removes a record. Ten throwaway
   * tasks from a night of live testing is what that looks like on screen.
   */
  delete: 'tasks.delete',
  /**
   * Take me to this task — what clicking a row in the sidebar means.
   *
   * A task owns a layout root, so "show me" is a `layout.switchRoot` and nothing
   * more interesting. It is a command rather than something the tree does
   * directly because the row's click runs as THIS extension (D14) through the
   * one verb table, and because the palette, the CLI and a keybinding all want
   * the same gesture.
   */
  reveal: 'tasks.reveal',
} as const;

/** The composer's UI module, resolved by the renderer's table (ADR 0033). */
export const TASK_VIEWS = {
  tree: 'tasks.tree',
  composer: 'tasks.composer',
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

/**
 * A worktree exists — is anything else needed before it can be worked in?
 *
 * The motivating provider copies what a fresh `worktree add` cannot carry: a
 * `.env`, a vendored directory, a symlink into a shared cache. That is why this
 * is **awaited** rather than announced on the bus. An agent opens in this
 * checkout moments later, so a fire-and-forget event would race it — and would
 * race it invisibly, since the files do land, just sometimes after the agent
 * looked for them.
 *
 * It is the ONLY provisioning point, and it publishes a question rather than a
 * step (the rule `REPO_SUGGESTIONS_POINT` states above). A provider is handed
 * paths and nothing else, so it cannot reach this extension's internals, and it
 * cannot fail a task — see the return type. If a later need wants a different
 * moment, widen this fact; do not add `tasks.repoAboutToProvision` beside it.
 */
export const REPO_PROVISIONED_POINT = 'tasks.repoProvisioned';

export interface RepoProvisionedFact {
  /** The SOURCE repo, as the user picked it — the worktree's origin, not the worktree. */
  readonly repo: { readonly path: string; readonly name: string };
  /** The worktree that now exists, and the directory a provider should work in. */
  readonly worktree: string;
  readonly branch: string;
  readonly task: { readonly slug: string; readonly root: string };
}

/**
 * `ok: false` DEGRADES the repo; it does not fail the task. The worktree is
 * kept, the root is still built and agents still spawn — a half-provisioned
 * checkout you can look at beats a task that refused to open. `message` is what
 * the repo's row and the log then say.
 */
export type RepoProvisioned = (
  fact: RepoProvisionedFact,
) => Promise<{ readonly ok: boolean; readonly message?: string }>;

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
   * `layout` is what `tasks.spawn` needs: an agent runs in a PANE, and the pane
   * is opened by `layout.split` like every other pane in the app. It is the
   * permission that makes "this extension can open windows on your screen" a
   * reviewable fact rather than a surprise.
   *
   * Deliberately absent: `attention`. A task's `needs-you` is DERIVED from its
   * sessions' attention at read time (D4), and `agents-core` is the only writer
   * of agent attention (ADR 0026) — enforced by being the only extension in the
   * repo that declares it. `tasks` asking for it would break that by manifest.
   *
   * And `tasks` DOES read it — it subscribes to the `attention.changed` topic to
   * mirror what each pane is asking for. That is not a hole in the rule above,
   * because the permission and the subscription gate different things:
   * `attention.set`/`clear` are what the permission guards, while `events.on` is
   * membership-gated only — any loaded extension may listen to any topic, which
   * is what makes the bus an announcement rather than a private channel. So the
   * single-writer rule stays exactly as strong as it was: declaring the
   * permission would add a second writer, and listening adds a reader.
   */
  permissions: ['storage', 'process.exec', 'sessions', 'views', 'layout'],
  contributes: {
    commands: [
      { id: TASK_COMMANDS.create, title: 'Tasks: New Task' },
      { id: TASK_COMMANDS.list, title: 'Tasks: List' },
      { id: TASK_COMMANDS.spawn, title: 'Tasks: Spawn a Session' },
      { id: TASK_COMMANDS.archive, title: 'Tasks: Archive' },
      { id: TASK_COMMANDS.restore, title: 'Tasks: Restore' },
      { id: TASK_COMMANDS.suggestRepos, title: 'Tasks: Suggest Repos' },
      { id: TASK_COMMANDS.delete, title: 'Tasks: Delete' },
      { id: TASK_COMMANDS.reveal, title: 'Tasks: Reveal' },
    ],
  },
};
