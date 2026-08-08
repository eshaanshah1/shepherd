import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  s,
  toDisposable,
  type AttentionLevel,
  type ExtensionContext,
  type Shepherd,
} from '@shepherd/sdk';
import { REPO_SUGGESTIONS_POINT, TASK_COMMANDS, TASK_VIEWS } from './manifest.ts';
import { TaskStore, type RepoArchive, type RepoRef, type TaskRecord, type TaskSession } from './store.ts';
import { slugify, uniqueSlug } from './model/slug.ts';
import { displayState } from './model/lifecycle.ts';
import { synthTaskRoot } from './model/root-synth.ts';
import { planLaunch } from './model/launch.ts';
import {
  archiveWorktree,
  materializeTaskRoot,
  provisionRepo,
  readContribution,
  removeWorktree,
  restoreWorktree,
} from './provision.ts';

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
/**
 * The sidebar's groups, in the order you care.
 *
 * Attention first, then motion, then rest — the same ranking v1's aggregate dot
 * used (blocked > error > done > working > idle), applied to a list instead of
 * a single glyph. `archived` is deliberately absent: it is not work in flight.
 */
const TASK_GROUPS: readonly { label: string; states: readonly string[]; tint: string }[] = [
  { label: 'NEEDS YOU', states: ['needs-you', 'review'], tint: 'hay' },
  { label: 'WORKING', states: ['running'], tint: 'cobalt' },
  { label: 'DRAFT', states: ['draft'], tint: 'wool-faint' },
  { label: 'DONE', states: ['done'], tint: 'pasture' },
  { label: 'ARCHIVED', states: ['archived'], tint: 'wool-faint' },
];

/** What this extension puts in a tree. Structural, so the SDK type stays the SDK's. */
interface TreeItemOut {
  id: string;
  label: string;
  description?: string;
  section?: boolean;
  tint?: string;
  collapsed?: boolean;
  command?: { id: string };
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
   * Usage-and-recency ranking needs history this extension has not gathered yet
   * (P4 records it), so today it answers with the repos of the most recent tasks —
   * which is the same shape and honestly thin rather than absent.
   */
  ctx.subscriptions.push(
    suggestions.register(
      {
        suggest: () => {
          const seen = new Map<string, RepoRef>();
          for (const task of [...store.list()].sort((a, b) => b.createdAt - a.createdAt)) {
            for (const repo of task.repos) if (!seen.has(repo.path)) seen.set(repo.path, repo);
          }
          return [...seen.values()];
        },
      },
      { priority: 0 },
    ),
  );

