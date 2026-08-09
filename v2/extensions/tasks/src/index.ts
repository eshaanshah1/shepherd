import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  fuzzyMatch,
  s,
  sessionId,
  toDisposable,
  type AttentionLevel,
  type ExtensionContext,
  type PresentEffect,
  type Shepherd,
} from '@shepherd/sdk';
import { REPO_SUGGESTIONS_POINT, TASK_COMMANDS, TASK_VIEWS } from './manifest.ts';
import { TaskStore, type RepoArchive, type RepoRef, type TaskRecord, type TaskSession } from './store.ts';
import { slugify, uniqueSlug } from './model/slug.ts';
import { expandHome } from './model/repo-path.ts';
import { repoName } from './model/repo-name.ts';
import { completeDirectories, looksLikeRepo } from './suggest.ts';
import { taskRootId } from './model/root-id.ts';
/**
 * Asked of `agents-core`, never of a vendor: a task that named `claudeCode.*`
 * would be a task that knows which agent it hired (D11).
 */
const AGENTS_RESUME_TARGET = 'agents.resumeTarget';
const AGENTS_RESUME_COMMAND = 'agents.resumeCommand';
import { displayState } from './model/lifecycle.ts';
import { synthTaskRoot } from './model/root-synth.ts';
import { planLaunch } from './model/launch.ts';
import { writePastedImages, type PastedImage } from './images.ts';
import { ARCHIVE_TTL_MS, expired } from './model/expiry.ts';
import {
  archiveWorktree,
  materializeTaskRoot,
  provisionRepo,
  readContribution,
  removeWorktree,
  restoreWorktree,
} from './provision.ts';
import { seedClaudeTrust } from './trust.ts';

/**
 * `tasks` — the extension M3 exists for, and the one that has to prove the ADE
 * bet: it consumes the same public API a third party gets, with no privileged
 * path anywhere. If something here needed a core special case, the API is wrong.
 *
 * P3 is the store and the verbs. Provisioning (worktrees, the synthesized task
 * root) is P4, and the composer and the sidebar tree are M3b — every verb below
 * is reachable from the command registry, which is the CLI-first posture §7b
 * chose and is what makes the milestone useful before it has any UI at all.
 */

/**
 * What a repo picker is asked. Coarse and answerable — a question, not a step.
 *
 * The default provider ranks by usage and recency; the canonical third-party one
 * reads `input.brief` and guesses. Both answer the same question, and neither can
 * see how provisioning works.
 */
export interface RepoSuggestionProvider {
  suggest(input: { readonly title: string; readonly brief: string }): readonly RepoRef[];
}

/**
 * One row of the picker. A `RepoRef` plus the three things a picker draws with:
 * whether it is a repo at all, and where it came from.
 *
 * The positions are computed by the ranker and carried across the port rather
 * than re-derived in the view — a highlighter that re-runs the matcher is a
 * second chance to disagree with the thing that did the ordering.
 */
export interface RepoSuggestion extends RepoRef {
  readonly isRepo: boolean;
  readonly source: 'history' | 'filesystem';
}

/** See the `suggestRepos` handler: a list you arrow through, not one you scroll. */
const SUGGESTION_LIMIT = 10;

export interface TasksAPI {
  list(): readonly TaskRecord[];
  get(id: string): TaskRecord | undefined;
}

const repoArg = s.object({ path: s.string(), name: s.string() });

/**
 * How long a pane is given to report its session, and how often it is asked.
 *
 * Five seconds of 500ms polls. A pane that has not produced a session by then
 * has a reason — no window, a renderer that never mounted it — and asking
 * forever would keep a timer alive for the life of the app to learn nothing.
 */
/** What this extension puts in a tree. Structural, so the SDK type stays the SDK's. */
interface TreeItemOut {
  id: string;
  label: string;
  description?: string;
  section?: boolean;
  tint?: string;
  collapsed?: boolean;
  command?: { id: string; args?: unknown };
  /**
   * The row's context menu. Structural, like everything else here — the SDK's
   * `TreeItemAction` is the contract and this is the shape that satisfies it,
   * so the extension keeps compiling against types it does not import.
   */
  actions?: readonly (
    | { id: string; label: string; icon?: string; danger?: boolean; shortcut?: string; args?: unknown }
    | { separator: true }
  )[];
}

const CORRELATE_ATTEMPTS = 10;
const CORRELATE_INTERVAL_MS = 500;

/**
 * Core's `ATTENTION_TOPIC` and its payload, as a literal and a local shape.
 *
 * Extension code may import `@shepherd/sdk` and nothing else, so it cannot
 * reach `@shepherd/core` for either — the same reason `ext-host/api.ts` keeps
 * its own copy of this string. A topic name is public vocabulary, like a command
 * id; the interface is a read of what the bus carries and is deliberately
 * narrower than core's (a `PaneID` is an opaque string out here).
 */
const ATTENTION_TOPIC = 'attention.changed';

interface AttentionChanged {
  readonly pane: string;
  readonly level: AttentionLevel;
  readonly reason: string;
}

/**
 * A session ended — the kernel's own signal, carrying the pane it was on.
 *
 * The exact event, not the reconciliation sweep's inference: closing a pane is
 * something the user DID, and a task that goes on reporting `running` because
 * nothing told it otherwise is the app lying about the only thing its sidebar
 * is for.
 */
const SESSION_EXIT_TOPIC = 'session.exit';

/**
 * The layout saying a pane group ran out of panes.
 *
 * This is what "the task is finished with" is read from, and the reason it is
 * not read from `session.exit` is worth stating: pane ids are regenerated when
 * a layout is restored, so after a relaunch a task's recorded panes name panes
 * that do not exist. Counting them down to zero therefore never gets there, and
 * closing the last pane of a task created before the last restart archived
 * nothing at all. The layout knows a root emptied whoever opened its panes and
 * however many times the app has restarted since.
 */
const ROOT_CLOSED_TOPIC = 'layout.rootClosed';

interface RootClosed {
  readonly root?: string;
}

interface SessionExited {
  readonly sessionId: string;
  readonly paneId?: string;
}

/**
 * What the orchestrator is told. Deliberately thin: the generated `CLAUDE.md`
 * at its cwd already carries the brief and the repo map (ADR 0029), so
 * restating them here would be the same text twice, drifting.
 */
function orchestratorPrompt(task: { title: string; brief: string }): string {
  return task.brief.trim() === '' ? `Start on the task "${task.title}".` : task.brief;
}

