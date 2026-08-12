import { s, type KV } from '@shepherd/sdk';
import type { ArchivedTab } from './model/archive-tabs.ts';
import { LIFECYCLE_STATES, type TaskLifecycle } from './model/lifecycle.ts';
import { recordUse, type RepoUse } from './model/repo-history.ts';

/**
 * The task store — D2 and D15.
 *
 * **KV, not SQL.** Three settled statements disagreed about this (§7b said
 * better-sqlite3, ADR 0021 said `node:sqlite`, §7c said KV stays until a real
 * consumer proves it thin), and the live question was only ever the API surface
 * `tasks` is handed. It is KV: the query a task list needs is "all of them,
 * ordered", and `keys()` plus a filter *is* that query at the scale a person's
 * task list reaches — with no index for this extension to keep consistent.
 *
 * `SqliteStore.db` exists and is commented "escape hatch for core's own tables
 * (tasks, layout)". It stays shut. Taking it would make `tasks` a core table
 * reached through commands, which is the privileged path the whole ADE bet
 * forbids: `tasks` must consume the same public API a third party gets, or the
 * substrate claim is hollow.
 *
 * **Two constraints on the shape, and the first is not obvious.** `ctx.storage`
 * is a write-through mirror: the host ships the extension's whole namespace
 * across the message port at activation and it stays resident in the child. So a
 * task record must stay small — no transcripts, no diffs, no file contents, ever;
 * those are files or they are nothing. And the mirror is sound only because a
 * namespace has exactly one writer, which this is and must remain.
 *
 * **D15: an unreadable record must not orphan a worktree.** `KV.get` treats a
 * schema mismatch as *absent* and `s.object` rejects unknown keys, so a record
 * written by a newer build would read as "there is no such task" while its
 * worktrees, branches and archive refs sat on disk with nothing referencing them.
 * Hence `s.stored` (lenient about additions, strict about absences) plus a
 * version stamped INSIDE the value, since KV versions nothing itself. What
 * cannot be read is **quarantined and reportable**, never silently gone.
 */

export const TASK_SCHEMA_VERSION = 1;

/** Prefix, so a stray key in this namespace is not read as a task. */
const KEY_PREFIX = 'task:';

/**
 * Which repos the user picks, and how often — the picker's history.
 *
 * ONE key holding the whole list rather than a key per path, because it is read
 * and rewritten as a unit (`recordUse` ranks and caps the whole thing) and
 * because `keys()` is how `list()` finds tasks: fifty more keys in this
 * namespace would be fifty more strings to skip on every task read.
 *
 * The same KV a third party gets (ADR 0032). `SqliteStore.db` stays shut.
 */
const REPO_HISTORY_KEY = 'repo-history';

export interface RepoRef {
  /** The repo's own directory, as the user picked it. */
  readonly path: string;
  /** Its basename — the namespace for skill collisions, and the worktree's name. */
  readonly name: string;
}

/**
 * One tracked session of a task.
 *
 * `resumeTarget` is **opaque here** (D11). It comes from the agent kind that
 * captured it and goes back through the same seam; `tasks` never interprets it.
 * The moment this extension reads it, it has learned about a vendor.
 */
export interface TaskSession {
  readonly id: string;
  /** Which repo it works in, or absent for one that runs at the task root. */
  readonly repo?: string;
  readonly role: 'orchestrator' | 'workstream';
  readonly resumeTarget?: string;
  /**
   * The pane it was opened in.
   *
   * Recorded because the pane exists BEFORE the session does: the layout is
   * mutated by a command and the session is created when the pane mounts, so
   * for a moment `id` is a placeholder and this is the only true fact about
   * where the work went. It is also what a later reconciliation would key on.
   */
  readonly pane?: string;
  /**
   * The layout root — the TAB — that pane was opened in.
   *
   * Recorded at spawn rather than derived later, so the sidebar can roll each
   * tab's agent states up into that tab's own dot. Walking the layout per render
   * to work it out would be the second copy of "what is on screen" that ADR 0035
   * refuses, and it would have no answer at all for an archived task — whose
   * roots are gone while its record is not.
   *
   * Optional because records written before tabs existed do not carry it. Absent
   * means the task's anchor root, which is where every session of such a record
   * was in fact opened.
   */
  readonly root?: string;
}

/** Where a repo's uncommitted work went when the task was archived. */
export interface RepoArchive {
  readonly repo: string;
  readonly branch: string;
  readonly headSha: string;
  /** The pinned snapshot commit. Restore reads its tree. */
  readonly commit: string;
  /** The staged tree, so restore can re-split staged from unstaged. */
  readonly stagedTree: string;
}

export interface TaskRecord {
  readonly schemaVersion: typeof TASK_SCHEMA_VERSION;
  readonly id: string;
  /** Derived once and STORED — never re-derived from the title (D8). */
  readonly slug: string;
  readonly title: string;
  readonly brief: string;
  readonly lifecycle: TaskLifecycle;
  readonly repos: readonly RepoRef[];
  readonly sessions: readonly TaskSession[];
  readonly createdAt: number;
  /**
   * Which model this task's agents open on — absent means the kind's own default.
   *
   * On the record rather than passed to the first spawn, because a task outlives
   * it: a workstream joining later and a restored task reattaching have to open
   * on the same model. Absent on records written before it existed.
   */
  readonly model?: string;
  /** Present only while archived. Added later; `s.stored` reads old records fine. */
  readonly archives?: readonly RepoArchive[];
  /**
   * Its tabs, as they were when it was shelved — absent on a record written
   * before tabs existed, and on a task that has never been archived.
   */
  readonly tabs?: readonly ArchivedTab[];
  /**
   * When it was archived, so it can expire.
   *
   * Stored rather than derived from the snapshot commits' dates: a commit's
   * timestamp is git's and can be anything, and the question here — how long
   * has this been shelved — is about the app, not about the history.
   */
  readonly archivedAt?: number;
}

