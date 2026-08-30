import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code. `manifest.test.ts` asserts it matches `package.json`'s `shepherd` key —
 * a built-in is held to the same validation as anybody else.
 */
export const GITHUB_ID = 'shepherd.github';

/**
 * The key this extension's token is stored under, declared in the manifest and
 * read by `token.ts`.
 *
 * A LEAF name: the host namespaces it by the manifest id, for the reason a
 * setting key is namespaced by the host — an extension that wrote its own prefix
 * could write somebody else's.
 */
export const TOKEN_SECRET_KEY = 'token';
export const TASKS_ID = 'shepherd.tasks';
export const AGENTS_CORE_ID = 'shepherd.agents-core';

/** `editor`'s id, re-stated: only TYPES cross between extensions. */
const EDITOR_ID = 'shepherd.editor';

/** Its two reads, named here for the same reason a layout verb is. */
export const EDITOR_CHANGES_COMMAND = 'editor.changes';
export const EDITOR_DIFF_COMMAND = 'editor.diff';

/**
 * `tasks.cardFacts`, spelled out rather than imported.
 *
 * One extension may TYPE-import another and may not VALUE-import it
 * (`tooling/eslint/boundaries.js`), so the id has to be a local constant. The
 * shape it registers with is type-imported and therefore cannot drift; only this
 * string can, and `manifest.test.ts` pins it at compile time against the literal
 * `tasks` declares.
 */
export const CARD_FACTS_POINT_ID = 'tasks.cardFacts';

/**
 * The other half of that point: the nudge that makes the rail ask again.
 *
 * Spelled out and pinned like the id above. A provider is a synchronous read of
 * something it already knows, so without this a PR would turn red on GitHub and
 * the glyph would stay whatever colour it was until an unrelated redraw came
 * along.
 */
export const CARD_FACTS_CHANGED_TOPIC_ID = 'tasks.cardFacts.changed';

/** `tasks.taskProvisioned`, spelled out and pinned for the same reason. */
export const TASK_PROVISIONED_POINT_ID = 'tasks.taskProvisioned';

/** `tasks.list`, invoked to learn which tasks exist and what repos they hold. */
export const TASKS_LIST_COMMAND = 'tasks.list';
/** `tasks.spawn` — the fallback when a task has no agent left to hand to. */
export const TASKS_SPAWN_COMMAND = 'tasks.spawn';

/**
 * The kernel's session verbs.
 *
 * `sessions.list` answers which of a task's recorded sessions are actually
 * running — its record outlives the ptys it names (ADR 0036), so the record is a
 * claim and this is the check. `sessions.write` is how a hand-off reaches the
 * agent that is already working.
 *
 * The kernel's rather than another extension's, so there is no point id to pin
 * them against — the dispatcher's "unknown command" is the error, and it is a
 * typed one.
 */
export const SESSIONS_LIST_COMMAND = 'sessions.list';
export const SESSIONS_WRITE_COMMAND = 'sessions.write';

/**
 * `agents.list` — what each session is DOING, which is not the same question
 * `sessions.list` answers.
 *
 * Liveness decides which agents are offered; state decides what each row says
 * about handing to it. A session can be running with no agent adopted, and a
 * record can name an agent whose pty has gone, so neither read substitutes for
 * the other.
 */
export const AGENTS_LIST_COMMAND = 'agents.list';

export const GITHUB_COMMANDS = {
  /**
   * Open this task's review tab — what the rail's glyph runs, and the one entry
   * here a person would look for in the palette.
   */
  review: 'github.review',
  /**
   * Ask GitHub again, now.
   *
   * A verb rather than only a timer, because the sync line in the pane head
   * (`gh · synced 12s ago`) invites the question "and if I don't want to wait",
   * and because a CI run finishing is exactly the moment a poll interval is
   * wrong about.
   */
  sync: 'github.sync',
  /**
   * Every PR of a task, as the pane draws them.
   *
   * No `title`, so it is not in the palette: it answers a question a view asks
   * on its way to drawing something, and there is nothing here for a person to
   * pick.
   */
  prs: 'github.prs',
  /** One PR in full — the second page of the review tab. Not in the palette. */
  pr: 'github.pr',
  /**
   * Fetch this PR's patches — what the Files tab asks for when it opens.
   *
   * A verb rather than part of the sync, because a patch is the largest thing
   * about a PR by an order of magnitude: fetching one per PR per poll would make
   * the loop the most expensive thing in the app, for a tab most people never
   * open. Not in the palette — it takes a PR key and its whole effect is that a
   * later read has more in it.
   */
  diff: 'github.diff',
  /**
   * The same, for ONE commit.
   *
   * Separate from `diff` rather than a flag on it because it is a different
   * question — "what did this commit do" instead of "what does this branch
   * do" — and because their caches cannot be shared: a PR's diff is keyed on
   * its head, and a commit's is immutable and keyed on nothing but the sha.
   */
  commitDiff: 'github.commitDiff',
  /** Open it in a browser, which is the one thing this app will not reimplement. */
  open: 'github.open',
  /**
   * Give a failing check or a review thread to the task's agent, as a prompt.
   *
   * The verb this whole extension is for. Everything else here is knowing; this
   * is the part where knowing turns into the agent already working on it.
   */
  handToAgent: 'github.handToAgent',
  merge: 'github.merge',
  /**
   * Merge every PR of the task, in the order they have to land.
   *
   * Its own verb rather than a loop in the pane, because the ORDER is the whole
   * of it and the order is a model decision (`landOrder`) — a caller that merged
   * a stack top-down would close the lower PRs against the wrong base. It is
   * also the one gesture here that does several irreversible things on one
   * press, which is a reason to have it in exactly one place.
   */
  land: 'github.land',
  /**
   * Put invented pull requests on a task — a DEV BUILD ONLY door.
   *
   * This surface is unreachable without a real repository, a real remote and a
   * real open PR, and looking at the app is the check that catches what no unit
   * test can. Registered unconditionally so the palette entry is missing rather
   * than the command being unknown; it refuses outside a dev build, which is a
   * sentence a developer can read.
   */
  seed: 'github.seed',
  /**
   * The working-tree diff of every repo in this task — what the rail's icon
   * opens when there is no PR yet.
   *
   * Assembled from `editor.changes` / `editor.diff` rather than re-derived
   * here: "what have I changed" is one question, and the editor already
   * answers it. This command is the shape the review pane wants it in.
   */
  changes: 'github.changes',
  /** Push this repo's branch and open a pull request for it. */
  createPr: 'github.createPr',
} as const;