export function activate(ctx: ExtensionContext, api: Shepherd): TasksAPI {
  const { commands, events, points, views } = api.proposed;
  const store = new TaskStore(ctx.storage);
  /** Per-repo provisioning state. In memory, deliberately — see `provision`. */
  const provisioning = new Map<string, 'working' | 'ready' | 'failed'>();

  /**
   * Which tasks are mid-operation, and what the operation is called.
   *
   * Archiving snapshots and removes a worktree per repo, and restoring rebuilds
   * them; both take git-shaped seconds, during which a row that says nothing is
   * a row you press again. In memory for the same reasons `provisioning` is:
   * it is meaningless after a restart (nothing is mid-anything) and routing it
   * through KV would make each transition a write across the port.
   *
   * A word rather than a percentage, and the row draws a spinner rather than a
   * bar, because there is no honest denominator here — `git worktree add` and a
   * snapshot commit report no progress, and a bar over them would be an
   * animation pretending to measure something.
   */
  const busy = new Map<string, 'archiving' | 'restoring'>();

  /** Run a long operation with the row saying so, whatever the outcome. */
  async function whileBusy<T>(taskId: string, what: 'archiving' | 'restoring', run: () => Promise<T>): Promise<T> {
    busy.set(taskId, what);
    changed();
    try {
      return await run();
    } finally {
      // `finally`, so a refusal — the conflicted-worktree case the archive verb
      // exists to have — leaves a row that is idle and wrong-looking rather than
      // one that spins forever.
      busy.delete(taskId);
      changed();
    }
  }

  /**
   * What each pane is currently asking of you, mirrored from the bus.
   *
   * **Keyed by PANE, and that is not an implementation detail.** The topic is
   * pane-keyed because core stores attention by pane (a session can be rebound,
   * a pane cannot), and a task's session may still be carrying its `pending-*`
   * placeholder id while `correlate` catches up — so keying this by session id
   * would lose exactly the attention raised in the first seconds of a spawn,
   * which is when an agent is most likely to ask something.
   *
   * In memory and never stored, for the same reason `provisioning` is not: it is
   * somebody else's fact, it changes on a second timescale, and after a restart
   * there is no attention because there are no panes.
   *
   * It also self-cleans without a reconciliation pass: the store emits on every
   * clear as well as every change, including the viewing-clear and the purge
   * when a pane closes, so a `none` always arrives for an entry that stops
   * mattering.
   */
  const attention = new Map<string, AttentionLevel>();

  /**
   * D4, made real: `needs-you` is READ from the panes, never written anywhere.
   *
   * A task's sessions may include ones whose pane never mounted (`pane`
   * undefined); those contribute nothing rather than a guess.
   */
  const attentionOf = (task: TaskRecord): readonly AttentionLevel[] =>
    task.sessions.flatMap((session) => {
      const level = session.pane === undefined ? undefined : attention.get(session.pane);
      return level === undefined ? [] : [level];
    });

  /**
   * Subscribing to the topic, WITHOUT declaring the permission.
   *
   * `events.on` is membership-gated only — being a loaded extension is the whole
   * of the check — while `attention.set`/`clear` are what the `attention`
   * permission guards. So this is a read of a fact `agents-core` publishes, and
   * ADR 0026's single-writer rule is untouched: nothing below writes attention,
   * it only mirrors what was announced. See the manifest's comment for why
   * declaring the permission would be the actual violation.
   */
  ctx.subscriptions.push(
    events.on<AttentionChanged>(ATTENTION_TOPIC, (payload) => {
      // Structural, not schematic: the payload crossed a port, and a malformed
      // one must be dropped rather than keying the mirror on `undefined` — which
      // would then never be cleared, since no `none` can name that key.
      if (typeof payload?.pane !== 'string') return;
      let delta: boolean;
      if (payload.level === 'none') {
        delta = attention.delete(payload.pane);
      } else {
        delta = attention.get(payload.pane) !== payload.level;
        attention.set(payload.pane, payload.level);
      }
      // The tree is pull-based (ADR 0031): the host re-asks `children()` only
      // when nudged, so a mirror that changed and did not nudge is a sidebar
      // still showing the old grouping. Nudged on a real delta only, because a
      // level can be re-announced with a new reason and nothing here has moved.
      if (delta) changed();
    }),
  );

  const suggestions = points.define<RepoSuggestionProvider>(REPO_SUGGESTIONS_POINT, {
    order: 'priority',
  });
  ctx.subscriptions.push(suggestions);

  /**
   * The dogfood rule one level deeper: the built-in ranking registers through the
   * point like anybody else, so replacing it is a registration rather than a fork.
   *
   * It answers from the PICKED HISTORY — every path the user has actually put on
   * a task, with a count and a timestamp, ranked by `historyScore` (frequency ×
   * recency; the formula is argued in `repo-history.ts`). It used to answer with
   * the repos of the most recent tasks, which was a proxy for the question and a
   * bad one: a repo added to nine tasks and a repo added to one looked identical,
   * and a task archived months ago kept voting.
   *
   * It ignores `title`/`brief`, deliberately. The canonical third-party provider
   * is the one that reads the brief and guesses; this one knows what you use.
   */
  ctx.subscriptions.push(
    suggestions.register(
      {
        // Stored already ranked, so this is a projection and not a second
        // opinion about the order.
        suggest: () => store.repoHistory().map((use) => ({ path: use.path, name: repoName(use.path) })),
      },
      { priority: 0 },
    ),
  );

  /**
   * The composer's question — now two questions with one answer.
   *
   * **History**, from the point and nothing else. Every provider is asked and the
   * answers are concatenated in priority order, deduped by path — a second
   * provider must be able to ADD a repo the first did not think of, which is the
   * whole reason this is a point. A provider that throws is dropped with a line
   * in the log rather than taking the picker down: a suggestion is an
   * accelerator, and losing one must not stop a task being created by hand. The
   * `query` filters them (as a fuzzy match over the whole path, so `shep` finds
   * `~/Home/dev/shepherd`) and never REORDERS them: the point's order is the
   * ranking, and re-sorting it by match quality here would silently overrule a
   * provider that had a better reason.
   *
   * **The filesystem**, one level, for the same query — so a path you have never
   * used is still one keystroke and a Tab away. `suggest.ts` has that half.
   *
   * Ranked history-first because a repo you have worked in is a better guess
   * than a directory that merely sits nearby, and **capped at ten** because the
   * list is a keyboard target: ten is the whole of it under one thumb of
   * arrowing, and past that the honest answer is "type another character", which
   * the fuzzy filter rewards immediately.
   *
   * **A candidate that is not a repo is MARKED, never dropped.** Excluding them
   * would make the completion useless as a navigator — `~/Home/dev` is not a
   * repo and is exactly the row you need in order to reach the ones inside it —
   * and the mark is what stops a non-repo being picked by accident.
   */
  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.suggestRepos, {
      title: 'Tasks: Suggest Repos',
      schema: s.object({
        title: s.optional(s.string()),
        brief: s.optional(s.string()),
        query: s.optional(s.string()),
      }),
      handler: (args) => {
        const input = { title: args.title ?? '', brief: args.brief ?? '' };
        // Expanded HERE, like `tasks.create` does, so the field and the CLI flag
        // keep agreeing about what `~` means.
        const query = expandHome((args.query ?? '').trim(), ctx.homeDir);

        const fromPoint = new Map<string, RepoRef>();
        for (const provider of suggestions.all()) {
          try {
            for (const repo of provider.suggest(input)) {
              if (!fromPoint.has(repo.path)) fromPoint.set(repo.path, repo);
            }
          } catch (error: unknown) {
            ctx.log.warn(`a repo-suggestion provider threw and was skipped — ${String(error)}`);
          }
        }

        const out: RepoSuggestion[] = [];
        for (const repo of fromPoint.values()) {
          const hit = fuzzyMatch(query, repo.path);
          if (hit === null) continue;
          out.push({
            path: repo.path,
            name: repo.name,
            isRepo: looksLikeRepo(repo.path),
            source: 'history',
          });
        }

        for (const candidate of completeDirectories(query, ctx.homeDir)) {
          if (fromPoint.has(candidate.path)) continue;
          out.push({
            path: candidate.path,
            name: repoName(candidate.path),
            isRepo: candidate.isRepo,
            source: 'filesystem',
          });
        }

        return out.slice(0, SUGGESTION_LIMIT);
      },
    }),
  );

  /**
   * A pane closed, so the session that ran in it is gone: drop it.
   *
   * Bookkeeping only. Whether the TASK is finished with is the next
   * subscription's question, and it asks the layout rather than counting these
   * down to zero — see `ROOT_CLOSED_TOPIC` for why the count is unreliable.
   *
   * Matched on the PANE, not the session id, for the reason the attention
   * mirror is pane-keyed: a session may still be carrying its `pending-*`
   * placeholder when it dies, and then its id matches nothing.
   */
  ctx.subscriptions.push(
    events.on<SessionExited>(SESSION_EXIT_TOPIC, (payload) => {
      const pane = payload?.paneId;
      if (typeof pane !== 'string') return;
      for (const task of store.list()) {
        if (!task.sessions.some((session) => session.pane === pane)) continue;
        const sessions = task.sessions.filter((session) => session.pane !== pane);
        store.put({ ...task, sessions });
        changed();
        ctx.log.info(`task ${task.id}: pane ${pane} closed, ${sessions.length} session(s) left`);
      }
    }),
  );

  /**
   * A task's pane group emptying means the task is done.
   *
   * That is the user's own reading of the gesture, and it is the right one: you
   * do not close every window on a piece of work you intend to come back to
   * this minute. So it archives — the worktrees are snapshotted and removed,
   * and the row sinks to the bottom of the list rather than sitting among live
   * work as a draft nobody will read.
   *
   * Archiving rather than deleting is what makes the gesture safe: every
   * uncommitted line is in the snapshot, and `tasks.restore` puts it back
   * exactly. A task with nothing in it archives to nothing, which is the
   * "closing a scratch task disappears it" case with no special path.
   *
   * Only a RUNNING task — an already archived one has no worktrees to snapshot,
   * and a draft never had a pane to close.
   */
  ctx.subscriptions.push(
    events.on<RootClosed>(ROOT_CLOSED_TOPIC, (payload) => {
      const root = payload?.root;
      if (typeof root !== 'string') return;
      const task = store.list().find((candidate) => taskRootId(candidate.id) === root);
      if (task === undefined || task.lifecycle !== 'running') return;

      ctx.log.info(`task ${task.id}: its pane group closed`);

      void commands
        .invoke(TASK_COMMANDS.archive, { task: task.id })
        .then((result) => {
          // A refusal is the point of the verb: a conflicted worktree cannot be
          // snapshotted, so the task stays exactly as it is and says why.
          // Silence here would be work quietly not saved.
          if (!result.ok) {
            ctx.log.warn(
              `task ${task.id}: its panes closed but it could not be archived — ${result.error.message}`,
            );
          }
        })
        .catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: archiving on close threw — ${String(error)}`);
        });
    }),
  );

  /**
   * Archives die after thirty days.      }
    }),
  );

  /**
   * Archives die after thirty days.
   *
   * On startup only, which is the whole cadence it needs: an archive's age
   * changes by the day, and a timer checking a day-scale condition every few
   * minutes is a timer running for the life of the app to answer a question
   * that will still be true tomorrow. An app left open for a month sweeps on
   * its next launch, and nothing is lost by the delay — the snapshot is still
   * there, which is the failure mode you want from a garbage collector.
   *
   * `tasks.delete` does the work, so expiry has no second removal path: the
   * worktrees, the root and the record go the same way they go by hand, and a
   * bug fixed in one is fixed in both.
   */
  const sweep = (): void => {
    const stale = expired(store.list(), ctx.clock.now());
    for (const id of stale) {
      void commands.invoke(TASK_COMMANDS.delete, { task: id }).then((result) => {
        if (result.ok) {
          ctx.log.info(`expired task ${id} — archived more than ${ARCHIVE_TTL_MS / 86_400_000} days ago`);
        } else {
          // Reported, and the record stays: a task that fails to expire is one
          // whose worktrees somebody may still need, and a silent failure here
          // is disk that never gets freed and nobody ever hears about.
          ctx.log.warn(`task ${id} was due to expire and did not — ${result.error.message}`);
        }
      });
    }
    if (stale.length > 0) changed();
  };

  const nextId = (): string => `task-${ctx.clock.now()}-${store.list().length}`;

  /**
   * Start an agent, in a directory, in a pane — the whole of what "spawn"
   * means today.
   *
   * Three seams, none of them new: a layout verb opens the pane (with the cwd
   * and the one line to type), the renderer creates the session when it mounts,
   * and the kernel injects the correlation env into it (ADR 0025) so the
   * agent's hooks land like any other pane's.
   *
   * **A task owns a root**, and that is what decides which layout verb runs.
   * `layout.openRoot` is invoked unconditionally and its `created` answer is the
   * branch: minted, and the task's first agent is the root's first pane; already
   * live, and this is a second agent joining a root that exists, which is a
   * `layout.split` into it. Asking the layout rather than counting the record's
   * sessions is deliberate — a restored task HAS sessions and may have no root
   * (archiving closed it), and a task whose root is live may have none recorded
   * yet. The store is the authority on which roots exist; the record is not.
   *
   * **The pane is created before the session exists**, so the record is written
   * optimistically with a placeholder id and the real one is filled in behind —
   * the same shape provisioning already has, for the same reason: the caller
   * gets an answer now and the slow half reports itself.
   *
   * A session with **no pane anywhere** is the sketch's other case (§4: a task
   * created on a phone, run on the Mac, rendered only there). It is not this:
   * ADR 0022 makes `layout.close` the one thing that ends a session, so a
   * session with no pane has no owner and no terminator. That is the remote
   * milestone's architecture, deliberately not widened here.
   */
  /**
   * Open a pane in the task's root and type one line into it.
   *
   * The half `startSession` and `resumeSession` share: which layout verb opens
   * the pane (mint the root, or split the live one), naming it, and taking the
   * window there. What differs between them is the LINE — a fresh agent reads a
   * prompt file, a resumed one names a session — and that is the whole of the
   * difference, which is why it is the only parameter.
   */
  async function openAgentPane(
    task: TaskRecord,
    input: {
      readonly cwd: string;
      readonly command: string;
      readonly title: string;
      /** Undo whatever was staged for the line that will now never run. */
      readonly onFailure: () => void;
    },
  ): Promise<string> {
    const root = taskRootId(task.id);
    const { cwd, command, title } = input;

    const opened = await commands.invoke<{ root: string; pane: string | null; created: boolean }>(
      'layout.openRoot',
      { root, cwd, initialCommand: command, title },
    );
    if (!opened.ok) {
      input.onFailure();
      throw new Error(`could not open the task's root: ${opened.error.code}: ${opened.error.message}`);
    }

    let pane: string;
    if (opened.value.created) {
      // The root was minted for this task, and its first pane IS the agent's.
      // `openRoot` names the pane at mint through its own `title` field, so
      // there is deliberately no rename on this path: a second invoke would set
      // the title the layout has already set.
      if (typeof opened.value.pane !== 'string') {
        input.onFailure();
        throw new Error(`the task's root was created with no pane to run the agent in`);
      }
      pane = opened.value.pane;
    } else {
      // The root is already live — a second agent joining the first, or a spawn
      // after a restore. `root` is named explicitly rather than left to default:
      // an unqualified split means "the root I am looking at", and a spawn
      // requested from the CLI while another task is on screen must not open a
      // pane in somebody else's task.
      const split = await commands.invoke<string>('layout.split', {
        axis: 'row',
        root,
        cwd,
        initialCommand: command,
      });
      if (!split.ok) {
        input.onFailure();
        throw new Error(`could not open a pane for the agent: ${split.error.code}: ${split.error.message}`);
      }
      pane = split.value;

      /**
       * Name the pane, in the one case the layout did not name it for us.
       *
       * A separate command from the split on purpose: `layout.split` takes the
       * cwd and the command to type and nothing else, and widening it so this
       * one caller could pass a title would put a `tasks` convenience into the
       * kernel's layout verb.
       *
       * A failure is logged and stepped over: the pane is open, the agent is
       * running in it and the session is about to be recorded — a title is the
       * one part of a spawn that is decoration, and throwing here would discard
       * a real pane over it.
       */
      const renamed = await commands.invoke('layout.rename', { pane, title });
      if (!renamed.ok) {
        ctx.log.warn(
          `task ${task.id}: pane ${pane} kept its own title — ${renamed.error.code}: ${renamed.error.message}`,
        );
      }
    }

    /**
     * And LAND you in it — v1's composer behaviour: you asked for work, so you
     * are taken to it. A spawn that opened a pane in a root nobody switched to
     * is an agent running somewhere off screen, which is the thing the sidebar
     * exists to stop being the normal case.
     *
     * A failure is a warn, not a failed spawn: the pane is real and the agent is
     * running in it either way, and refusing the spawn because the window would
     * not move would throw away work over navigation.
     */
    const switched = await commands.invoke('layout.switchRoot', { root });
    if (!switched.ok) {
      ctx.log.warn(
        `task ${task.id}: the window stayed where it was — ${switched.error.code}: ${switched.error.message}`,
      );
    }

    return pane;
  }

  async function startSession(
    task: TaskRecord,
    input: {
      readonly repo?: string;
      readonly prompt: string;
      readonly role: TaskSession['role'];
      readonly images?: readonly PastedImage[];
    },
  ): Promise<TaskSession> {
    const cwd = input.repo === undefined ? rootOf(task) : `${rootOf(task)}/${input.repo}`;

    // Under the extension's data dir but OUTSIDE any task root: the root is an
    // agent's cwd, and a prompt file sitting in it is junk in the workspace the
    // agent is about to describe.
    const promptDir = `${ctx.dataDir}/.prompts`;
    mkdirSync(promptDir, { recursive: true });

    /**
     * Pasted images land beside the prompt, and their tokens become paths.
     *
     * A directory per launch, not per extension: the files are `image-1.png`
     * and so on, so two tasks sharing a directory would have the second
     * overwrite the first's — and an agent would then read someone else's
     * screenshot with total confidence.
     */
    const stem = `${task.slug}-${ctx.clock.now()}`;
    const written =
      input.images === undefined || input.images.length === 0
        ? { brief: input.prompt, files: [] }
        : writePastedImages(`${promptDir}/${stem}`, { brief: input.prompt, images: input.images });
    if (written.files.length > 0) {
      ctx.log.info(`task ${task.id}: ${written.files.length} pasted image(s) at ${promptDir}/${stem}`);
    }

    const plan = planLaunch({
      promptFile: `${promptDir}/${stem}.txt`,
      prompt: written.brief,
    });
    // Before the split: the renderer types the command as soon as the pane's
    // session exists, and a `cat` that loses the race reads an empty prompt.
    writeFileSync(plan.promptFile, written.brief, 'utf8');

    const pane = await openAgentPane(task, {
      cwd,
      command: plan.command,
      title:
        input.role === 'orchestrator' ? task.title : `${task.title} · ${input.repo ?? 'workstream'}`,
      // The prompt file is consumed by the line that runs; if no line ever
      // runs, nothing else will ever delete it.
      onFailure: () => rmSync(plan.promptFile, { force: true }),
    });

    const session: TaskSession = {
      id: `pending-${ctx.clock.now()}`,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      role: input.role,
      pane,
    };
    ctx.log.info(`task ${task.id}: opened pane ${pane} in ${cwd} for a ${input.role}`);
    void correlate(task.id, session).catch((error: unknown) => {
      ctx.log.error(`task ${task.id}: correlating ${session.pane ?? '?'} threw — ${String(error)}`);
    });
    return session;
  }

  /**
   * Put a recorded session back — reattached, not restarted.
   *
   * The counterpart to the capture in `tasks.archive`: the target came from the
   * kind that owns the agent and goes back unread (D11), and the line that runs
   * carries no prompt because the transcript already holds one. Starting a fresh
   * agent on the original brief instead is the behaviour this replaces — the
   * same words with none of the work, which reads as the agent having forgotten
   * everything it did.
   *
   * The record's session id is left ALONE and `correlate` re-points it at the
   * new pty. A resumed Claude session keeps its own id (that is what `--resume`
   * means), but the kernel session is a new one, and the record's `id` is the
   * kernel's.
   */
  async function resumeSession(task: TaskRecord, session: TaskSession): Promise<void> {
    const target = session.resumeTarget;
    if (target === undefined) return;

    /**
     * The command comes from the agent kind, not from here (ADR 0035 §3).
     *
     * This file used to spell `claude --resume` through `planResume`, with a
     * comment saying it should not: "this is the seam where an agent kind should
     * eventually say it … hardcoded until a second kind exists". R1 supplied the
     * second CONSUMER, which is the same argument one word along, so the
     * hardcode is gone. `tasks` now stores an opaque token and asks for a
     * command — it never learns the binary or the flag.
     */
    const answer = await commands.invoke<unknown>(AGENTS_RESUME_COMMAND, { target });
    const command =
      answer.ok && typeof answer.value === 'object' && answer.value !== null
        ? (answer.value as { command?: unknown }).command
        : undefined;
    if (typeof command !== 'string' || command === '') {
      // Not a failure: a kind that cannot build a resume line, or none
      // registered yet. The task keeps the record and simply does not reattach.
      ctx.log.info(`task ${task.id}: session ${session.id} has no resume command`);
      return;
    }
    const cwd = session.repo === undefined ? rootOf(task) : `${rootOf(task)}/${session.repo}`;
    const pane = await openAgentPane(task, {
      cwd,
      command,
      title: session.role === 'orchestrator' ? task.title : `${task.title} · ${session.repo ?? 'workstream'}`,
      // Nothing was staged on disk for a resume — there is no prompt file.
      onFailure: () => undefined,
    });

    const now = store.get(task.id);
    if (now !== undefined) {
      store.put({
        ...now,
        sessions: now.sessions.map((entry) => (entry.id === session.id ? { ...entry, pane } : entry)),
      });
      changed();
    }
    ctx.log.info(`task ${task.id}: resumed ${session.role} in pane ${pane}`);
    void correlate(task.id, { ...session, pane }).catch((error: unknown) => {
      ctx.log.error(`task ${task.id}: correlating ${pane} threw — ${String(error)}`);
    });
  }

  /**
   * Learn the session id of a pane that was just opened.
   *
   * A poll, because there is no event to wait on: the renderer creates the
   * session, and what the host publishes is a layout snapshot rather than "this
   * pane got a pty". Bounded, and a `setTimeout` chain rather than an interval —
   * `Clock` has no `setInterval`, and reaching for one is what took a
   * contribution down in M3b (ADR 0031).
   *
   * A session that never appears leaves the record with its placeholder id and
   * a WARNING (D15): the pane is real either way, and a task quietly holding a
   * session id that addresses nothing is worse than one that says it does not
   * know.
   */
  async function correlate(taskId: string, session: TaskSession): Promise<void> {
    for (let attempt = 0; attempt < CORRELATE_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => ctx.clock.setTimeout(() => resolve(), CORRELATE_INTERVAL_MS));
      const listed = await commands.invoke<{ id: string; paneId?: string }[]>('sessions.list');
      if (!listed.ok) continue;
      const found = listed.value.find((candidate) => candidate.paneId === session.pane);
      if (found === undefined) continue;

      // Re-read: provisioning and other spawns may have written since.
      const current = store.get(taskId);
      if (current === undefined) return;
      store.put({
        ...current,
        sessions: current.sessions.map((existing) =>
          existing.pane === session.pane ? { ...existing, id: found.id } : existing,
        ),
      });
      changed();
      ctx.log.info(`task ${taskId}: pane ${session.pane ?? '?'} is session ${found.id}`);
      return;
    }
    ctx.log.warn(
      `task ${taskId}: pane ${session.pane ?? '?'} never reported a session — the record keeps its placeholder id`,
    );
  }

  /** Where a task's worktrees live. `ctx.dataDir` is the host's answer to D1b. */
  const rootOf = (task: TaskRecord): string => `${ctx.dataDir}/${task.slug}`;

  /**
   * End the task's pane group — every agent in it, through the one terminator.
   *
   * `layout.closeRoot` drains the root through `store.close`, which is what
   * ADR 0022 makes the only thing that ends a session, so this kills the ptys
   * as well as removing the group.
   *
   * **A task that never spawned has no root, and that is not a failure.** A
   * draft deleted the day it was created never opened one, and warning about it
   * would put a line in the log for the most ordinary thing this verb does. The
   * distinction is drawn from the message text because that is all there is: the
   * error crossed a port as `{code, message}`, and there is no "does this root
   * exist" command to ask instead. Scoped to THIS root's id so an unrelated
   * failure that happens to mention a root is still reported.
   */
  async function closeTaskRoot(task: TaskRecord): Promise<void> {
    const root = taskRootId(task.id);
    const closed = await commands.invoke('layout.closeRoot', { root });
    if (closed.ok) return;
    if (closed.error.code === 'handler-failed' && closed.error.message.includes(`no root ${root}`)) return;
    ctx.log.warn(
      `task ${task.id}: its root was not closed — ${closed.error.code}: ${closed.error.message}`,
    );
  }

  /**
   * Provision a task's repos, then synthesize its root.
   *
   * **Per repo, and in order of landing** — the provisioning state is per repo
   * because the cost is per repo, and a repo that fails does not take the others
   * with it. The task root is synthesized from what actually landed, so a
   * degraded task describes itself honestly rather than advertising a repo that
   * is not there.
   *
   * State lives in memory and is never written to KV: it changes on a second
   * timescale, and routing it through storage would make each transition a
   * `storage.set` across the port and a write to SQLite — v1's save()-on-every-cd
   * reborn. It is also meaningless after a restart, since nothing is mid-provision
   * when the app is not running.
   */
  /**
   * `images` rides through to the orchestrator's launch — the composer's paste
   * belongs to the FIRST prompt, and the orchestrator is what receives it.
   * Nothing is stored: the bytes are written to disk in `startSession` and the
   * record keeps only the task.
   */
  async function provision(task: TaskRecord, images?: readonly PastedImage[]): Promise<void> {
    const root = rootOf(task);
    const landed: { name: string; path: string; worktree: string }[] = [];
    for (const repo of task.repos) {
      provisioning.set(`${task.id}:${repo.name}`, 'working');
      const outcome = await provisionRepo(api.proposed.process, repo, task.slug, `${root}/${repo.name}`);
      if (outcome.ok) {
        provisioning.set(`${task.id}:${repo.name}`, 'ready');
        changed();
        landed.push({ name: repo.name, path: repo.path, worktree: outcome.worktree });
      } else {
        provisioning.set(`${task.id}:${repo.name}`, 'failed');
        changed();
        ctx.log.warn(`task ${task.id}: ${repo.name} did not provision — ${outcome.reason}`);
      }
    }

    const plan = synthTaskRoot({
      title: task.title,
      brief: task.brief,
      repos: landed.map((repo) => ({
        name: repo.name,
        path: repo.worktree,
        ...readContribution(repo.worktree),
      })),
    });
    const out = materializeTaskRoot(root, plan);
    for (const conflict of plan.conflicts) {
      // Measured to resolve in the filesystem otherwise, last-link-wins and
      // silent, so an agent runs the wrong repo's skill.
      ctx.log.warn(
        `task ${task.id}: ${conflict.kind} "${conflict.name}" is in ${conflict.repos.join(' and ')} — namespaced by repo`,
      );
    }
    for (const notice of plan.notices) ctx.log.warn(`task ${task.id}: ${notice}`);
    for (const failure of out.failed) ctx.log.warn(`task ${task.id}: ${failure}`);
    ctx.log.info(`task ${task.id}: ${landed.length}/${task.repos.length} repo(s), ${out.linked} link(s) at ${root}`);

    /**
     * Say, once, that Shepherd created these directories — before any agent
     * opens in one.
     *
     * A task root and its worktrees did not exist a second ago, so Claude Code
     * opens on its trust dialog and waits for a keypress, and the orchestrator
     * below would spawn into a prompt nobody is sitting in front of. `trust.ts`
     * has the whole measurement and the reasoning; what belongs here is the
     * ordering (before the spawn, after the directories exist) and the scope:
     * exactly the paths this function just materialized.
     *
     * Logged either way, because a pre-trust is a write into another program's
     * configuration and a silent one is not something a user can audit. A
     * failure is a warn and nothing more — the task is provisioned, the agent
     * still starts, and what the user gets is the dialog they get today.
     */
    const seeded = seedClaudeTrust({
      homeDir: ctx.homeDir,
      dirs: [root, ...landed.map((repo) => repo.worktree)],
      nonce: ctx.clock.now(),
    });
    if (seeded.ok) ctx.log.info(`task ${task.id}: ${seeded.detail}`);
    else ctx.log.warn(`task ${task.id}: agents may open on Claude Code's trust prompt — ${seeded.detail}`);

    /**
     * The orchestrator starts itself (§7b: "composer auto-starts the
     * orchestrator"), and starts **after** provisioning — its whole context is
     * the synthesized root, and an agent that opened before the `CLAUDE.md`
     * existed would read a directory that does not describe its task yet.
     *
     * Guarded on the task having no sessions, which is also what keeps
     * `tasks.restore` — which re-provisions — from opening a second one beside
     * the first. Restoring a task's *agents* is a resume, a separate verb, and
     * spawning a fresh orchestrator in its place would silently drop the
     * transcript the archive was taken to preserve.
     */
    const now = store.get(task.id);
    if (now !== undefined && now.sessions.length === 0) {
      try {
        const session = await startSession(now, {
          prompt: orchestratorPrompt(now),
          role: 'orchestrator',
          ...(images === undefined || images.length === 0 ? {} : { images }),
        });
        const latest = store.get(task.id) ?? now;
        store.put({ ...latest, sessions: [...latest.sessions, session], lifecycle: 'running' });
        changed();
      } catch (error: unknown) {
        // A task with no agent is degraded, not broken — the worktrees and the
        // root are real and `tasks.spawn` still works. Reported for the same
        // reason a failed repo is: silence here reads as "there was no agent to
        // start".
        ctx.log.warn(`task ${task.id}: no orchestrator started — ${String(error)}`);
      }
    }
  }

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.create, {
      schema: s.object({
        title: s.string(),
        brief: s.optional(s.string()),
        repos: s.optional(s.array(repoArg)),
        /**
         * Images pasted into the brief, base64, in the order their `[Image #N]`
         * tokens appear. They cross the port as data because the page is where
         * a clipboard exists and this side is where a filesystem does.
         */
        images: s.optional(s.array(s.object({ mediaType: s.string(), data: s.string() }))),
      }),
      handler: (args) => {
        // The slug is resolved ONCE against what is taken and then stored (D8).
        // Re-deriving it later would let two tasks titled the same resolve to one
        // folder and quietly share a worktree.
        const slug = uniqueSlug(slugify(args.title), store.takenSlugs());
        const task: TaskRecord = {
          schemaVersion: 1,
          id: nextId(),
          slug,
          title: args.title,
          brief: args.brief ?? '',
          lifecycle: 'draft',
          // Expanded HERE rather than in the composer, so the CLI's `--repo`
          // gets it too — the field and the flag are two doors into one verb.
          repos: (args.repos ?? []).map((repo) => ({
            ...repo,
            path: expandHome(repo.path, ctx.homeDir),
          })),
          sessions: [],
          createdAt: ctx.clock.now(),
        };
        store.put(task);
        /**
         * The picker's history, written where the pick actually happens.
         *
         * Here rather than in the composer because this is the one door every
         * pick goes through — the field, a clicked suggestion and the CLI's
         * `--repo` all arrive as this verb — and because a history the UI
         * maintained would be a second writer of a namespace whose whole
         * soundness rests on there being one (`store.ts`).
         */
        store.recordRepoUses(
          task.repos.map((repo) => repo.path),
          ctx.clock.now(),
        );
        changed();
        ctx.log.info(`created task ${task.id} (${slug}) with ${task.repos.length} repo(s)`);

        // OPTIMISTIC (D12): the record exists and is answerable NOW, and the
        // worktrees fill in behind it. Probe 2 sized why — a `worktree add` is
        // 0.16s but one network round-trip is 2.51s, paid ONCE PER REPO, so a
        // three-repo task is ~7.5s of nothing before a file is written. The
        // caller gets the task; provisioning reports itself through the record.
        void provision(task, args.images).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: provisioning threw — ${String(error)}`);
        });
        return task;
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.list, {
      schema: s.nothing(),
      handler: () => {
        const unreadable = store.unreadable();
        // D15: surfaced, never silent. A task that merely fails to appear is one
        // whose worktrees nobody will ever clean up.
        if (unreadable.length > 0) {
          ctx.log.warn(`${unreadable.length} task record(s) could not be read: ${unreadable.join(', ')}`);
        }
        return store.list().map((task) => ({
          ...task,
          // Derived here, never stored (D4) — from the live attention of the
          // panes this task's sessions are running in, read at the moment the
          // question is asked.
          displayState: displayState(task.lifecycle, attentionOf(task)),
          root: rootOf(task),
          repos: task.repos.map((repo) => ({
            ...repo,
            provisioning: provisioning.get(`${task.id}:${repo.name}`) ?? 'ready',
          })),
        }));
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.spawn, {
      schema: s.object({
        task: s.optional(s.string()),
        repo: s.optional(s.string()),
        prompt: s.optional(s.string()),
      }),
      /**
       * Callable by an agent, **scoped to its own task** (core-design §4.3).
       *
       * The kernel authenticates the caller KIND — every live session is a
       * principal (D9b) — and the scoping happens here, because the kernel cannot
       * know which session belongs to which task and teaching it would be the
       * privileged path this extension exists to avoid.
       *
       * An agent omitting `task` means "mine". An agent NAMING another task is
       * refused: that is the whole point of the scope.
       */
      handler: async (args, caller) => {
        const owning = caller.kind === 'agent' ? taskOfSession(store, caller.sessionId) : undefined;
        if (caller.kind === 'agent' && owning === undefined) {
          throw new Error('this session does not belong to a task, so it cannot spawn into one');
        }
        const id = args.task ?? owning?.id;
        if (id === undefined) throw new Error('no task named, and the caller is not in one');
        if (owning !== undefined && id !== owning.id) {
          throw new Error(`a session in task ${owning.id} may not spawn into task ${id}`);
        }
        const task = store.get(id);
        if (task === undefined) throw new Error(`no task ${id}`);

        // A named repo must be one of the task's, or the cwd would be a
        // directory that does not exist and the agent would start in a shell
        // reporting a path nobody asked for.
        if (args.repo !== undefined && !task.repos.some((repo) => repo.name === args.repo)) {
          throw new Error(`task ${task.id} has no repo "${args.repo}"`);
        }

        const session = await startSession(task, {
          ...(args.repo === undefined ? {} : { repo: args.repo }),
          prompt: args.prompt ?? '',
          role: 'workstream',
        });
        // Re-read: `startSession` awaits, and provisioning may have written.
        const current = store.get(id) ?? task;
        store.put({ ...current, sessions: [...current.sessions, session], lifecycle: 'running' });
        changed();
        return session;
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.reveal, {
      title: 'Tasks: Reveal',
      schema: s.object({ task: s.string() }),
      /**
       * Show me this task — the whole of what clicking a row means.
       *
       * `layout.openRoot` first, unconditionally, and then the switch. The root
       * may be missing for two ordinary reasons — the task never spawned, or it
       * was archived and its root closed — and `openRoot` is idempotent, so
       * asking for it costs nothing when it is already there and is the answer
       * when it is not. The alternative (switch, read the failure, decide what
       * it meant) makes an error string load-bearing for a path that runs every
       * time you click a task.
       *
       * With **no `initialCommand`**: a plain shell at the task's own directory
       * is the honest "here is your task" for one with no live agents. Starting
       * an agent because you clicked a row would spend a session on a glance.
       */
      handler: async (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        const root = taskRootId(task.id);

        /**
         * An archived task is brought BACK by looking at it.
         *
         * Its worktrees were removed and its uncommitted work snapshotted, so
         * opening a root at its directory would show an empty shell in a folder
         * with nothing in it — the app pretending the task is there. Restoring
         * first is what makes closing a task safe to do casually: the gesture
         * that ends it is the same one that undoes it.
         *
         * Awaited, because the pane opens at the task root and a pane that
         * mounted before the worktrees landed would be a shell in a directory
         * being rebuilt underneath it. `tasks.restore` provisions optimistically
         * (the record flips first, the git work follows), so this returns before
         * every repo is back — the tree reports the rest, which is the same
         * bargain creating a task already makes.
         */
        if (task.lifecycle === 'archived') {
          const restored = await commands.invoke(TASK_COMMANDS.restore, { task: task.id });
          if (!restored.ok) {
            throw new Error(`could not restore the task: ${restored.error.code}: ${restored.error.message}`);
          }
          ctx.log.info(`task ${task.id}: restored by being revealed`);
        }

        const opened = await commands.invoke<{ created: boolean; pane: string | null }>('layout.openRoot', {
          root,
          cwd: rootOf(task),
          title: task.title,
        });
        if (!opened.ok) {
          throw new Error(`could not open the task's root: ${opened.error.code}: ${opened.error.message}`);
        }

        const switched = await commands.invoke('layout.switchRoot', { root });
        if (!switched.ok) {
          throw new Error(`could not switch to the task: ${switched.error.code}: ${switched.error.message}`);
        }
        /**
         * …and what to SHOW, in terms no client is privileged about.
         *
         * Everything above this line is a desktop gesture — open a root, switch
         * to it — and on a phone it means nothing. A phone that recovered the
         * intent by matching this command's id would have hardcoded `tasks`,
         * which is the special case ADR 0031 exists to prevent, smuggled in
         * through the client instead of the shell.
         *
         * So the verb also NAMES what it wanted presented, and each renderer
         * decides what that means on its own surface. The desktop already opened
         * the pane and can ignore it; a phone pushes a terminal and attaches.
         *
         * The FIRST live session of the task, because that is what "show me this
         * task" means to something with one screen. Absent when the task has no
         * live agent — a phone then has nothing to attach to, which is the
         * truth rather than an empty terminal pretending otherwise.
         */
        /**
         * The first session of this task that is STILL RUNNING.
         *
         * Checked against the kernel rather than believed off the record, which
         * is ADR 0035's rule arriving at a second door: a stored session id is a
         * CLAIM. A task's record outlives the ptys it names — the daemon can
         * restart, a session can exit — and presenting a dead one told a phone
         * to open a terminal that could never paint, with nothing reporting a
         * fault because nothing had failed.
         */
        const alive = await commands.invoke<Array<{ id: string; paneId?: string }>>('sessions.list', {});
        const sessions = alive.ok && Array.isArray(alive.value) ? alive.value : [];
        const running = new Set(sessions.map((session) => session.id));

        /**
         * What to show, in order of how well it answers "this task".
         *
         * 1. A session the RECORD names and that is still running — a spawned
         *    agent, which is the task actually working.
         * 2. Failing that, whatever is on the pane this reveal just opened.
         *    A task with no agent is a shell at its own directory, and that IS
         *    the honest answer to "show me this task" on a device with one
         *    screen — it is what the Mac shows too.
         *
         * Both are checked against the kernel rather than believed off the
         * record, which is ADR 0035's rule at a second door: a stored session id
         * is a CLAIM. A task's record outlives the ptys it names, and presenting
         * a dead one told a phone to open a terminal that could never paint.
         */
        const recorded = task.sessions.find((session) => running.has(session.id));
        const onThisRoot = sessions.find((session) => session.paneId === opened.value.pane);
        const live = recorded ?? onThisRoot;
        if (live === undefined) {
          ctx.log.info(`task ${task.id}: nothing running to present yet`);
        }
        return {
          id: task.id,
          root,
          opened: opened.value.created,
          ...(live === undefined
            ? {}
            : { present: { kind: 'session', sessionId: sessionId(live.id) } satisfies PresentEffect }),
        };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.archive, {
      schema: s.object({ task: s.string() }),
      handler: async (args) => {
        const found = store.get(args.task);
        if (found === undefined) throw new Error(`no task ${args.task}`);
        let task: TaskRecord = found;
        return whileBusy(task.id, 'archiving', async () => {
        const root = rootOf(task);

        /**
         * Capture what would reattach to each agent, BEFORE its pty is gone.
         *
         * Without this, restoring a task started a fresh agent on the original
         * brief — the same words, none of the transcript — because the record
         * held nothing that could reattach and `provision` treats a task with no
         * sessions as one that has never run. The value is the kind's and stays
         * opaque here (D11): asked for through `agents.resumeTarget`, stored,
         * and handed back unread.
         *
         * The PANE is dropped in the same write. It closed with the root, and a
         * record naming a pane that does not exist is what made the archive
         * trigger unreliable in the first place.
         */
        const sessions = await Promise.all(
          task.sessions.map(async (session) => {
            // `ok` says the call succeeded, not that the value has a shape —
            // it crossed a port and came from an extension this one has never
            // seen. Read defensively or an agent extension that answers
            // `undefined` takes the whole archive down with a TypeError.
            const answer = await commands.invoke<unknown>(AGENTS_RESUME_TARGET, { sessionId: session.id });
            const value = answer.ok && typeof answer.value === 'object' && answer.value !== null
              ? (answer.value as { resumeTarget?: unknown }).resumeTarget
              : undefined;
            const target = typeof value === 'string' && value !== '' ? value : null;
            if (target === null) {
              // Not a failure: a session that never adopted an agent, or one
              // whose agent cannot reattach. It stays in the record so the task
              // still knows it ran, and restore leaves it alone.
              ctx.log.info(`task ${task.id}: session ${session.id} has nothing to resume`);
            }
            const { pane: _closed, ...rest } = session;
            return { ...rest, ...(target === null ? {} : { resumeTarget: target }) };
          }),
        );
        task = { ...task, sessions };
        store.put(task);
        const warnings: string[] = [];
        const archives: RepoArchive[] = [];
        for (const repo of task.repos) {
          const out = await archiveWorktree(api.proposed.process, repo.path, `${root}/${repo.name}`);
          if (!out.ok) {
            // A refusal is the whole point — a conflicted worktree cannot be
            // snapshotted, and failing inside git is how v1 found that out.
            throw new Error(`${repo.name}: ${out.reason}`);
          }
          // Recorded, because a snapshot nothing points at is one restore cannot
          // find — and an unreferenced pinned commit is worse than no archive:
          // it looks like the work is safe.
          archives.push({ repo: repo.name, ...out.record });
          // Gitignored files go either way; the user hears about it first.
          for (const warning of out.warnings) warnings.push(`${repo.name}: ${warning}`);
        }
        // AFTER the snapshots, and that order is the whole of it: a conflicted
        // worktree refuses above, and a refusal that had already closed the
        // task's panes would leave the user with the work still on disk and no
        // agent left to finish resolving it. Shelving is only allowed to touch
        // the screen once what is on disk is safe.
        await closeTaskRoot(task);

        /**
         * The task root goes too — the whole directory, not just the worktrees.
         *
         * `archiveWorktree` removes each repo's checkout and leaves everything
         * the extension GENERATED: the synthesized `CLAUDE.md`, the aggregated
         * `.claude/` links, the now-empty repo folders. So an archived task left
         * a directory you could still `cd` into that described work no longer
         * there, and `~/.shepherd/v2-dev/tasks` grew a folder per task forever.
         *
         * Safe because the root is DERIVED and nothing else: every file in it is
         * either generated from the record (root-synth) or a worktree already
         * snapshotted into `refs/shepherd/*`. Restoring re-provisions and
         * re-materializes it, which is the same path that built it the first
         * time — one code path for "make this task real", not two.
         */
        rmSync(root, { recursive: true, force: true });

        store.put({ ...task, lifecycle: 'archived', archives, archivedAt: ctx.clock.now() });
        changed();
        for (const warning of warnings) ctx.log.warn(`task ${task.id}: ${warning}`);
        return { id: task.id, lifecycle: 'archived', warnings };
        });
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.restore, {
      schema: s.object({ task: s.string() }),
      handler: (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        store.put({ ...task, lifecycle: 'running' });
        changed();
        // Re-provisioning is the restore: `worktree add` recreates each repo at
        // the same path on the same branch, and the root is re-materialized from
        // what lands. Optimistic, for the same reason creating one is.
        void whileBusy(task.id, 'restoring', async () => {
          await provision(store.get(task.id) as TaskRecord);
          // Re-provisioning gives back the branch and a CLEAN tree, which is not
          // what was archived. Replaying the snapshot is a separate step, and
          // omitting it is what made an earlier build "restore" a task to an
          // empty working tree while reporting success.
          for (const archive of task.archives ?? []) {
            const out = await restoreWorktree(api.proposed.process, `${rootOf(task)}/${archive.repo}`, archive);
            if (!out.ok) ctx.log.warn(`task ${task.id}: ${archive.repo} work not replayed — ${out.reason}`);
          }
          // The archives are consumed: they describe a snapshot that has now been
          // put back, and keeping them would let a second restore overwrite newer
          // work with the old snapshot.
          const now = store.get(task.id);
          if (now !== undefined) store.put({ ...now, archives: [] });

          /**
           * And put the AGENTS back — reattached, not restarted.
           *
           * This is what the archive's captured targets were for. Restoring used
           * to leave a task with its worktrees and no agent, and clicking it
           * then started a fresh one on the original brief: the same words with
           * none of the transcript, which reads as the agent having forgotten
           * everything it did. `claude --resume` picks the session up where it
           * stopped.
           *
           * A session with no target is skipped rather than started fresh, for
           * the same reason: an agent that cannot be reattached to is one there
           * is nothing to restore, and re-prompting it is the behaviour being
           * fixed. `tasks.spawn` is right there when you do want a new one.
           */
          const restored = store.get(task.id);
          for (const session of restored?.sessions ?? []) {
            if (session.resumeTarget === undefined) continue;
            try {
              await resumeSession(store.get(task.id) as TaskRecord, session);
            } catch (error: unknown) {
              ctx.log.warn(`task ${task.id}: session ${session.id} not resumed — ${String(error)}`);
            }
          }
        }).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: restore threw — ${String(error)}`);
        });
        return { id: task.id, lifecycle: 'running' };
      },
    }),
  );

  /**
   * The task tree — P6b, and the test of P6's mechanism.
   *
   * It is a CONSUMER, not machinery: everything below is `TreeItem`s and one
   * `onDidChange`, the same surface the diagnostics demo used, and nothing in
   * the core knows what a task is. If this had needed a special case there, the
   * view model would have been wrong (sketch §2b).
   *
   * A FLAT list, newest first. It was grouped by state, and the grouping was
   * an invention: tasks are independent pieces of work, so bucketing them
   * asserts a relationship they do not have — and with two tasks it spent a
   * heading on a distinction between one row and one other row. The state is
   * still read per task (`displayState` derives `needs-you` from the sessions'
   * attention, D4, and nothing writes it); it reaches the row as its tint.
   */
  const treeListeners = new Set<() => void>();
  const changed = (): void => {
    for (const fn of treeListeners) fn();
  };
  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.delete, {
      title: 'Tasks: Delete',
      schema: s.object({ task: s.string() }),
      /**
       * Gone for good: the worktrees, the generated root, the record.
       *
       * The order matters and is the opposite of provisioning's. Worktrees go
       * first, through git — `rm -rf` on one leaves a registration behind in the
       * source repo, and the next `worktree add` on that branch then fails with
       * "already checked out" pointing at a directory that no longer exists.
       * The record goes LAST, because it is the only thing that knows where any
       * of the rest lives: dropping it first turns a failure halfway through
       * into orphaned directories nothing can find.
       *
       * A repo whose worktree will not come off does NOT abort the delete — it
       * is reported and the rest proceeds, because a task that half-exists is
       * worse than one whose leftovers are named.
       *
       * **Branches are left**, and named in the answer. They live in the source
       * repo and may carry commits; deleting them is a larger destruction than
       * this verb was asked for.
       */
      handler: async (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        const root = rootOf(task);
        const kept: string[] = [];
        const failed: string[] = [];

        // The ROOT first: a task owns one, and closing it ends every session in
        // it through the same terminator the loop below uses. The loop stays,
        // and is not redundant — it covers sessions whose panes were never in
        // this root (a record from before a task owned one, or a pane moved
        // elsewhere) — and it is idempotent, because closing a pane that is
        // already gone answers with a failure nobody reads.
        await closeTaskRoot(task);

        /**
         * The sessions first: a deleted task's panes would keep running in a
         * directory about to vanish, and ADR 0022 makes `layout.close` the only
         * thing that ends a session.
         *
         * Closed by SESSION as well as by pane, because a recorded pane id goes
         * stale: pane ids are regenerated when a layout is restored, so after a
         * relaunch the record names a pane that no longer exists, `layout.close`
         * closes nothing, and the agent outlives the task that owned it — which
         * is what left a live shell sitting in a deleted directory. Measured,
         * not theorised.
         *
         * `sessions.list` is the authority on which pane a session is on NOW.
         * A pane that is already gone answers with a failure, which is fine:
         * closed is closed.
         */
        // A command's answer is `unknown` and crossed a port; `ok` says the call
        // succeeded, not that the value has the shape this file expects. The
        // cost of assuming is that a task cannot be deleted at all.
        const listed = await commands.invoke<unknown>('sessions.list');
        const paneOf = new Map<string, string>();
        if (listed.ok && Array.isArray(listed.value)) {
          for (const entry of listed.value as { id?: unknown; paneId?: unknown }[]) {
            if (typeof entry?.id === 'string' && typeof entry.paneId === 'string') {
              paneOf.set(entry.id, entry.paneId);
            }
          }
        }
        const panes = new Set<string>();
        for (const session of task.sessions) {
          const live = paneOf.get(session.id);
          if (live !== undefined) panes.add(live);
          if (session.pane !== undefined) panes.add(session.pane);
        }
        for (const pane of panes) await commands.invoke('layout.close', { pane });

        // An ARCHIVED task's worktrees were already removed by the archive
        // (finding #2) — running `worktree remove` again fails per repo and made
        // a clean delete report itself as broken. The pinned archive refs are
        // deliberately left: refs/shepherd/* is tiny, local-only, and deleting
        // snapshots is a bigger destruction than "remove this task's entry".
        const stranded: string[] = [];
        if (task.lifecycle !== 'archived') {
          for (const repo of task.repos) {
            const out = await removeWorktree(api.proposed.process, repo.path, `${root}/${repo.name}`);
            if (out.ok) {
              if (out.branch !== null) kept.push(`${repo.name}: ${out.branch}`);
            } else {
              failed.push(`${repo.name}: ${out.reason}`);
              stranded.push(repo.path);
            }
          }
        }

        rmSync(root, { recursive: true, force: true });

        // The rmSync just took directories out from under any registration git
        // still holds (finding #1) — exactly the state this handler's comment
        // warns about, where the next `worktree add` on that branch fails
        // pointing at a directory that no longer exists. `worktree prune` is
        // git's own repair for a registration whose directory is gone, and it
        // only works AFTER the directory is gone — pruning before the rmSync is
        // a no-op, because the directory still answers. Best-effort: a source
        // repo that is itself gone has no registration to strand.
        for (const repoPath of stranded) {
          await api.proposed.process
            .gitWrite(['worktree', 'prune'], { cwd: repoPath, timeoutMs: 30_000 })
            .catch(() => undefined);
        }

        store.remove(task.id);
        changed();

        for (const failure of failed) ctx.log.warn(`task ${task.id}: ${failure}`);
        ctx.log.info(
          `deleted task ${task.id} (${task.slug})` +
            `${kept.length === 0 ? '' : `; branches left: ${kept.join(', ')}`}`,
        );
        return { id: task.id, slug: task.slug, branchesLeft: kept, failed };
      },
    }),
  );

  /**
   * The composer — M3b's point, and a view like any other (ADR 0033).
   *
   * What crosses from here is the NAME of a UI module. The component itself is
   * in `ui/`, which this file must never import: react in the utility process
   * is react in a process with no DOM, and the reason the two halves are
   * separate directories with a lint rule between them.
   */
  ctx.subscriptions.push(
    views.registerViewType(TASK_VIEWS.composer, {
      kind: 'component',
      component: TASK_VIEWS.composer,
      // A form you open, fill in and dismiss — v1's ⌘T composer, declared rather
      // than hardcoded into the shell. In the dock it would sit there taking a
      // third of the sidebar forever.
      surface: 'overlay',
      key: 'CmdOrCtrl+T',
      title: 'New task',
    }),
  );

  ctx.subscriptions.push(
    views.registerViewType(TASK_VIEWS.tree, {
      kind: 'tree',
      title: 'Tasks',
      data: {
        children: (parent) => {
          if (parent !== undefined) {
            const task = store.get(parent);
            return Promise.resolve(
              (task?.repos ?? []).map((repo) => ({
                id: `${parent}:${repo.name}`,
                label: repo.name,
                description: provisioning.get(`${parent}:${repo.name}`) ?? 'ready',
              })),
            );
          }

          const all = [...store.list()].sort((a, b) => b.createdAt - a.createdAt);
          if (all.length === 0) {
            // The empty state is the SHELL's, not a fake row: a list saying
            // "no tasks yet" in the shape of a task is a row you can click.
            return Promise.resolve([]);
          }

          /**
           * Live work, then DONE — the one division the list makes.
           *
           * It is not the state-grouping that was removed: that sorted live
           * tasks into buckets they have no relationship through. This is the
           * difference between work in flight and work you have finished with,
           * which is the one thing you asked the sidebar for by closing a task.
           * Archived tasks go under a heading at the bottom and nowhere else,
           * so finished work stops competing with the rest for the eye.
           */
          const live = all.filter((task) => task.lifecycle !== 'archived');
          const done = all.filter((task) => task.lifecycle === 'archived');

          const rows: TreeItemOut[] = [];
          const rowFor = (task: TaskRecord): TreeItemOut => {
            const state = displayState(task.lifecycle, attentionOf(task));
            return {
              id: task.id,
              label: task.title,
              description: state,
              tint: state,
              collapsed: true,
              // Something is happening to it right now — a snapshot being taken,
              // worktrees being rebuilt. The row says so where its status mark
              // is, rather than looking idle for the seconds git takes.
              ...(busy.has(task.id) ? { busy: true, description: `${busy.get(task.id) ?? ''}…` } : {}),
              // Clicking a task takes you to it — and for an archived one that
              // means bringing it BACK: `tasks.reveal` restores the worktrees
              // first (see its handler). One gesture, whatever state the task
              // is in, because "show me this task" is one intention.
              command: { id: TASK_COMMANDS.reveal, args: { task: task.id } },
              /*
               * The row's right-click menu. Declared HERE because the shell
               * cannot know a task's verbs — a sidebar that hardcoded Reveal /
               * Archive / Delete would be a sidebar that knows what a task is,
               * which is the special case ADR 0031 exists to prevent.
               *
               * Each entry is a command id plus the args naming WHICH task, the
               * same shape `command` above uses, and each runs attributed to this
               * extension rather than to the user (D14) — so `tasks.delete` from
               * a menu is authorized exactly as `tasks.delete` from the CLI is.
               *
               * An archived task offers Restore where a live one offers Archive:
               * the verb that is available is the one that changes its state,
               * and offering "Archive" on something already archived is an item
               * that either fails or does nothing.
               */
              actions: [
                {
                  id: TASK_COMMANDS.reveal,
                  label: task.lifecycle === 'archived' ? 'Restore' : 'Reveal',
                  icon: 'eye',
                  args: { task: task.id },
                },
                { separator: true },
                ...(task.lifecycle === 'archived'
                  ? []
                  : [
                      {
                        id: TASK_COMMANDS.archive,
                        label: 'Archive',
                        icon: 'archive',
                        danger: true,
                        args: { task: task.id },
                      },
                    ]),
                {
                  id: TASK_COMMANDS.delete,
                  label: 'Delete',
                  icon: 'trash',
                  danger: true,
                  args: { task: task.id },
                },
              ],
            };
          };

          for (const task of live) rows.push(rowFor(task));

          if (done.length > 0) {
            rows.push({
              id: 'group:done',
              label: 'DONE',
              description: String(done.length),
              section: true,
              tint: 'wool-faint',
            });
            for (const task of done) rows.push(rowFor(task));
          }

          return Promise.resolve(rows);
        },
        onDidChange: (fn) => {
          treeListeners.add(fn);
          return toDisposable(() => treeListeners.delete(fn));
        },
      },
    }),
  );

  /**
   * Last, not first: the sweep nudges the tree, and `changed` is defined with
   * the view it notifies. Calling it up where the function is declared threw
   * `Cannot access 'changed' before initialization` — caught by its own test,
   * which is the argument for having written the test.
   */
  sweep();

  ctx.log.info(`ready — ${store.list().length} task(s), data in ${ctx.dataDir}`);
  return { list: () => store.list(), get: (id) => store.get(id) };
}

/** Which task owns a session, or none. The scoping predicate, in one place. */
function taskOfSession(store: TaskStore, sessionId: string): TaskRecord | undefined {
  return store.list().find((task) => task.sessions.some((session) => session.id === sessionId));
}