  /**
   * The composer's question, answered by the point and nothing else.
   *
   * Every provider is asked and the answers are concatenated in priority order,
   * deduped by path — a second provider must be able to ADD a repo the first
   * did not think of, which is the whole reason this is a point. A provider that
   * throws is dropped with a line in the log rather than taking the picker down:
   * a suggestion is an accelerator, and losing one must not stop a task being
   * created by hand.
   */
  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.suggestRepos, {
      title: 'Tasks: Suggest Repos',
      schema: s.object({ title: s.optional(s.string()), brief: s.optional(s.string()) }),
      handler: (args) => {
        const input = { title: args.title ?? '', brief: args.brief ?? '' };
        const seen = new Map<string, RepoRef>();
        for (const provider of suggestions.all()) {
          try {
            for (const repo of provider.suggest(input)) if (!seen.has(repo.path)) seen.set(repo.path, repo);
          } catch (error: unknown) {
            ctx.log.warn(`a repo-suggestion provider threw and was skipped — ${String(error)}`);
          }
        }
        return [...seen.values()];
      },
    }),
  );

  const nextId = (): string => `task-${ctx.clock.now()}-${store.list().length}`;

  /**
   * Start an agent, in a directory, in a pane — the whole of what "spawn"
   * means today.
   *
   * Three seams, none of them new: `layout.split` opens the pane (with the cwd
   * and the one line to type), the renderer creates the session when it mounts,
   * and the kernel injects the correlation env into it (ADR 0025) so the
   * agent's hooks land like any other pane's.
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
  async function startSession(
    task: TaskRecord,
    input: { readonly repo?: string; readonly prompt: string; readonly role: TaskSession['role'] },
  ): Promise<TaskSession> {
    const cwd = input.repo === undefined ? rootOf(task) : `${rootOf(task)}/${input.repo}`;

    // Under the extension's data dir but OUTSIDE any task root: the root is an
    // agent's cwd, and a prompt file sitting in it is junk in the workspace the
    // agent is about to describe.
    const promptDir = `${ctx.dataDir}/.prompts`;
    mkdirSync(promptDir, { recursive: true });
    const plan = planLaunch({
      promptFile: `${promptDir}/${task.slug}-${ctx.clock.now()}.txt`,
      prompt: input.prompt,
    });
    // Before the split: the renderer types the command as soon as the pane's
    // session exists, and a `cat` that loses the race reads an empty prompt.
    writeFileSync(plan.promptFile, input.prompt, 'utf8');

    const opened = await commands.invoke<string>('layout.split', {
      axis: 'row',
      cwd,
      initialCommand: plan.command,
    });
    if (!opened.ok) {
      rmSync(plan.promptFile, { force: true });
      throw new Error(`could not open a pane for the agent: ${opened.error.code}: ${opened.error.message}`);
    }

    /**
     * Name the pane, because a column of identical shell titles is what a task
     * with three agents looks like otherwise.
     *
     * A separate command from the split on purpose: `layout.split` takes the cwd
     * and the command to type and nothing else, and widening it so this one
     * caller could pass a title would put a `tasks` convenience into the kernel's
     * layout verb. Renaming afterwards costs one more invoke and keeps the seam.
     *
     * A failure is logged and stepped over: the pane is open, the agent is
     * running in it and the session is about to be recorded — a title is the one
     * part of a spawn that is decoration, and throwing here would discard a real
     * pane over it.
     */
    const title =
      input.role === 'orchestrator' ? task.title : `${task.title} · ${input.repo ?? 'workstream'}`;
    const renamed = await commands.invoke('layout.rename', { pane: opened.value, title });
    if (!renamed.ok) {
      ctx.log.warn(
        `task ${task.id}: pane ${opened.value} kept its own title — ${renamed.error.code}: ${renamed.error.message}`,
      );
    }

    const session: TaskSession = {
      id: `pending-${ctx.clock.now()}`,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      role: input.role,
      pane: opened.value,
    };
    ctx.log.info(`task ${task.id}: opened pane ${opened.value} in ${cwd} for a ${input.role}`);
    void correlate(task.id, session).catch((error: unknown) => {
      ctx.log.error(`task ${task.id}: correlating ${session.pane ?? '?'} threw — ${String(error)}`);
    });
    return session;
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
  async function provision(task: TaskRecord): Promise<void> {
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
        const session = await startSession(now, { prompt: orchestratorPrompt(now), role: 'orchestrator' });
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
          repos: args.repos ?? [],
          sessions: [],
          createdAt: ctx.clock.now(),
        };
        store.put(task);
        changed();
        ctx.log.info(`created task ${task.id} (${slug}) with ${task.repos.length} repo(s)`);

        // OPTIMISTIC (D12): the record exists and is answerable NOW, and the
        // worktrees fill in behind it. Probe 2 sized why — a `worktree add` is
        // 0.16s but one network round-trip is 2.51s, paid ONCE PER REPO, so a
        // three-repo task is ~7.5s of nothing before a file is written. The
        // caller gets the task; provisioning reports itself through the record.
        void provision(task).catch((error: unknown) => {
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
    commands.register(TASK_COMMANDS.archive, {
      schema: s.object({ task: s.string() }),
      handler: async (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        const root = rootOf(task);
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
        store.put({ ...task, lifecycle: 'archived', archives });
        changed();
        for (const warning of warnings) ctx.log.warn(`task ${task.id}: ${warning}`);
        return { id: task.id, lifecycle: 'archived', warnings };
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
        void (async () => {
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
        })().catch((error: unknown) => {
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
   * Rows are grouped by state because that is how the sidebar is specified (§4)
   * and because the grouping is a READ — `displayState` derives `needs-you` from
   * the sessions' attention (D4), and nothing writes it.
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

        // The sessions first (its first review's finding #3): a deleted task's
        // panes would keep running in a directory about to vanish, and ADR 0022
        // makes `layout.close` the only thing that ends a session — nothing
        // downstream of the rmSync could clean them up. A pane that is already
        // gone answers with a failure, which is fine: closed is closed.
        for (const session of task.sessions) {
          if (session.pane !== undefined) {
            await commands.invoke('layout.close', { pane: session.pane });
          }
        }

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

          const tasks = [...store.list()].sort((a, b) => b.createdAt - a.createdAt);
          if (tasks.length === 0) {
            // The empty state is the SHELL's, not a fake row: a list saying
            // "no tasks yet" in the shape of a task is a row you can click.
            return Promise.resolve([]);
          }

          /**
           * Grouped by state, which is how the sidebar is specified (§4) — and
           * the grouping is a READ: `displayState` derives `needs-you` from the
           * sessions' attention (D4) and nothing writes it.
           *
           * The order is the order you care in: what wants you, then what is
           * moving, then what is not. A group with nothing in it is absent
           * rather than an empty heading.
           */
          const rows: TreeItemOut[] = [];
          for (const group of TASK_GROUPS) {
            const inGroup = tasks.filter((task) =>
              group.states.includes(displayState(task.lifecycle, attentionOf(task))),
            );
            if (inGroup.length === 0) continue;
            rows.push({
              id: `group:${group.label}`,
              label: group.label,
              description: String(inGroup.length),
              section: true,
              tint: group.tint,
            });
            for (const task of inGroup) {
              const state = displayState(task.lifecycle, attentionOf(task));
              rows.push({
                id: task.id,
                label: task.title,
                description: state,
                tint: state,
                collapsed: true,
                command: { id: TASK_COMMANDS.list },
              });
            }
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

  ctx.log.info(`ready — ${store.list().length} task(s), data in ${ctx.dataDir}`);
  return { list: () => store.list(), get: (id) => store.get(id) };
}

/** Which task owns a session, or none. The scoping predicate, in one place. */
function taskOfSession(store: TaskStore, sessionId: string): TaskRecord | undefined {
  return store.list().find((task) => task.sessions.some((session) => session.id === sessionId));
}