const repoSchema = s.stored({ path: s.string(), name: s.string() });

const sessionSchema = s.stored({
  id: s.string(),
  repo: s.optional(s.string()),
  role: s.enumOf(['orchestrator', 'workstream'] as const),
  resumeTarget: s.optional(s.string()),
  pane: s.optional(s.string()),
  /** Which TAB the pane was opened in. Absent on records written before tabs. */
  root: s.optional(s.string()),
});

const taskSchema = s.stored({
  schemaVersion: s.int(),
  id: s.string(),
  slug: s.string(),
  title: s.string(),
  brief: s.string(),
  lifecycle: s.enumOf(LIFECYCLE_STATES),
  repos: s.array(repoSchema),
  sessions: s.array(sessionSchema),
  createdAt: s.int(),
  model: s.optional(s.string()),
  archivedAt: s.optional(s.int()),
  archives: s.optional(
    s.array(
      s.stored({
        repo: s.string(),
        branch: s.string(),
        headSha: s.string(),
        commit: s.string(),
        stagedTree: s.string(),
      }),
    ),
  ),
  /**
   * The task's TABS, as they were when it was shelved.
   *
   * Additive and absent on every record written before tabs existed — such a
   * record restores exactly as it always did, into one root with one pane.
   *
   * `tree` is `s.unknown()` on purpose: it is the LAYOUT's persisted split
   * shape, carried verbatim and handed straight back to it. Validating it here
   * would be this extension holding a second opinion about a format that is not
   * its own, and the two would drift the first time the layout's changed.
   */
  tabs: s.optional(
    s.array(
      s.stored({
        root: s.string(),
        tree: s.optional(s.unknown()),
        focusedPane: s.union(s.string(), s.literal(null as unknown as string)),
        panes: s.array(
          s.stored({
            pane: s.string(),
            cwd: s.union(s.string(), s.literal(null as unknown as string)),
            userTitle: s.union(s.string(), s.literal(null as unknown as string)),
            sessionId: s.optional(s.string()),
            kindId: s.optional(s.string()),
            resumeTarget: s.optional(s.string()),
            history: s.optional(s.string()),
          }),
        ),
      }),
    ),
  ),
});

const repoHistorySchema = s.array(s.stored({ path: s.string(), uses: s.int(), lastUsedAt: s.int() }));

export class TaskStore {
  readonly #kv: KV;
  /** Ids present in storage that could not be read. Reportable, not silent. */
  readonly #unreadable = new Set<string>();

  constructor(kv: KV) {
    this.#kv = kv;
  }

  get(id: string): TaskRecord | undefined {
    const raw = this.#kv.get(`${KEY_PREFIX}${id}`, taskSchema);
    if (raw === undefined) {
      // Absent and unreadable are different facts, and only storage knows which:
      // `KV.get` collapses them, so the key list is what tells them apart.
      if (this.#kv.keys().includes(`${KEY_PREFIX}${id}`)) this.#unreadable.add(id);
      return undefined;
    }
    // A record from a FUTURE version is not read leniently — leniency covers
    // added keys, not changed meanings, and guessing at the latter is how a
    // downgrade corrupts data it could have left alone.
    if (raw.schemaVersion > TASK_SCHEMA_VERSION) {
      this.#unreadable.add(id);
      return undefined;
    }
    this.#unreadable.delete(id);
    return raw as TaskRecord;
  }

  list(): readonly TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const key of this.#kv.keys()) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const task = this.get(key.slice(KEY_PREFIX.length));
      if (task !== undefined) out.push(task);
    }
    return out;
  }

  put(task: TaskRecord): void {
    // Stamped on write, never trusted from the caller: the version describes the
    // shape this build writes, and a caller that could set it could lie about it.
    this.#kv.set(`${KEY_PREFIX}${task.id}`, { ...task, schemaVersion: TASK_SCHEMA_VERSION });
    this.#unreadable.delete(task.id);
  }

  remove(id: string): void {
    this.#kv.delete(`${KEY_PREFIX}${id}`);
    this.#unreadable.delete(id);
  }

  /** Every slug in use, for `uniqueSlug` (D8). Includes nothing unreadable. */
  takenSlugs(): ReadonlySet<string> {
    return new Set(this.list().map((task) => task.slug));
  }

  /** Ids whose stored record could not be read. For a warning the user can act on. */
  unreadable(): readonly string[] {
    return [...this.#unreadable];
  }

  /**
   * The repos the user has picked, already ranked (`recordUse` sorts on write).
   *
   * An unreadable value reads as an empty history rather than as a failure: this
   * is an accelerator, and a picker that refused to open because a preference
   * blob was malformed would be worse than one that has forgotten.
   */
  repoHistory(): readonly RepoUse[] {
    return this.#kv.get(REPO_HISTORY_KEY, repoHistorySchema) ?? [];
  }

  /** The user picked these. Deduped, because one task may name a repo once. */
  recordRepoUses(paths: readonly string[], now: number): void {
    let history = this.repoHistory();
    for (const path of new Set(paths)) history = recordUse(history, path, now);
    this.#kv.set(REPO_HISTORY_KEY, history);
  }
}
