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
   * What should this task be called? — asked while the brief is still being
   * typed, so that a ~6s answer costs nothing.
   *
   * A command for the same reason `suggestRepos` is one: the composer is a page,
   * it cannot reach another extension's verb table, and it must not learn how
   * (D5). So it asks its own extension, which asks the model.
   */
  suggestName: 'tasks.suggestName',
  /**
   * Gone for good — the verb the model was missing.
   *
   * Without it a task created to try something out is permanent: `archive`
   * keeps it (that is its job) and nothing else removes a record. Ten throwaway
   * tasks from a night of live testing is what that looks like on screen.
   */
  /**
   * Give this task's branch a name that means something.
   *
   * A verb rather than a line of instructions in the task root, because it is one
   * call for a task with three repos and because the refusal it owes — a name
   * already taken in one of them — has to be checked in every repo before any of
   * them is touched. It writes nothing to the record: git holds the branch, so
   * this and a `git branch -m` typed by hand are the same event.
   */
  renameBranch: 'tasks.renameBranch',
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
  /**
   * What this task can be SHOWN as, without showing it here.
   *
   * `reveal` is a desktop gesture — it opens a root and moves the window — and
   * that is exactly wrong for another member of the net drawing this row in its
   * own sidebar: it wants to become a second viewer of the task's session, not
   * to move this machine's window. So the row declares this alongside `reveal`
   * (`TreeItem.presents`), it reports a `PresentEffect` and performs nothing, and
   * the caller decides what showing means on its own surface.
   *
   * It is deliberately NOT `reveal` with a flag. A flag would mean every verb
   * that presents anything grows a second mode nobody can see from the outside,
   * and the row is the honest place to say "here is the read-only way to ask".
   */
  presentation: 'tasks.presentation',
  /**
   * Show all of a task's tabs in the sidebar, or stop.
   *
   * A row's own verb rather than a palette entry: it is what the `… +N` row
   * runs, and it means nothing without a task to name. Declared here with the
   * others because the shell cannot know a task's verbs (ADR 0031) — including
   * this one, which is why the overflow row can be clickable at all.
   */
  expandTabs: 'tasks.expandTabs',
  /**
   * A test run's result, reported by whatever ran it.
   *
   * The card draws a suite meter — n cells, filled for what passed — and nothing
   * in this app knows what a test run IS. That is deliberate rather than
   * unfinished: a task's suite is whatever its repo calls a suite, and an
   * extension that ran `pnpm test` knows the numbers where the task model never
   * could. So the shape is declared here and the SOURCE is a verb anyone can
   * call — an agent through the CLI, a future test-runner extension, a CI
   * webhook.
   *
   * Transient by the same argument as the diff cache: a result is a fact about a
   * moment, and one persisted into the store would outlive the code it was
   * measuring.
   */
  reportSuite: 'tasks.reportSuite',
  /**
   * Which machines a new task could start on — this Mac, and every member of the
   * net that can actually be reached.
   *
   * A command for the reason `suggestRepos` is one (D5): the composer is a page,
   * it cannot reach another extension's verb table, and it must not learn how. So
   * it asks its own extension, which asks the shell.
   */
  machines: 'tasks.machines',
  /** What the rail's search field reports, each time it changes. */
  filter: 'tasks.filter',
  /**
   * The current query's transcript hits — what the overlay draws.
   *
   * A command rather than a prop, for `suggestRepos`' reason (D5): the overlay is
   * a page, it cannot reach another extension's point table, and it must not
   * learn how. So it asks its own extension, which asks the provider.
   */
  transcriptHits: 'tasks.transcriptHits',
  /**
   * Which URLs a paste should be swallowed for — asked when the composer OPENS.
   *
   * A command for the reason `suggestRepos` is one (D5): the providers are
   * registered against a point in the utility process, and the renderer cannot
   * consult one.
   *
   * On open rather than once on mount, and the difference is not fussiness. A
   * stale machine is caught where it matters — `tasks.create` forwards to it and
   * reports what it said. A stale intercept rule is caught nowhere: it silently
   * changes what ⌘V does.
   */
  linkPatterns: 'tasks.linkPatterns',
  /** What a claimed URL should be drawn as, or `null` if nobody claims it. */
  resolveLink: 'tasks.resolveLink',
} as const;

