import { s, type ExtensionContext, type Shepherd } from '@shepherd/sdk';
import type { CardFact, CardFactProvider } from '@shepherd/ext-tasks/manifest';
import {
  CARD_FACTS_CHANGED_TOPIC_ID,
  CARD_FACTS_POINT_ID,
  GITHUB_COMMANDS,
  GITHUB_VIEWS,
  AGENTS_LIST_COMMAND,
  SESSIONS_LIST_COMMAND,
  SESSIONS_WRITE_COMMAND,
  TASKS_LIST_COMMAND,
  TASKS_SPAWN_COMMAND,
} from './manifest.ts';
import { FILE_PAGE, message, octokitClient, type GitHubClient } from './client.ts';
import { Remotes } from './remotes.ts';
import { readBranch, readHead } from './heads.ts';
import { Sync } from './sync.ts';
import { readPaneTitles, readRoots, readTasks, type ListedTask } from './tasks-read.ts';
import { agentName, handingMeans, markFor, pickAgent, readLive, readStates, type TaskAgent } from './model/agent-pick.ts';
import { resolveToken } from './token.ts';
import { fixturePrs } from './fixture.ts';
import {
  canMerge,
  checkPrompt,
  firstFailure,
  landOrder,
  prKey,
  reviewPrompt,
  rollUp,
  rollUpSaid,
  threadPrompt,
  type PullRequest,
  type TaskPrState,
  type ChangedFile,
} from './model/index.ts';

/**
 * The pull requests a task has open, where its agents are.
 *
 * A task already carries the join GitHub needs: one branch, named after the
 * task's slug, checked out in every one of its repos. So "which PRs belong to
 * this task" is a lookup rather than a guess, and everything this extension does
 * follows from having it.
 *
 * It reaches the screen in two places and nowhere else:
 *
 *   - **one glyph on the task's row**, tinted by the worst state across its PRs,
 *     contributed through `tasks.cardFacts` — so `tasks` never learns what a
 *     pull request is, and a second integration lands the same way
 *   - **a `review` tab**, a contributed pane (ADR 0044) showing every PR of the
 *     task and then one PR in full
 *
 * Deliberately NOT a rail section of its own. A task's PRs listed separately
 * would repeat every task title one level down, which is the rule this
 * codebase's design notes call the most common mistake in its history.
 *
 * And deliberately no attention: a failing check is a condition, not an event,
 * and is always downstream of something that already alerted. See the manifest.
 */
