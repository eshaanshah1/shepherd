import type { Clock } from '@shepherd/sdk';
import type { ChangedFile, PullRequest } from './model/pr.ts';
import type { RepoSlug } from './model/remote.ts';
import { needsHead, ownedByTask } from './model/ownership.ts';
import { isAuthFailure, message, type GitHubClient } from './client.ts';

/**
 * Keeping what GitHub says in memory, and deciding when to ask again.
 *
 * The whole loop, and it is deliberately not clever: ask about every task's
 * branch on a timer, keep the answer, tell whoever is drawing. What makes that
 * affordable rather than rude is that a task is ONE GraphQL query per repo, and
 * that a task nobody is looking at is asked about far less often than one whose
 * review tab is open.
 *
 * **Nothing here is persisted.** A PR's state is a fact about a moment, and one
 * restored from disk would be a confident claim about a build that finished
 * hours ago — the same argument `tasks` makes for its diff cache. A relaunch
 * shows no PRs for a second and then the truth.
 */

/** A task as this extension needs it — the branch and where the checkouts are. */
export interface TaskSubject {
  readonly id: string;
  /** The task's slug, which is also the branch every worktree is on. */
  readonly branch: string;
  readonly repos: readonly { readonly path: string; readonly name: string }[];
  /** Finished work. Asked about once, then left alone — see `dueAt`. */
  readonly shipped: boolean;
}

export interface TaskPrs {
  readonly prs: readonly PullRequest[];
  /** When this answer was obtained. Epoch ms — the pane head prints its age. */
  readonly syncedAt: number;
  /**
   * Why the last attempt failed, if it did. The PRs stay: a stale list with a
   * complaint beside it is more use than an empty one, and a network blip
   * emptying the review tab is exactly the flicker this avoids.
   */
  readonly error?: string;
}

export interface SyncDeps {
  readonly clock: Clock;
  /** `null` while there is no token — every sync is then a no-op that says so. */
  client: () => GitHubClient | null;
  remoteOf: (repoPath: string) => Promise<RepoSlug | null>;
  /**
   * The commit that checkout is on, or `null` when it cannot be read.
   *
   * Asked only when a repo answered with a finished PR (`needsHead`), so the
   * ordinary task pays nothing for it. See `model/ownership.ts` for what it is
   * for and why `null` keeps rather than drops.
   */
  headOf: (repoPath: string) => Promise<string | null>;
  /** Something changed: redraw. Called at most once per task per sync. */
  onChanged: () => void;
  /** A credential that no longer works. The owner stops and re-resolves. */
  onAuthFailure: () => void;
  log: (message: string) => void;
}

/**
 * How stale an answer may be before it is asked for again, by how much the user
 * is looking at it.
 *
 * These are the numbers the feature lives or dies by, so they are named and
 * argued rather than sprinkled:
 *
 *   - **open** — the review tab is on screen. A CI run finishing while you watch
 *     should land within a breath, and 20s is the shortest interval that is not
 *     really polling.
 *   - **live** — an unshipped task nobody is looking at. Its glyph is in the
 *     rail, so it has to be roughly true; two minutes is roughly.
 *   - **shipped** — finished work. Its PRs are merged and the number on the row
 *     is the record; an hour is generous.
 *
 * A task with no PRs at all is on the same clock as one with them. It has to be:
 * "a PR has just been opened" is precisely the transition nobody would otherwise
 * see, and it is the one that puts the glyph on the row for the first time.
 */
export const SYNC_INTERVALS = { open: 20_000, live: 120_000, shipped: 3_600_000 } as const;

export class Sync {
  readonly #deps: SyncDeps;
  readonly #byTask = new Map<string, TaskPrs>();
  /** Tasks whose review tab is on screen, so they are asked about often. */
  readonly #watching = new Set<string>();
  /** In-flight syncs, so a timer tick cannot overlap the one before it. */
  readonly #running = new Set<string>();
  /**
   * Tasks holding a seeded answer, which a real sync must not overwrite.
   *
   * Found the hard way: `gh` is logged in on the machine this was first looked
   * at, so the very next pass asked GitHub about a branch with no repos, got
   * nothing, and replaced the fixture with an empty list about twenty seconds
   * after it was put there. A fixture that survives one screenshot is not a
   * fixture.
   */
  readonly #seeded = new Set<string>();