/** The composer's UI module, resolved by the renderer's table (ADR 0033). */
export const TASK_VIEWS = {
  tree: 'tasks.tree',
  composer: 'tasks.composer',
  /** The ⇧⌘F overlay, and the row that raises it. */
  sessionSearch: 'tasks.sessionSearch',
  transcriptCount: 'tasks.transcriptCount',
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
 * Any hits in these directories? — the transcript seam.
 *
 * Defined HERE and answered elsewhere, for the reason `REPO_SUGGESTIONS_POINT`
 * states above: **publish questions, not steps.** This extension must not learn
 * what a Claude transcript is — `store.ts` calls `resumeTarget` "opaque here
 * (D11) … the moment this extension reads it, it has learned about a vendor",
 * and a JSONL parser tracking somebody else's record types is that failure in
 * its most durable form. `shepherd.transcripts` registers the built-in provider; a
 * second agent vendor registers its own and the rail keeps working unchanged.
 *
 * The question is coarse on purpose. "Which sessions, and where did they match?"
 * is answerable and stable; a seam per step of reading a file would freeze one
 * vendor's format into this extension's public API.
 */
export const TRANSCRIPT_SEARCH_POINT = 'tasks.transcriptSearch';

export interface TranscriptQuery {
  /** Case-insensitive literal. Not a regex — a stray `(` must not throw on a keystroke. */
  readonly query: string;
  /** Task roots and worktrees. A provider may look beneath them. */
  readonly dirs: readonly string[];
  /** Snippets per session. Absent means the provider's own default. */
  readonly maxPerSession?: number;
  /**
   * The keystroke that asked.
   *
   * A real `AbortSignal`, which is sound because a point's providers run in this
   * same process (`ext-host/api.ts` holds one `PointRegistry` for all of them) —
   * there is no port here to flatten it into a plain value.
   */
  readonly signal?: AbortSignal;
}

export interface TranscriptMatch {
  readonly source: 'user' | 'assistant' | 'recap' | 'title' | 'agent';
  /** The snippet as it will be drawn: one line, already windowed. */
  readonly text: string;
  /** The run to highlight, as offsets into `text`. */
  readonly at: readonly [number, number];
}

/**
 * One session that matched.
 *
 * **No Shepherd role on it, deliberately.** `orchestrator` / `workstream` is this
 * extension's own fact, held in `task.sessions[].role`; a transcript reader that
 * returned it would have to know what a task is. `tasks` joins `sessionId`
 * against its own record to label the row, and a session it does not track — one
 * started by hand in a worktree — is labelled by its short id alone.
 */
export interface TranscriptHit {
  /** Which requested dir it was found under. Maps the hit back to a task. */
  readonly dir: string;
  readonly sessionId: string;
  readonly title?: string;
  /** Last activity, epoch ms. */
  readonly when: number;
  /** Every match in this session, uncapped — the `4 more` count comes from here. */
  readonly total: number;
  readonly matches: readonly TranscriptMatch[];
}

export interface TranscriptSearchProvider {
  search(query: TranscriptQuery): Promise<readonly TranscriptHit[]>;
}

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
 * It publishes a question rather than a step (the rule `REPO_SUGGESTIONS_POINT`
 * states above). A provider is handed paths and nothing else, so it cannot reach
 * this extension's internals, and it cannot fail a task — see the return type. If
 * a later need wants a different MOMENT in a repo's provisioning, widen this
 * fact; do not add `tasks.repoAboutToProvision` beside it.
 *
 * It is no longer the only provisioning point. `TASK_PROVISIONED_POINT` below is
 * the second and, per ADR 0039, the bar it had to clear is the bar a third would:
 * a different SUBJECT, not a different moment. A question about a repo belongs
 * here; a question about the task belongs there.
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

/**
 * Every worktree this task asked for exists — is anything else needed before it
 * can be worked in?
 *
 * The point above answers that question for ONE repo, in that repo's worktree.
 * This one answers it for the task, once, at the task root — the only directory
 * that holds every checkout, and so the only place wiring that exists *between*
 * two repos can be written.
 *
 * That is why it is a second point rather than a wider `RepoProvisionedFact`,
 * which the comment above forbids. The rule there is against publishing finer
 * STEPS of one repo's provisioning; this publishes a different SUBJECT. And the
 * mechanism leaves no choice: that fact is delivered once per repo, so a
 * provider gated on a repo SET would either fire N times or have to accumulate
 * state across calls and guess which delivery was the last — and nothing in the
 * fact says how many are coming. See ADR 0039.
 *
 * `repos` carries only the checkouts that landed AND that no `repoProvisioned`
 * provider complained about. That one definition is the whole skip rule for
 * anything gated on a set: a repo that failed either step is absent from the set
 * it would have matched, so there is no second cascade rule to get wrong.
 */
export const TASK_PROVISIONED_POINT = 'tasks.taskProvisioned';

export interface TaskProvisionedFact {
  readonly task: { readonly slug: string; readonly root: string };
  /** The task's branch — the same slug every repo's worktree is on. */
  readonly branch: string;
  /** Ready checkouts, in the order the task lists its repos. */
  readonly repos: readonly {
    /** The SOURCE repo, as the user picked it. */
    readonly path: string;
    readonly name: string;
    readonly worktree: string;
  }[];
}

/**
 * `ok: false` DEGRADES the task; it does not fail it. The worktrees are kept,
 * the root is built and agents still spawn — the same trade `RepoProvisioned`
 * makes, for the same reason.
 */
export type TaskProvisioned = (
  fact: TaskProvisionedFact,
) => Promise<{ readonly ok: boolean; readonly message?: string }>;

/**
 * What else is true of this task? — the seam another extension draws on a task
 * row through.
 *
 * The motivating provider is `github`: a task's pull requests are a fact about
 * the task, they belong next to its agent state rather than in a second list
 * that would repeat every task title, and `tasks` must not learn what a pull
 * request is to show them. A CI extension and a deploy extension are the same
 * shape, which is why this is a point and not a `pr` field.
 *
 * It publishes a question, not a step — the rule `REPO_SUGGESTIONS_POINT` states
 * — and it clears ADR 0039's bar for a new point the same way: a different
 * SUBJECT. `repoProvisioned` and `taskProvisioned` ask "is this checkout ready";
 * this asks "what should this row say", of a task that already exists.
 *
 * ── the two things it deliberately refuses ───────────────────────────────────
 *
 * **A provider returns at most ONE fact**, and the card draws it in one cell. A
 * task row is a fixed height and only a waiting-on-you card may grow (§5), so
 * multiplicity is the provider's problem: three PRs are one glyph whose tooltip
 * says three, and the list of them lives behind the row's verb. A point that
 * returned a list would push that decision into a card that cannot make it.
 *
 * **It is synchronous.** The tree is built in one pass and a provider that
 * awaited a network call would hold up every row in the rail behind the slowest
 * integration anybody installed. A provider answers from what it already knows
 * and refreshes by its own clock, which is also what makes an unreachable GitHub
 * a row with no glyph rather than a rail that will not draw.
 */
export const CARD_FACTS_POINT = 'tasks.cardFacts';

/**
 * What is this pasted URL? — asked of a brief being written.
 *
 * It publishes a question rather than a step, the rule `REPO_SUGGESTIONS_POINT`
 * states, and it clears ADR 0039's bar the same way `CARD_FACTS_POINT` does: a
 * different SUBJECT. A pasted URL is neither a repo nor a task.
 *
 * The DIRECTION is the other half of why it is a point. The composer lives here
 * and the vendor grammars do not, so the alternative was `tasks` naming a vendor
 * extension in its own `dependencies` — the generic extension declaring the
 * specific one, which is backwards from every other pairing in this tree and is
 * the rule an extension never naming a vendor exists to prevent.
 */
export const PASTED_LINK_POINT = 'tasks.pastedLink';

/**
 * Every vendor a pill can be drawn as, and the whole of what a provider may say
 * about how one looks.
 *
 * Closed on purpose, and closed on the RENDERER's terms: the hue and the mark
 * live in `packages/ui` and in `link-paste.ts`, so adding Linear here is a
 * conversation about two more lines of drawing rather than a provider shipping
 * its own colour. Both halves of the port — the pattern and the answer — name a
 * member of this union and nothing else.
 */
export type PastedLinkVendor = 'jira' | 'slack';

/**
 * Which URLs a provider claims, as DATA rather than as an expression.
 *
 * A pattern crosses the port and is matched in the RENDERER, so a compiled regex
 * here would be a provider handing the composer something to run.
 *
 * Host **and** path, and that pairing is what makes the paste one-way. Host alone
 * would claim every `atlassian.net` URL, so a wiki page would be swallowed,
 * resolve to nothing, and have to be put back as text — a flicker on the one
 * surface that has to stay quiet. With the path in the pattern, a claimed URL is
 * one some grammar can read, and the composer never un-draws a pill.
 */
export interface PastedLinkPattern {
  /** Matched against the end of the hostname. `.atlassian.net`. */
  readonly hostSuffix: string;
  /** Matched against the start of the pathname. `/browse/`. */
  readonly pathPrefix: string;
  /** A query parameter that must be present. Absent means any query. */
  readonly query?: string;
  /**
   * Whose URL this is, so the pill is that vendor from the frame it lands in.
   *
   * The pattern is the only thing that can say it in time. Resolving spawns a
   * subprocess, and a tint and a mark that wait for that answer arrive as the box
   * changing colour and growing a glyph under the reader's eyes — a paste
   * flickering on the one surface that has to stay quiet.
   *
   * Not a colour and not an icon, which is the restraint `PastedLink` keeps: a
   * closed union the renderer draws, so a provider names a vendor, never paints
   * one.
   */
  readonly vendor: PastedLinkVendor;
}

/**
 * What the pill should be drawn as.
 *
 * Note the three things it does not carry. **No token**: the token is the URL the
 * composer already has, and a resolved title substituted into the brief would put
 * text written in another system into the prompt an agent reads. **No icon and no
 * colour**: `vendor` is a closed union and the renderer owns both, which is the
 * rule `CardFact` states for the rail, met here by having nothing to allow-list
 * rather than by allow-listing.
 */
export interface PastedLink {
  readonly vendor: PastedLinkVendor;
  /** What the pill reads. Already the fallback when nothing resolved. */
  readonly label: string;
  /** Whether a lookup actually answered. Read by tests; draws nothing. */
  readonly resolved: boolean;
}

export interface PastedLinkProvider {
  readonly patterns: readonly PastedLinkPattern[];
  /**
   * `null` when this provider does not claim the URL, which is the common answer.
   *
   * A real `AbortSignal`, sound for the reason `TranscriptQuery` records for its
   * own: a point's providers run in this same process, so there is no port to
   * flatten it into a plain value.
   */
  resolve(url: string, signal: AbortSignal): Promise<PastedLink | null>;
}

/** The task a provider is being asked about — enough to answer, and no more. */
export interface CardFactSubject {
  readonly id: string;
  /** Also the branch every one of its worktrees is on. */
  readonly slug: string;
  readonly title: string;
  /** Finished work: the row is one dimmed line, and most facts do not apply. */
  readonly shipped: boolean;
  readonly repos: readonly { readonly path: string; readonly name: string }[];
}

/**
 * One short thing a row can say, in the vocabulary a contribution is allowed.
 *
 * A glyph NAME and a token ROLE, never an SVG and never a colour — the same rule
 * `TreeItem.tint` and `TreeItemAction.icon` already follow, so a provider cannot
 * make its cell louder than the palette allows or break a theme it never tested.
 */
export interface CardFact {
  /**
   * A glyph name from the shell's allow-list. An unknown name draws no glyph
   * rather than a placeholder box — a provider's typo must not be louder than
   * what it was trying to say.
   */
  readonly icon?: string;
  /**
   * A few characters of mono text — `#309`, `v2 #288`. Truncated by the card
   * rather than by the provider, because only the card knows how much room the
   * title left.
   *
   * A fact may be an icon, a label, or both. One with neither is dropped.
   */
  readonly label?: string;
  /**
   * Which of the palette's readings this is. Defaults to `quiet`.
   *
   * Named for the JOB, never the hue. `pending` is in flight — it will clear
   * itself — and `done` is terminal. Both arrived when the fact stopped being
   * hover-revealed: a glyph you have to point at can lean on its tooltip, and
   * one drawn at rest has to separate five states by sight.
   */
  readonly tone?: 'positive' | 'negative' | 'neutral' | 'pending' | 'done' | 'brand' | 'quiet';
  /**
   * What it MEANS, in words. Required, and the one field with no default: a
   * mark whose only content is a colour cannot be read out, searched, or
   * asserted on in a test (§5).
   */
  readonly title: string;
  /** Clicking it runs this, as the CONTRIBUTING extension (D14). */
  readonly command?: { readonly id: string; readonly args?: unknown };
}

/**
 * `null` when this provider has nothing to say about this task — which is the
 * common answer, and must stay cheap: it is called once per row per redraw.
 */
export type CardFactProvider = (task: CardFactSubject) => CardFact | null;

/**
 * "Ask me again" — announced on the bus by a provider whose answer has changed.
 *
 * The other half of the point, and it has to exist: a provider is a synchronous
 * read of something it already knows, so nothing about it tells the rail when
 * that something moved. Without this a PR would turn red on GitHub and the glyph
 * would stay blue until some unrelated redraw happened to come along.
 *
 * A **bus topic** rather than a callback on the registration, because a point
 * hands out providers and has no hook for "somebody registered" — so this
 * extension would have nothing to subscribe to at the moment it could. Any
 * loaded extension may emit and listen on any topic (membership-gated only),
 * which makes the announcement exactly as reviewable as the point itself.
 *
 * It carries **no payload**. It is a nudge, in the same shape `views.onDidChange`
 * already uses: the rail re-reads, every provider is asked again, and nobody has
 * to agree on a diff format. Emitting it for a task that did not change costs a
 * tree re-read, so a provider should compare before it announces.
 */
export const CARD_FACTS_CHANGED_TOPIC = 'tasks.cardFacts.changed';

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
   * `agents` is what lets this extension ask a model to name a task. Its own
   * grant rather than a corollary of `process.exec`, because it spends the user's
   * model budget — which is not a consequence "can run arbitrary programs"
   * prepares anybody for. It buys one verb, `agents.complete`, and the dispatcher
   * is what checks it.
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
  permissions: ['storage', 'process.exec', 'sessions', 'views', 'layout', 'agents'],
  contributes: {
    commands: [
      { id: TASK_COMMANDS.create, title: 'Tasks: New Task' },
      { id: TASK_COMMANDS.list, title: 'Tasks: List' },
      { id: TASK_COMMANDS.spawn, title: 'Tasks: Spawn a Session' },
      { id: TASK_COMMANDS.archive, title: 'Tasks: Archive' },
      { id: TASK_COMMANDS.restore, title: 'Tasks: Restore' },
      { id: TASK_COMMANDS.suggestRepos, title: 'Tasks: Suggest Repos' },
      { id: TASK_COMMANDS.suggestName, title: 'Tasks: Suggest a Name' },
      { id: TASK_COMMANDS.renameBranch, title: 'Tasks: Rename the Branch' },
      { id: TASK_COMMANDS.delete, title: 'Tasks: Delete' },
      { id: TASK_COMMANDS.reveal, title: 'Tasks: Reveal' },
      /*
       * No `title`, deliberately: an untitled command is not in the palette (the
       * SDK documents `title` as exactly that filter). This one answers a
       * question a client asks on its way to drawing something — there is
       * nothing for a person to pick, and "Tasks: Presentation" in the palette
       * would run a verb whose entire effect is a return value.
       */
      { id: TASK_COMMANDS.presentation },
      { id: TASK_COMMANDS.machines },
      /*
       * No `title` either, and for the same reason: this is the sidebar's search
       * field reporting what is in it. "Tasks: Filter" in the palette would be a
       * verb whose only sensible argument is whatever you were typing somewhere
       * else.
       */
      { id: TASK_COMMANDS.filter },
      // No title, for `filter`'s reason one line up: this answers a page's
      // question and means nothing without a query somebody has typed.
      { id: TASK_COMMANDS.transcriptHits },
    ],
  },
};