export function activate(ctx: ExtensionContext, api: Shepherd): void {
  const { commands, events, points, process, views } = api.proposed;
  // Injected time — nothing an extension writes may call `Date.now()`.
  const clock = ctx.clock;

  const remotes = new Remotes(process);

  /**
   * The client, resolved on first need and dropped when a credential stops
   * working.
   *
   * Lazy because resolving it runs `gh`, and an extension that spawned a
   * subprocess during `activate` would put that on the app's launch path for a
   * user who may have no GitHub repos at all.
   */
  let client: GitHubClient | null = null;
  let viewer: string | null = null;
  /** `null` = not asked yet. `false` = asked, and there is nothing to find. */
  let signedIn: boolean | null = null;

  const ensureClient = async (): Promise<GitHubClient | null> => {
    if (client !== null) return client;
    if (signedIn === false) return null;
    const token = await resolveToken({
      process,
      secrets: ctx.secrets,
      env: { homeDir: ctx.homeDir, userName: ctx.userName },
      cwd: ctx.homeDir,
    });
    if (token === null) {
      signedIn = false;
      ctx.log.info('no GitHub token — `gh auth login`, or set this extension’s token secret');
      return null;
    }
    signedIn = true;
    client = octokitClient(token.value);
    ctx.log.info(`GitHub token from ${token.origin}`);
    // Best-effort and never awaited by anything that draws: it only labels a
    // thread as one your side resolved.
    void client
      .viewer()
      .then((login) => (viewer = login))
      .catch(() => (viewer = null));
    return client;
  };

  const sync = new Sync({
    clock,
    client: () => client,
    remoteOf: (path) => remotes.of(path),
    headOf: (path) => readHead(process, path),
    branchOf: (worktree) => readBranch(process, worktree),
    // The nudge that makes the rail re-read. Emitted only when something drawn
    // actually moved — `Sync.changed` is what decides that, because a tree
    // re-read is not free.
    onChanged: () => events.emit(CARD_FACTS_CHANGED_TOPIC_ID, undefined),
    onAuthFailure: () => {
      // Drop the client rather than the token: the next pass re-resolves, which
      // picks up a `gh auth login` done in the meantime without a relaunch.
      client = null;
      signedIn = null;
    },
    log: (message) => ctx.log.warn(message),
  });

  // ------------------------------------------------------------------ reading

  const listTasks = async (): Promise<readonly ListedTask[]> => {
    const answer = await commands.invoke(TASKS_LIST_COMMAND, {});
    return answer.ok ? readTasks(answer.value) : [];
  };

  const taskById = async (id: string): Promise<ListedTask | undefined> =>
    (await listTasks()).find((task) => task.id === id);

  /**
   * One pass: ask `tasks` what exists, then sync whatever is due.
   *
   * `tasks` is asked every tick rather than cached because a task appearing is
   * exactly the moment its first PR is about to exist — an agent has just been
   * told to do something — and a stale list would miss it for as long as the
   * cache lived.
   */
  const pass = async (force = false): Promise<void> => {
    if ((await ensureClient()) === null) return;
    await sync.pass(await listTasks(), force);
  };

  /**
   * The heartbeat, and it is deliberately faster than any of the staleness
   * intervals it serves.
   *
   * `Sync` decides what is DUE; this only decides how often that question is
   * asked. Ten seconds means a task whose review tab just opened waits at most
   * that long past its own twenty, rather than up to two minutes because the
   * tick happened to land badly.
   */
  const TICK_MS = 10_000;
  /**
   * Every unattended pass, with nothing able to escape it.
   *
   * A `void pass()` on a timer is an unhandled rejection waiting for the first
   * host API that throws — and one does: `secrets.get` is typed in the SDK and
   * not implemented in this build, so a machine with no `gh` took the extension
   * host down that path. Measured by `smoke:m3`. A background sweep must never
   * be able to fail louder than the thing it was sweeping for.
   */
  const sweep = (force = false): void => {
    void pass(force).catch((error: unknown) => ctx.log.warn(`sync pass failed — ${String(error)}`));
  };

  const timer = setInterval(() => sweep(), TICK_MS);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  // The first pass, off the launch path: nothing on screen waits for it, and a
  // `gh` spawn during activation would be in front of every user's window.
  setTimeout(() => sweep(), 1_000).unref?.();

  // ------------------------------------------------------------- the rail glyph

  /**
   * One glyph per task, or a merged number on a shipped row.
   *
   * Synchronous, as the point requires: it reads what the last sync left in
   * memory and never asks GitHub. A task nobody has synced yet has no fact,
   * which is the honest answer — a glyph drawn before anything is known would
   * claim a state.
   */
  const factFor: CardFactProvider = (task): CardFact | null => {
    const prs = sync.prsOf(task.id);
    if (prs.length === 0) return null;
    const title = rollUpSaid(prs);
    if (title === null) return null;
    const state = rollUp(prs);

    /*
     * A shipped row says the NUMBER, a live row says the glyph.
     *
     * The two are different questions. On live work you want to know whether
     * anything needs you, which is a state and reads faster as a mark; on
     * finished work the state is always "merged" and the useful fact is which PR
     * it was — the record of what shipped.
     */
    if (task.shipped) {
      const merged = prs.filter((pr) => pr.state === 'merged');
      const only = merged.length === 1 ? merged[0] : undefined;
      if (only === undefined) return null;
      return {
        label: `${only.repoKey} #${only.number}`,
        tone: 'quiet',
        title,
        command: { id: GITHUB_COMMANDS.open, args: { url: only.url } },
      };
    }

    return {
      icon: 'pull-request',
      tone: TONES[state],
      title,
      command: { id: GITHUB_COMMANDS.review, args: { task: task.id } },
    };
  };

  const point = points.get<CardFactProvider>(CARD_FACTS_POINT_ID);
  if (point === undefined) {
    // `tasks` is a declared dependency, so this is not a manifest bug — it is
    // `tasks` failing to activate. Said once, rather than silently drawing no
    // glyphs forever.
    ctx.log.warn(`${CARD_FACTS_POINT_ID} is not defined — no PR glyphs will be drawn`);
  } else {
    ctx.subscriptions.push(point.register(factFor));
  }

  // --------------------------------------------------------------- the review tab

  ctx.subscriptions.push(
    views.registerViewType(GITHUB_VIEWS.review, {
      kind: 'component',
      component: GITHUB_VIEWS.review,
      /*
       * A PANE, not a dock section and not an overlay (ADR 0044). It has a
       * subject, you keep it open while you work, and you come back to it after
       * a relaunch — which is what a place is and what the other two are not.
       */
      surface: 'pane',
      title: 'review',
    }),
  );

  // -------------------------------------------------------------------- verbs

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.review, {
      title: 'GitHub: Review',
      schema: s.object({ task: s.optional(s.string()) }),
      /**
       * Open this task's review tab, or go to the one that is already open.
       *
       * The existing tab is found by asking the LAYOUT what it holds rather than
       * by remembering what we opened: a record of our own would be wrong the
       * moment the user closed the tab, and wrong again across a relaunch.
       */
      handler: async (args) => {
        const task = args.task === undefined ? undefined : await taskById(args.task);
        if (task === undefined) return { ok: false, reason: 'no such task' };
        if (task.group === null) return { ok: false, reason: 'that task has no pane group' };

        // Watch it before opening: the tab is about to be on screen, and the
        // faster cadence should cover the sync that fills it.
        sync.watch(task.id);
        sweep();

        const listed = await commands.invoke(GITHUB_LAYOUT.listRoots, { group: task.group });
        const open = listed.ok
          ? readRoots(listed.value).find((root) => root.viewTypes.includes(GITHUB_VIEWS.review))
          : undefined;
        if (open !== undefined) {
          await commands.invoke(GITHUB_LAYOUT.switchRoot, { root: open.root });
          return { ok: true, root: open.root, opened: false };
        }

        const created = await commands.invoke(GITHUB_LAYOUT.newTab, {
          group: task.group,
          view: { type: GITHUB_VIEWS.review, state: { task: task.id } },
          // Without this the tab reads `term`: a view pane runs no program, so
          // nothing ever sets an OSC title on it.
          title: 'review',
        });
        return created.ok ? { ok: true, opened: true } : { ok: false, reason: created.error.message };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.sync, {
      title: 'GitHub: Sync',
      schema: s.nothing(),
      handler: async () => {
        // The remotes too: this is the verb somebody runs after adding one.
        remotes.forget();
        client = null;
        signedIn = null;
        await pass(true);
        return { ok: true, signedIn: signedIn === true };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.prs, {
      schema: s.object({ task: s.string() }),
      /**
       * What the review pane draws — the whole of its first page.
       *
       * Ordered here rather than in the view, because the order is a decision
       * (`landOrder`) and not a presentation: it is the sequence these have to
       * merge in, and the pane's footer names it.
       */
      handler: async (args) => {
        const held = sync.get(args.task);
        const prs = held?.prs ?? [];
        /*
         * The task's own facts, asked for here rather than by the pane.
         *
         * The pane could invoke `tasks.list` itself, but then two surfaces would
         * be reading one extension's model — and this one is already asking, on
         * the same tick, for the same task.
         */
        const task = await taskById(args.task);
        const agentStates = await commands.invoke(AGENTS_LIST_COMMAND, {});
        const states = agentStates.ok ? readStates(agentStates.value) : new Map();
        return {
          /** Live PRs in the order they land; finished ones after, newest first. */
          open: landOrder(prs).map(prKey),
          closed: prs
            .filter((pr) => pr.state === 'merged' || pr.state === 'closed')
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(prKey),
          prs,
          syncedAt: held?.syncedAt ?? null,
          error: held?.error ?? (signedIn === false ? 'not signed in' : undefined),
          signedIn: signedIn === true,
          viewer,
          taskTitle: task?.title ?? '',
          ...(await branchAgent(task, states)),
        };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.pr, {
      schema: s.object({ task: s.string(), pr: s.string() }),
      handler: (args) => {
        const found = sync.prsOf(args.task).find((pr) => prKey(pr) === args.pr);
        return found === undefined ? { ok: false, reason: 'no such pull request' } : { ok: true, pr: found };
      },
    }),
  );

  /**
   * PRs whose patches have been fetched, so the Files tab asks once.
   *
   * Keyed by `<pr>@<updatedAt>`, not by the PR: a push changes the diff and the
   * PR's `updatedAt` with it, so the key expires exactly when the answer does.
   * A key on the PR alone would show yesterday's diff of a branch somebody
   * force-pushed this morning.
   */
  const fetched = new Set<string>();

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.diff, {
      schema: s.object({ task: s.string(), pr: s.string() }),
      /**
       * The one call in this extension that leaves the single-round-trip design.
       *
       * GraphQL's changed-file type has no patch field at all, so a diff is only
       * reachable through REST's `pulls.listFiles` — and it is the largest thing
       * about a PR, which is why it waits to be asked for.
       */
      handler: async (args) => {
        const active = await ensureClient();
        if (active === null) return { ok: false, reason: 'not signed in' };
        const pr = sync.prsOf(args.task).find((entry) => prKey(entry) === args.pr);
        if (pr === undefined) return { ok: false, reason: 'no such pull request' };

        const key = `${args.pr}@${pr.updatedAt}`;
        // Already have it, and the branch has not moved since.
        if (fetched.has(key)) return { ok: true, files: pr.files?.length ?? 0, cached: true };

        const task = await taskById(args.task);
        const slug = await remotes.of(repoPathOf(pr, task));
        if (slug === null) return { ok: false, reason: 'that repo has no GitHub remote' };

        try {
          const files = await active.files(slug, pr.number);
          sync.withFiles(args.task, args.pr, files);
          fetched.add(key);
          if (files.length >= FILE_PAGE) {
            // Said out loud rather than silently truncated: a capped list that
            // says nothing reads as "that is all of them".
            ctx.log.info(`${args.pr}: showing the first ${FILE_PAGE} files`);
          }
          return { ok: true, files: files.length, capped: files.length >= FILE_PAGE };
        } catch (error: unknown) {
          return { ok: false, reason: message(error) };
        }
      },
    }),
  );

  /**
   * One commit's diff, held forever once fetched.
   *
   * A commit is IMMUTABLE, which is the whole difference from `github.diff`:
   * that one keys its cache on the PR's `updatedAt` because a branch moves under
   * it, and this one needs no such key because a sha names bytes that cannot
   * change. Asking twice is a bug, not a refresh.
   */
  const commitFiles = new Map<string, readonly ChangedFile[]>();

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.commitDiff, {
      schema: s.object({ task: s.string(), pr: s.string(), sha: s.string() }),
      handler: async (args) => {
        const held = commitFiles.get(args.sha);
        if (held !== undefined) return { ok: true, files: held, cached: true };

        const active = await ensureClient();
        if (active === null) return { ok: false, reason: 'not signed in' };
        const pr = sync.prsOf(args.task).find((entry) => prKey(entry) === args.pr);
        if (pr === undefined) return { ok: false, reason: 'no such pull request' };

        const task = await taskById(args.task);
        const slug = await remotes.of(repoPathOf(pr, task));
        if (slug === null) return { ok: false, reason: 'that repo has no GitHub remote' };

        try {
          const files = await active.commit(slug, args.sha);
          commitFiles.set(args.sha, files);
          return { ok: true, files, cached: false };
        } catch (error: unknown) {
          return { ok: false, reason: message(error) };
        }
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.open, {
      title: 'GitHub: Open on GitHub',
      schema: s.object({ url: s.string() }),
      /**
       * The one thing this app will not reimplement.
       *
       * `open(1)` with an ARGV ARRAY, never a shell string: `exec` spawns the
       * program directly, so nothing in the URL is interpreted — which matters
       * because this string came from an API response and a shell would treat a
       * repo description as a command line. The prefix check above is the second
       * guard, and it is about where the click can take you rather than about
       * quoting.
       *
       * There is no kernel `shell.openExternal` to use instead. When there is,
       * this is one line.
       */
      handler: async (args) => {
        if (!args.url.startsWith('https://github.com/')) return { ok: false, reason: 'not a github.com URL' };
        const opened = await process.exec(['/usr/bin/open', args.url], {
          cwd: ctx.homeDir,
          env: { HOME: ctx.homeDir, USER: ctx.userName },
          timeoutMs: 5_000,
        });
        return opened.ok ? { ok: true } : { ok: false, reason: opened.stderr.trim() || 'could not open a browser' };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.handToAgent, {
      title: 'GitHub: Hand to Agent',
      schema: s.object({
        task: s.string(),
        pr: s.string(),
        /** A check by name, a thread by id, or neither for the whole review. */
        check: s.optional(s.string()),
        thread: s.optional(s.string()),
        /**
         * Hand it to THIS agent — what the picker sends back.
         *
         * Trusted only as far as liveness: a session that is not running is
         * refused rather than written to, because the list the user chose from
         * is a moment old and an agent can finish while a menu is open.
         */
        session: s.optional(s.string()),
      }),
      /**
       * The verb the rest of this extension exists to make possible.
       *
       * **It goes to the agent that is already working**, and spawns one only
       * when there is nobody. That order is the whole feature: the agent in that
       * worktree has the code loaded and the context of what it just did, and
       * opening a second one beside it would make you the thing that reconciles
       * them.
       *
       * `pickAgent` decides which, and never picks a workstream in another repo
       * — being told about a file it does not have is worse than not being told.
       * Liveness is checked against `sessions.list` rather than believed from the
       * task's record, which outlives the ptys it names (ADR 0036).
       *
       * The text is PASTED, not typed: a typed newline is an Enter press, so a
       * six-line prompt typed into a TUI submits its first line and scatters five
       * into whatever runs next. `sessions.write` routes through `host.paste`,
       * which brackets iff the running program asked for that.
       *
       * The prompt itself is built in `model/prompt.ts`, tested there, and quotes
       * the evidence rather than summarising it.
       */
      handler: async (args) => {
        const pr = sync.prsOf(args.task).find((entry) => prKey(entry) === args.pr);
        if (pr === undefined) return { ok: false, reason: 'no such pull request' };

        const prompt = promptFor(pr, args.check, args.thread);
        if (prompt === null) return { ok: false, reason: 'nothing to hand over' };

        const task = await taskById(args.task);
        const listed = await commands.invoke(SESSIONS_LIST_COMMAND, {});
        const live = listed.ok ? readLive(listed.value) : new Set<string>();
        /*
         * Two reads, because they answer different questions: `sessions.list`
         * says which ptys are alive and `agents.list` says what each one is
         * doing. A session can be running with no agent adopted, and a record
         * can name an agent whose pty has gone.
         */
        const agentStates = await commands.invoke(AGENTS_LIST_COMMAND, {});
        const states = agentStates.ok ? readStates(agentStates.value) : new Map();
        const withState = (task?.agents ?? []).map((agent) => {
          const found = states.get(agent.id);
          return found === undefined ? agent : { ...agent, ...found };
        });

        /*
         * A session the caller named wins, and is still checked for liveness.
         * The list it was chosen from is a moment old, and an agent can finish
         * while a menu is open — writing to a dead pty would swallow the prompt
         * with nothing anywhere saying so.
         */
        const named = args.session !== undefined && live.has(args.session) ? args.session : undefined;
        const pick = named === undefined ? pickAgent(withState, live, pr.repoKey) : null;

        /*
         * More than one agent could be meant, so ASK — and answer `ok` while
         * doing nothing.
         *
         * Deliberately not a failure: nothing went wrong, and a caller that
         * treats it as an error would show a red line for a question. The
         * candidates come back labelled with what a person needs to tell them
         * apart, which is their pane's title and the directory they are in —
         * neither of which this extension knows, so both are looked up.
         */
        if (pick?.kind === 'choose') {
          return { ok: true, choose: await describe(pick.candidates, task, listed.ok ? listed.value : []) };
        }

        const target = named ?? (pick?.kind === 'one' ? pick.session : undefined);
        if (target !== undefined) {
          const written = await commands.invoke(SESSIONS_WRITE_COMMAND, {
            session: target,
            text: prompt,
            // Sent, not left as a draft. The gesture is "hand this over", and a
            // prompt sitting unsent in a pane you are not looking at is a
            // hand-off that did not happen.
            submit: true,
          });
          if (written.ok) {
            return { ok: true, handedTo: target, ...(pick?.kind === 'one' ? { because: pick.because } : {}) };
          }
          /*
           * Fall THROUGH to spawning rather than reporting the failure.
           *
           * The realistic cause is a session that exited between the liveness
           * check and this call — the agent finished while you were reading its
           * PR — and in that case spawning is exactly what should happen. A
           * failure the user has to read and retry by hand would be the app
           * noticing the race and making it their problem.
           */
          ctx.log.warn(`could not write to ${target}, spawning instead — ${written.error.message}`);
        }

        const spawned = await commands.invoke(TASKS_SPAWN_COMMAND, {
          task: args.task,
          // The worktree the PR's code is in. `repoKey` is the task's name for
          // it, which is exactly what `tasks.spawn` takes.
          repo: pr.repoKey,
          prompt,
        });
        return spawned.ok ? { ok: true, spawned: true } : { ok: false, reason: spawned.error.message };
      },
    }),
  );

  /**
   * Merge one PR, with everything it needs looked up first.
   *
   * Shared by `github.merge` and `github.land` so the two cannot disagree about
   * what merging means — which matters more for the second, since it does this
   * several times in a row and a difference would show up halfway through.
   */
  const mergeOne = async (
    taskId: string,
    key: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    const active = await ensureClient();
    if (active === null) return { ok: false, reason: 'not signed in' };
    const pr = sync.prsOf(taskId).find((entry) => prKey(entry) === key);
    if (pr === undefined) return { ok: false, reason: 'no such pull request' };
    // Re-checked here rather than trusted from the caller: the pane drew its
    // button from an answer that is up to twenty seconds old, and a check can go
    // red in that time.
    if (!canMerge(pr)) return { ok: false, reason: `${pr.repoKey} #${pr.number} cannot merge` };

    const slug = await remotes.of(repoPathOf(pr, await taskById(taskId)));
    if (slug === null) return { ok: false, reason: 'that repo has no GitHub remote' };
    return active.merge(slug, pr.number);
  };

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.merge, {
      title: 'GitHub: Merge',
      schema: s.object({ task: s.string(), pr: s.string() }),
      handler: async (args) => {
        const merged = await mergeOne(args.task, args.pr);
        // Immediately, and not on the next tick: the row and the pane both say
        // `open` until something re-reads, and the user just pressed Merge.
        sweep(true);
        return merged;
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.land, {
      title: 'GitHub: Land Task',
      schema: s.object({ task: s.string() }),
      /**
       * Merge every PR of the task, bottom of the stack first.
       *
       * Three properties, and each is the reason this is a verb rather than a
       * loop in the pane:
       *
       *   - **In `landOrder`.** Merging a stack top-down closes the lower PRs
       *     against a base that no longer exists. GitHub re-targets a stacked PR
       *     when its base merges, which is exactly what makes bottom-up work.
       *   - **Re-read between each.** Merging #1 is what makes #2 mergeable, so
       *     the second decision cannot be made from the answer the first was.
       *   - **Stops at the first refusal**, and says which and why. It does not
       *     skip ahead: the ones after it are behind it for a reason, and
       *     merging past a blocker is how you land half a change.
       */
      handler: async (args) => {
        const order = landOrder(sync.prsOf(args.task));
        if (order.length === 0) return { ok: false, reason: 'nothing to land' };

        const merged: string[] = [];
        for (const pr of order) {
          const key = prKey(pr);
          const result = await mergeOne(args.task, key);
          if (!result.ok) {
            // Re-synced before answering, so the pane redraws showing exactly
            // what did land — a half-finished sequence must not look like a
            // failed one.
            await pass(true);
            return { ok: false, reason: result.reason, merged, stoppedAt: key };
          }
          merged.push(key);
          // Between each, not at the end: the next PR's mergeability is a
          // consequence of this one, and GitHub needs a moment to recompute it.
          await pass(true);
        }
        return { ok: true, merged };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(GITHUB_COMMANDS.seed, {
      title: 'GitHub: Seed Fake PRs (dev)',
      schema: s.object({
        task: s.optional(s.string()),
        clear: s.optional(s.boolean()),
        /** Just the one PR, so the tab-IS-the-PR case can be looked at. */
        only: s.optional(s.boolean()),
        /**
         * `owner/name` — seed with the REAL pull requests of a real repo instead
         * of invented ones.
         *
         * The reason this exists: a task's branch is minted, so a PR whose head
         * is `fix/something` can never belong to a task you did not rename by
         * hand first. Without this door the only way to look at genuine GitHub
         * data in the app is to open a pull request on a branch that happens to
         * match, which is a change to somebody's repository made in order to
         * take a screenshot.
         */
        repo: s.optional(s.string()),
        /** Which branch to ask about. Defaults to the task's own. */
        head: s.optional(s.string()),
      }),
      /**
       * Invented PRs on a task, so this surface can be looked at.
       *
       * Refuses outside a dev build — a sentence a developer can read, rather
       * than the command simply not existing, which reads as a typo. The next
       * real sync overwrites what this put there, which is the right lifetime
       * for a fixture: it is for looking at now, not for keeping.
       */
      handler: async (args) => {
        if (!ctx.isDev) return { ok: false, reason: 'github.seed is a dev-build door' };
        const tasks = await listTasks();
        const task = args.task === undefined ? tasks[0] : tasks.find((entry) => entry.id === args.task);
        if (task === undefined) return { ok: false, reason: 'no task to seed' };
        // `{ clear: true }` hands the task back to the real syncer.
        if (args.clear === true) {
          sync.unseed(task.id);
          sweep(true);
          return { ok: true, task: task.id, cleared: true };
        }
        if (args.repo !== undefined) {
          const [owner, name] = args.repo.split('/');
          if (owner === undefined || name === undefined || name === '') {
            return { ok: false, reason: `\`${args.repo}\` is not owner/name` };
          }
          const active = await ensureClient();
          if (active === null) return { ok: false, reason: 'not signed in' };
          const slug = { owner, repo: name };
          const head = args.head ?? (await readBranch(process, `${task.root}/${name}`));
          if (head === null) return { ok: false, reason: `no branch in ${task.root}/${name}` };
          const real = await active.pullRequests(slug, head, name);
          /*
           * Patches fetched HERE rather than left to the Files tab, because
           * `github.diff` resolves its repo from the local worktree's remote —
           * and the whole point of this door is that the PR belongs to a repo
           * the task does not have checked out. Marking the key `fetched` is the
           * other half: it stops the panel asking for a diff it already has.
           */
          const withPatches = await Promise.all(
            real.map(async (pr) => {
              const files = await active.files(slug, pr.number);
              fetched.add(`${prKey(pr)}@${pr.updatedAt}`);
              return { ...pr, files };
            }),
          );
          sync.seed(task.id, withPatches);
          return { ok: true, task: task.id, prs: withPatches.length, repo: args.repo };
        }

        const all = fixturePrs(clock.now());
        // One live PR and nothing finished is the case that skips the list
        // entirely, and it is the common one — worth being able to see.
        const prs = args.only === true ? all.slice(0, 1) : all;
        sync.seed(task.id, prs);
        return { ok: true, task: task.id, prs: prs.length };
      },
    }),
  );

  /**
   * The agent in this task's worktrees, for the conversation view's Agent block.
   *
   * The ORCHESTRATOR when there is one, else whichever workstream is live —
   * deliberately not `pickAgent`, which answers a different question ("who
   * should this go to", per repo). This answers "who is on this task", and the
   * orchestrator is the truest single answer to that.
   */
  /**
   * What each of a task's agents is CALLED — the title of the pane it runs in.
   *
   * A pane's name is a layout fact and the whole point of it is that a user
   * typed it or a program set it, so it is asked for rather than derived. Two
   * callers want it and they ask the same way; before this, one asked and the
   * other invented a label, which is how the same agent had two names in one
   * pane.
   */
  const paneTitles = async (task: ListedTask | undefined): Promise<ReadonlyMap<string, string>> => {
    const titleOf = new Map<string, string>();
    if (task?.group === undefined || task.group === null) return titleOf;
    const roots = await commands.invoke(GITHUB_LAYOUT.listRoots, { group: task.group });
    if (roots.ok) for (const [session, title] of readPaneTitles(roots.value)) titleOf.set(session, title);
    return titleOf;
  };

  const branchAgent = async (
    task: ListedTask | undefined,
    states: ReadonlyMap<string, { state: string; kind?: string }>,
  ): Promise<{ agent?: { title: string; state: string } }> => {
    const agents = (task?.agents ?? []).filter((agent) => states.has(agent.id));
    const chosen = agents.find((agent) => agent.role === 'orchestrator') ?? agents[0];
    if (chosen === undefined) return {};
    const found = states.get(chosen.id);
    const titleOf = await paneTitles(task);
    return {
      agent: {
        title: agentName(chosen, titleOf.get(chosen.id)),
        state: found?.state ?? 'idle',
      },
    };
  };

  /**
   * A candidate, labelled with what a person needs to tell it apart.
   *
   * Neither half is this extension's to know, so both are looked up: the
   * DIRECTORY comes from `sessions.list` (which is already in hand — it is the
   * liveness read), and the TITLE from the layout, because a pane's name is a
   * layout fact and the whole point of it is that a user typed or a program set
   * it.
   *
   * Falls back rather than failing: an agent whose pane has no title is labelled
   * by its repo, and one with neither is labelled by its role. A row in a picker
   * has to say something, and a bare session id says nothing a person can use.
   */
  const describe = async (
    candidates: readonly TaskAgent[],
    task: ListedTask | undefined,
    sessions: unknown,
  ): Promise<readonly AgentChoice[]> => {
    const cwdOf = new Map<string, string>();
    if (Array.isArray(sessions)) {
      for (const entry of sessions) {
        if (typeof entry !== 'object' || entry === null) continue;
        const row = entry as { id?: unknown; cwd?: unknown };
        if (typeof row.id === 'string' && typeof row.cwd === 'string') cwdOf.set(row.id, row.cwd);
      }
    }

    const titleOf = await paneTitles(task);

    return candidates.map((agent) => ({
      session: agent.id,
      /*
       * `claude · sdk worktree` — the KIND, then what this one is.
       *
       * The kind is there because a row saying only `sdk worktree` reads as a
       * directory rather than as somebody you can hand work to, and it is the
       * word that will matter the day a second agent kind exists. The vendor
       * name is not this extension's to know, so it comes off the agent record.
       */
      title: `${agent.kind ?? 'agent'} · ${titleOf.get(agent.id) ?? agent.repo ?? agent.role}`,
      cwd: cwdOf.get(agent.id) ?? '',
      ...(agent.repo === undefined ? {} : { repo: agent.repo }),
      role: agent.role,
      mark: markFor(agent),
      // What choosing this row DOES, said in advance rather than discovered by
      // watching a pane not respond.
      means: handingMeans(agent),
    }));
  };

  /**
   * Where a PR's code lives on this disk.
   *
   * Through the task's repo list rather than remembered on the PR, because the
   * PR came from GitHub and GitHub does not know about this machine. An unknown
   * repo yields the empty string, which `Remotes` then answers `null` for — the
   * same "no GitHub remote" path as a repo that genuinely has none.
   */
  const repoPathOf = (pr: PullRequest, task: ListedTask | undefined): string =>
    task?.repos.find((repo) => repo.name === pr.repoKey)?.path ?? '';
}

/** One row of the picker — what a person reads in order to choose. */
export interface AgentChoice {
  readonly session: string;
  readonly title: string;
  readonly cwd: string;
  readonly repo?: string;
  readonly role: 'orchestrator' | 'workstream';
  /** Its state, as one of the app's five marks. */
  readonly mark: 'working' | 'waiting' | 'resting' | 'failed';
  /** `sends now` or `queues` — what handing to it means right now. */
  readonly means: 'sends now' | 'queues';
}

/** Which prompt this gesture means. */
function promptFor(pr: PullRequest, check?: string, thread?: string): string | null {
  if (check !== undefined) {
    const found = pr.checks.find((entry) => entry.name === check) ?? firstFailure(pr);
    return found === undefined ? null : checkPrompt(pr, found);
  }
  if (thread !== undefined) {
    const found = pr.threads.find((entry) => entry.id === thread);
    return found === undefined ? null : threadPrompt(pr, found);
  }
  return reviewPrompt(pr);
}

/**
 * The kernel's layout verbs, spelled out.
 *
 * An extension may import `@shepherd/sdk` and nothing else, so these arrive as
 * strings the same way `tasks` writes them. They are the kernel's rather than
 * another extension's, so there is no point id to pin them against — the
 * dispatcher's "unknown command" is the error, and it is a typed one.
 */
const GITHUB_LAYOUT = {
  newTab: 'layout.newTab',
  switchRoot: 'layout.switchRoot',
  listRoots: 'layout.listRoots',
} as const;

/** How a rollup state reads, in the palette's four tones. */
const TONES: Readonly<Record<TaskPrState, CardFact['tone']>> = {
  failed: 'negative',
  waiting: 'negative',
  running: 'neutral',
  approved: 'positive',
  open: 'quiet',
  merged: 'quiet',
  none: 'quiet',
};