  constructor(deps: SyncDeps) {
    this.#deps = deps;
  }

  get(taskId: string): TaskPrs | undefined {
    return this.#byTask.get(taskId);
  }

  /** Every PR this extension knows about, for a rollup across tasks. */
  prsOf(taskId: string): readonly PullRequest[] {
    return this.#byTask.get(taskId)?.prs ?? [];
  }

  /**
   * Somebody has this task's review tab open (or has closed it).
   *
   * The one input that changes the cadence, and it is a `watch`/`unwatch` pair
   * rather than a "sync now" because what it expresses is a standing interest —
   * a pane that asked once would go stale the moment CI moved.
   */
  watch(taskId: string): void {
    this.#watching.add(taskId);
  }

  unwatch(taskId: string): void {
    this.#watching.delete(taskId);
  }

  /**
   * Put an answer in without asking GitHub — a DEV BUILD ONLY door.
   *
   * It exists because this whole surface is unreachable without a real
   * repository, a real remote and a real pull request, and "open the app and
   * look at it" is the check that catches what a unit test cannot: a row that
   * wraps, a colour that vanishes in light mode, a menu that opens off-screen.
   *
   * Guarded at the COMMAND (`ctx.isDev`), not here, for the reason the rest of
   * this class has no guards: the store's job is to hold answers, and a store
   * that knew which of its callers were legitimate would be the second place
   * that decision lives.
   */
  seed(taskId: string, prs: readonly PullRequest[]): void {
    this.#byTask.set(taskId, { prs, syncedAt: this.#deps.clock.now() });
    this.#seeded.add(taskId);
    this.#deps.onChanged();
  }

