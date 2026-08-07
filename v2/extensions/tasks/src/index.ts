import { s, type ExtensionContext, type Shepherd } from '@shepherd/sdk';
import { REPO_SUGGESTIONS_POINT, TASK_COMMANDS } from './manifest.ts';
import { TaskStore, type RepoRef, type TaskRecord, type TaskSession } from './store.ts';
import { slugify, uniqueSlug } from './model/slug.ts';
import { displayState } from './model/lifecycle.ts';
import { synthTaskRoot } from './model/root-synth.ts';
import { materializeTaskRoot, provisionRepo, readContribution } from './provision.ts';

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

export function activate(ctx: ExtensionContext, api: Shepherd): TasksAPI {
  const { commands, points } = api.proposed;
  const store = new TaskStore(ctx.storage);
  /** Per-repo provisioning state. In memory, deliberately — see `provision`. */
  const provisioning = new Map<string, 'working' | 'ready' | 'failed'>();

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

  const nextId = (): string => `task-${ctx.clock.now()}-${store.list().length}`;

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
        landed.push({ name: repo.name, path: repo.path, worktree: outcome.worktree });
      } else {
        provisioning.set(`${task.id}:${repo.name}`, 'failed');
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
          // Derived here, never stored (D4). `attention` is not this extension's
          // to read yet — until the tree consumes it (M3b) every task reports its
          // lifecycle, which is honest rather than a guess.
          displayState: displayState(task.lifecycle, []),
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
      handler: (args, caller) => {
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

        // P3 records the intent; P4 gives it a real session in a real worktree.
        const session: TaskSession = {
          id: `pending-${ctx.clock.now()}`,
          ...(args.repo === undefined ? {} : { repo: args.repo }),
          role: 'workstream',
        };
        store.put({ ...task, sessions: [...task.sessions, session], lifecycle: 'running' });
        ctx.log.info(`task ${id}: spawned ${session.id}${args.repo === undefined ? '' : ` in ${args.repo}`}`);
        return session;
      },
    }),
  );

  for (const [verb, lifecycle] of [
    [TASK_COMMANDS.archive, 'archived'],
    [TASK_COMMANDS.restore, 'running'],
  ] as const) {
    ctx.subscriptions.push(
      commands.register(verb, {
        schema: s.object({ task: s.string() }),
        handler: (args) => {
          const task = store.get(args.task);
          if (task === undefined) throw new Error(`no task ${args.task}`);
          // The worktree half — the two-commit snapshot, the gitignored-file
          // warning, the conflicted refusal — is P4. This is the record.
          store.put({ ...task, lifecycle });
          return { id: task.id, lifecycle };
        },
      }),
    );
  }

  ctx.log.info(`ready — ${store.list().length} task(s), data in ${ctx.dataDir}`);
  return { list: () => store.list(), get: (id) => store.get(id) };
}

/** Which task owns a session, or none. The scoping predicate, in one place. */
function taskOfSession(store: TaskStore, sessionId: string): TaskRecord | undefined {
  return store.list().find((task) => task.sessions.some((session) => session.id === sessionId));
}