/** The review pane's UI module, resolved by the renderer's table (ADR 0033). */
export const GITHUB_VIEWS = {
  review: 'github.review',
  /**
   * The **Diff** face of a task (ADR 0051) — everything the task changed, across
   * every repo it touches.
   *
   * A separate type from the review pane for the reason the editor's is separate
   * from its workspace: a pane is a place you keep open, a face is one way of
   * reading the task on screen. This one is the working changes the review pane
   * already draws, claiming the slot.
   */
  taskDiff: 'github.taskDiff',
} as const;

export const githubManifest: Manifest = {
  id: GITHUB_ID,
  name: 'GitHub',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `network` is the obvious one and the only one that needs no argument.
   *
   * `process.exec` is not for git so much as for **`gh`**: the token comes from
   * `gh auth token` before it comes from anywhere else (see `token.ts`), and
   * reading a repo's remote is a `git remote get-url` in a directory the task
   * already owns.
   *
   * `secrets` is the fallback for a machine with no `gh` — a PAT, in the
   * keychain, belonging to this extension.
   *
   * `sessions` is what `handToAgent` needs, and it is the heaviest thing here in
   * consequence if not in name: it is the permission to type into an agent's
   * pane. It buys exactly one gesture, and the gesture is always the user's.
   *
   * `views` + `layout` are the review tab: a contributed component, opened as a
   * pane (ADR 0044).
   *
   * Deliberately absent: `attention`. A failing check is a CONDITION, not an
   * event — it is always downstream of something that already alerted (an agent
   * pushed, CI ran) — and v1's nudges recorded the same rule for the same
   * reason. `agents-core` stays the only writer of attention (ADR 0026).
   */
  permissions: ['storage', 'process.exec', 'network', 'secrets', 'views', 'layout', 'sessions'],
  /**
   * Declared, not discovered (§7c). This extension reaches `tasks`' point and
   * invokes its commands, and both are gated on this line being here.
   */
  /**
   * `agents-core` as well as `tasks`, because the picker's rows report what each
   * agent is doing — and an extension whose verbs this one invokes is a fact
   * worth having in the manifest even where the dispatcher would allow it
   * anyway. It also fixes the activation order rather than leaving it to luck.
   */
  /*
   * `editor` joins the list because the working-tree diff is its answer, not a
   * second one written here — `github.changes` invokes its commands. Soft in
   * behaviour: without it the no-PR view says it cannot read the changes, and
   * every PR view is unaffected.
   */
  dependencies: [TASKS_ID, AGENTS_CORE_ID, EDITOR_ID],
  contributes: {
    commands: [
      { id: GITHUB_COMMANDS.review, title: 'GitHub: Review' },
      { id: GITHUB_COMMANDS.sync, title: 'GitHub: Sync' },
      { id: GITHUB_COMMANDS.prs },
      { id: GITHUB_COMMANDS.pr },
      { id: GITHUB_COMMANDS.diff },
      { id: GITHUB_COMMANDS.open, title: 'GitHub: Open on GitHub' },
      { id: GITHUB_COMMANDS.handToAgent, title: 'GitHub: Hand to Agent' },
      { id: GITHUB_COMMANDS.merge, title: 'GitHub: Merge' },
      { id: GITHUB_COMMANDS.land, title: 'GitHub: Land Task' },
      { id: GITHUB_COMMANDS.seed, title: 'GitHub: Seed Fake PRs (dev)' },
      { id: GITHUB_COMMANDS.changes },
      { id: GITHUB_COMMANDS.createPr, title: 'GitHub: Create Pull Request' },
    ],
    /**
     * The credential, declared so the Secrets screen can offer it before this
     * extension has ever run.
     *
     * The description says where to get one and what scope it needs, because a
     * secrets screen that names a credential without saying that is a form you
     * cannot fill in. It also says `gh` first — most people never need this
     * field, and the honest thing is to tell them so on the field itself.
     */
    secrets: [
      {
        key: TOKEN_SECRET_KEY,
        title: 'GitHub token',
        description:
          'Only needed if `gh auth token` cannot answer — this extension asks the GitHub CLI first. ' +
          'A fine-grained token with read access to pull requests is enough; add write to merge from here.',
        link: 'https://github.com/settings/tokens',
      },
    ],
  },
};