  /**
   * Put fetched patches onto one PR of a task.
   *
   * They live on the PR rather than in a store of their own, so everything that
   * already reads a PR gets them for free and nothing has to join two caches.
   * Keyed by `prKey` because a task's PRs are a list, not a map.
   *
   * It does NOT touch `syncedAt`: patches are a different fact on a different
   * clock, and moving the sync time would make the pane's `synced 3s ago` a
   * claim about a request that asked GitHub nothing about the PR's state.
   */
  withFiles(taskId: string, key: string, files: readonly ChangedFile[]): void {
    const held = this.#byTask.get(taskId);
    if (held === undefined) return;
    this.#byTask.set(taskId, {
      ...held,
      prs: held.prs.map((pr) => (`${pr.repo}#${pr.number}` === key ? { ...pr, files } : pr)),
    });
    this.#deps.onChanged();
  }

  /** Stop holding a seeded answer, so the next pass asks GitHub again. */
  unseed(taskId: string): void {
    this.#seeded.delete(taskId);
  }

  /** Drop a task's answer — it has been deleted, or its repos changed. */
  forget(taskId: string): void {
    this.#byTask.delete(taskId);
    this.#watching.delete(taskId);
    this.#seeded.delete(taskId);
  }

  /**
   * One pass over every task, syncing the ones that are due.
   *
   * `force` is `github.sync`: the user asked, so every task is due. Everything
   * else — the timer, a task appearing, a review tab opening — goes through the
   * ordinary staleness rule, because a caller that could bypass it is a caller
   * that will.
   */
  async pass(tasks: readonly TaskSubject[], force = false): Promise<void> {
    const live = new Set(tasks.map((task) => task.id));
    for (const known of [...this.#byTask.keys()]) if (!live.has(known)) this.forget(known);

    await Promise.all(tasks.filter((task) => force || this.#due(task)).map((task) => this.#sync(task)));
  }

  #due(task: TaskSubject): boolean {
    const held = this.#byTask.get(task.id);
    if (held === undefined) return true;
    return this.#deps.clock.now() - held.syncedAt >= this.intervalFor(task);
  }

  /** Exposed for the test that pins the three cadences against their reasons. */
  intervalFor(task: TaskSubject): number {
    if (this.#watching.has(task.id)) return SYNC_INTERVALS.open;
    return task.shipped ? SYNC_INTERVALS.shipped : SYNC_INTERVALS.live;
  }

  async #sync(task: TaskSubject): Promise<void> {
    if (this.#running.has(task.id)) return;
    // A seeded task is held until somebody unseeds it — see `#seeded`.
    if (this.#seeded.has(task.id)) return;
    const client = this.#deps.client();
    if (client === null) return;

    this.#running.add(task.id);
    try {
      const found: PullRequest[] = [];
      const failures: string[] = [];

      for (const repo of task.repos) {
        const slug = await this.#deps.remoteOf(repo.path);
        // Not a failure and not worth a word on screen: a repo with no GitHub
        // remote is an ordinary member of a task, and every multi-repo user has
        // one.
        if (slug === null) continue;
        try {
          const answered = await client.pullRequests(slug, task.branch, repo.name);
          /*
           * A branch name is not unique over time, so what GitHub answered may
           * include a PR that merged on a branch of this name before this task
           * existed. `ownedByTask` separates them by commit; the HEAD it needs
           * is read only when there is a finished PR to judge.
           */
          const headOid = needsHead(answered) ? await this.#deps.headOf(repo.path) : null;
          const { kept, dropped } = ownedByTask(answered, headOid);
          found.push(...kept);
          // Said out loud rather than filtered away: a PR that vanishes with no
          // explanation is indistinguishable from one that was never found.
          if (dropped.length > 0) {
            const numbers = dropped.map((pr) => `#${pr.number}`).join(', ');
            this.#deps.log(
              `${repo.name}: ${numbers} on ${task.branch} is not this task’s work — no commit in common`,
            );
          }
        } catch (error: unknown) {
          if (isAuthFailure(error)) {
            /*
             * Stop rather than retry. A loop that treated an expired token as a
             * blip would ask a server to reject it every twenty seconds for the
             * life of the app, and each rejection is a request the user's rate
             * limit pays for.
             */
            this.#deps.onAuthFailure();
            failures.push('not signed in');
            break;
          }
          failures.push(`${repo.name}: ${message(error)}`);
        }
      }

      const before = this.#byTask.get(task.id);
      this.#byTask.set(task.id, {
        // The PREVIOUS answer survives a total failure. A stale list with a
        // complaint beside it beats an empty one, and beats a review tab that
        // blinks empty every time a laptop's wifi drops.
        prs: failures.length > 0 && found.length === 0 ? (before?.prs ?? []) : found,
        syncedAt: this.#deps.clock.now(),
        ...(failures.length === 0 ? {} : { error: failures.join(' · ') }),
      });
      if (failures.length > 0) this.#deps.log(`sync of ${task.id}: ${failures.join(' · ')}`);
      if (changed(before, this.#byTask.get(task.id))) this.#deps.onChanged();
    } finally {
      this.#running.delete(task.id);
    }
  }
}

/**
 * Is this answer different from the last one, in a way anything DRAWS?
 *
 * The redraw it gates costs a full tree re-read across a port, so a sync that
 * found nothing new must not trigger one — which, on a quiet afternoon, is every
 * sync. `syncedAt` is deliberately not part of the comparison: it changes every
 * time by construction, and including it would make this function always answer
 * yes. The pane head's "synced 12s ago" ticks on its own clock instead.
 */
export function changed(before: TaskPrs | undefined, after: TaskPrs | undefined): boolean {
  if (before === undefined || after === undefined) return before !== after;
  if (before.error !== after.error) return true;
  return fingerprint(before.prs) !== fingerprint(after.prs);
}

/**
 * Everything a row or a pane draws, flattened to a string.
 *
 * A deep compare would be the same idea with more code; what matters is that the
 * fields listed here are exactly the ones the UI reads, so a change nobody can
 * see cannot cause a repaint and a change somebody can see cannot fail to.
 */
function fingerprint(prs: readonly PullRequest[]): string {
  return prs
    .map((pr) =>
      [
        pr.repo,
        pr.number,
        pr.title,
        pr.state,
        pr.baseRef,
        pr.mergeState,
        pr.added,
        pr.removed,
        pr.changedFiles,
        pr.approvals.join(','),
        pr.changesRequested.join(','),
        pr.checks.map((check) => `${check.name}:${check.state}`).join(','),
        pr.threads.map((thread) => `${thread.id}:${thread.resolved ? 'r' : 'o'}`).join(','),
      ].join('|'),
    )
    .join('\n');
}
