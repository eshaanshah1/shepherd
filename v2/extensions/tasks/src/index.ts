import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  fuzzyMatch,
  s,
  sessionId,
  toDisposable,
  type ExtensionContext,
  type PresentEffect,
  type Shepherd,
} from '@shepherd/sdk';
import {
  REPO_PROVISIONED_POINT,
  REPO_SUGGESTIONS_POINT,
  TASK_COMMANDS,
  TASK_PROVISIONED_POINT,
  TASK_VIEWS,
  type RepoProvisioned,
  type TaskProvisioned,
} from './manifest.ts';
import { TaskStore, type RepoArchive, type RepoRef, type TaskRecord, type TaskSession } from './store.ts';
import { slugify, uniqueSlug } from './model/slug.ts';
import { heuristicName, namingPrompt, readName } from './model/naming.ts';
import { expandHome, collapseHome } from './model/repo-path.ts';
import { displayMatch, segmentsOf, type DisplaySegment } from './model/match-display.ts';
import { orderSuggestions, rankScored } from './model/pick-order.ts';
import { repoName } from './model/repo-name.ts';
import { completeDirectories, exactRepoPath, looksLikeRepo } from './suggest.ts';
import { taskRootId } from './model/root-id.ts';

/**
 * How much of a tab's screen is kept when a task is shelved.
 *
 * Enough to scroll back through what an agent did, and bounded: a build log that
 * printed a hundred thousand lines must not become a hundred-megabyte file
 * nobody asked for.
 */
const ARCHIVE_HISTORY_LINES = 1000;
/**
 * Asked of `agents-core`, never of a vendor: a task that named `claudeCode.*`
 * would be a task that knows which agent it hired (D11).
 */
const AGENTS_RESUME_TARGET = 'agents.resumeTarget';
const AGENTS_RESUME_COMMAND = 'agents.resumeCommand';
import { displayState } from './model/lifecycle.ts';
import { isTaskAgentState, rollUp, tintFor } from './model/agent-rollup.ts';
import { collectTaskDiff } from './model/diff-collect.ts';
import type { DiffStats } from './model/diff-stats.ts';
import { formatElapsed } from './model/elapsed.ts';
import { capTabRows } from './model/tab-rows.ts';
import {
  archiveTabsFrom,
  historyPath,
  type ArchivedTab,
  type RootReading,
} from './model/archive-tabs.ts';
import { synthTaskRoot } from './model/root-synth.ts';
import { planLaunch } from './model/launch.ts';
import { writePastedImages, type PastedImage } from './images.ts';
import { ARCHIVE_TTL_MS, expired } from './model/expiry.ts';
import {
  archiveWorktree,
  materializeTaskRoot,
  addWorktree,
  readRepoRefs,
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
  /** The path as a person writes it — home collapsed. What the field draws. */
  readonly display: string;
  /** `display`, already cut into matched and unmatched runs. */
  readonly segments: readonly DisplaySegment[];
}

/** See the `suggestRepos` handler: a list you arrow through, not one you scroll. */
const SUGGESTION_LIMIT = 10;

export interface TasksAPI {
  list(): readonly TaskRecord[];
  get(id: string): TaskRecord | undefined;
}

const repoArg = s.object({ path: s.string(), name: s.string() });

/**
 * The machine that is always in the list: this one.
 *
 * A NAME rather than an empty string, because a caller comparing against `''`
 * cannot tell "nothing was chosen" from "this Mac was chosen" — and those differ
 * the moment the default does.
 */
export const LOCAL_MACHINE = 'here';

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
  /** This row sits at the physical foot of the list, and so does what follows it. */
  foot?: boolean;
  tint?: string;
  busy?: boolean;
  /** The layout root this row stands for — the shell highlights from it. */
  root?: string;
  collapsed?: boolean;
  /**
   * The component this row draws itself as, by NAME, and its props.
   *
   * Structural like the rest of this interface: the SDK's `TreeItem` is the
   * contract and this is the shape that satisfies it, so the extension keeps
   * compiling against types it does not import.
   */
  component?: string;
  data?: unknown;
  command?: { id: string; args?: unknown };
  /**
   * The verb that answers what this row stands for, without doing anything —
   * what a client whose surface is on another machine calls instead of
   * `command`. See `TreeItem.presents`.
   */
  presents?: { id: string; args?: unknown };
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
 * `agents-core`'s state topic and its payload, as a literal and a local shape.
 *
 * Extension code may import `@shepherd/sdk` and nothing else, so it cannot reach
 * `@shepherd/ext-agents-core` for either — the same reason `ext-host/api.ts`
 * keeps its own copy of a topic string. A topic name is public vocabulary, like
 * a command id; the interface is a read of what the bus carries and is
 * deliberately narrower than the emitter's, with every field optional at the
 * type level because it crossed a port.
 */
const AGENT_STATE_TOPIC = 'agents.stateChanged';

interface AgentStateChanged {
  readonly pane?: string;
  readonly to?: string;
}

/** What `agents.list` answers, read for the two fields the mirror needs. */
interface AgentListAnswer {
  readonly agents?: readonly { readonly pane?: unknown; readonly state?: unknown }[];
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

/**
 * The layout's set of roots changed — one was opened, closed, or its focused
 * pane renamed. What the sidebar's tab rows are re-read on.
 */
const ROOTS_CHANGED_TOPIC = 'layout.rootsChanged';

interface RootClosed {
  readonly root?: string;
  /** Which pane GROUP emptied — a task's tabs all share one. */
  readonly group?: string;
  /**
   * Whether that was the group's LAST root.
   *
   * The whole reason the field exists. Reacting to the bare root id would
   * archive a task the moment its first tab closed, while another tab sat there
   * with a live agent in it — the task is finished with when ALL of its tabs
   * are.
   *
   * Optional, and absent means "yes": a kernel that predates tabs sends one root
   * per group, and a test that names only a root is describing that same case.
   */
  readonly groupEmpty?: boolean;
}

interface SessionExited {
  readonly sessionId: string;
  readonly paneId?: string;
}

/** A repo whose worktree exists — what the root synthesis and the task seam read. */
interface LandedRepo {
  readonly name: string;
  readonly path: string;
  readonly worktree: string;
}

/**
 * What the orchestrator is told. Deliberately thin: the generated `CLAUDE.md`
 * at its cwd already carries the brief and the repo map (ADR 0029), so
 * restating them here would be the same text twice, drifting.
 */
/**
 * What a busy row says it is doing. The word is drawn as-is, so it is written in
 * the tense a row can be read in the middle of.
 */
type BusyWhat = 'archiving' | 'restoring' | 'provisioning' | 'naming';

function orchestratorPrompt(task: { title: string; brief: string }): string {
  return task.brief.trim() === '' ? `Start on the task "${task.title}".` : task.brief;
}

export function activate(ctx: ExtensionContext, api: Shepherd): TasksAPI {
  const { commands, events, points, views } = api.proposed;

  /**
   * A verb about a task on ANOTHER machine, run there instead of here.
   *
   * Answers `undefined` when the task belongs to this Mac, which is the ordinary
   * case and the one the caller falls through to. `remote.at` carries the command
   * rather than defining one, so the member runs the identical verb its own UI
   * would — there is no remote-shaped dialect of `tasks.create` to keep in step.
   *
   * `member` is stripped on the way out. Over there this IS the local machine, and
   * a forwarded `member` naming somebody else would either bounce back to us or
   * hop again.
   */
  const forwardToMember = async (
    command: string,
    args: { member?: string } & Record<string, unknown>,
  ): Promise<unknown | undefined> => {
    const member = args.member;
    if (member === undefined || member === '' || member === LOCAL_MACHINE) return undefined;
    const { member: _here, ...rest } = args;
    const answer = await commands.invoke('remote.at', { member, command, args: rest });
    if (!answer.ok) {
      // The member's own words, not a summary: "that Mac is asleep" and "that verb
      // exploded" call for different actions and a generic failure is what makes a
      // remote call impossible to debug from either end.
      throw new Error(`${member} could not run ${command}: ${answer.error.message}`);
    }
    return answer.value;
  };

  const store = new TaskStore(ctx.storage);
  /** Per-repo provisioning state. In memory, deliberately — see `provision`. */
  const provisioning = new Map<string, 'working' | 'ready' | 'failed'>();
  /**
   * A repo that provisioned, and whose `repoProvisioned` providers complained.
   *
   * Separate from `provisioning` rather than a fourth value in it, because the
   * repo IS ready: the worktree is there and an agent is about to open in it.
   * Collapsing the two would either hide the complaint or lie about the state,
   * and the second is worse — a row reading `failed` beside a worktree that
   * exists sends you looking for a git problem that is not there.
   */
  const hookIssue = new Map<string, string>();
  /**
   * A task-level provisioning complaint, keyed by task id — `hookIssue`'s
   * sibling, one scope up. Mirrors it deliberately, including not being swept on
   * delete: the two should be wrong or right together, not one each way.
   */
  const taskIssue = new Map<string, string>();

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
  const busy = new Map<string, BusyWhat>();

  /**
   * Run a long operation with the row saying so, whatever the outcome.
   *
   * **Nestable, and that is load-bearing.** `provision` wraps itself, and
   * `tasks.restore` calls it from inside its own `restoring` wrap — so the
   * inner `finally` restores what it displaced rather than deleting the key.
   * Deleting it dropped the spinner back to idle for the rest of a restore,
   * which is the second half of the operation and the slower one.
   */
  async function whileBusy<T>(taskId: string, what: BusyWhat, run: () => Promise<T>): Promise<T> {
    const displaced = busy.get(taskId);
    busy.set(taskId, what);
    changed();
    try {
      return await run();
    } finally {
      // `finally`, so a refusal — the conflicted-worktree case the archive verb
      // exists to have — leaves a row that is idle and wrong-looking rather than
      // one that spins forever.
      if (displaced === undefined) busy.delete(taskId);
      else busy.set(taskId, displaced);
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
  /**
   * `paneId → agent state`, and the only copy of it this extension holds.
   *
   * A MIRROR, because `tasks` cannot ask: reads do not cross the port
   * (`attention.get` throws `ACROSS_A_PORT`), so an extension subscribes to an
   * announcement and keeps its own map. This REPLACES the attention mirror
   * rather than joining it — `needs-you` was always derived from state upstream,
   * so deriving it here removes a copy instead of adding one, and two mirrors of
   * one fact are two things that can disagree.
   *
   * Keyed by PANE, which is why `agents.stateChanged` carries one: a task's
   * record holds a `pending-` session id for the first seconds after a spawn,
   * and only its pane is true.
   */
  const agentState = new Map<string, string>();

  /*
   * There is deliberately NO mirror of the active root here.
   *
   * Which task you are looking at is the layout's fact, and this extension
   * keeping a copy of it would be the bug it is meant to fix, one process
   * along: a copy needs seeding when the host starts, lags the stage by the
   * round trip that fills it, and desynchronises if a nudge is dropped. The
   * row names its own root instead (`rowFor`), and the shell — which already
   * holds the active root, because it draws the stage from it — does the
   * comparison. See `TreeItem.root`.
   */

  /**
   * D4, made real: what a task's agents are doing is READ from the panes, never
   * written anywhere.
   *
   * A session whose pane never mounted contributes nothing rather than a guess,
   * and so does one the mirror has not heard from — both are "no signal", which
   * `rollUp` folds to idle.
   */
  const agentStatesOf = (task: TaskRecord): readonly string[] =>
    task.sessions.flatMap((session) => {
      const state = session.pane === undefined ? undefined : agentState.get(session.pane);
      return state === undefined ? [] : [state];
    });

  /**
   * The same rollup, for the sessions in ONE tab.
   *
   * A session with no recorded root belongs to the task's anchor — that is where
   * every session written before tabs existed was in fact opened, so an old
   * record rolls up into tab 1 rather than into nothing.
   */
  const agentStatesOfTab = (task: TaskRecord, root: string): readonly string[] =>
    task.sessions.flatMap((session) => {
      if ((session.root ?? taskRootId(task.id)) !== root) return [];
      const state = session.pane === undefined ? undefined : agentState.get(session.pane);
      return state === undefined ? [] : [state];
    });

  /**
   * `group → its tabs`, mirrored — the layout, as much of it as the sidebar needs.
   *
   * A MIRROR for the reason `agentState` above is one: reads do not cross the
   * port (`LayoutAPI`'s getters throw `ACROSS_A_PORT`), so an extension
   * subscribes to an announcement and re-reads through a command. The command is
   * `layout.listRoots`, which is the single authority — nothing here derives a
   * tab's label, and nothing invents an id.
   *
   * It is emphatically NOT a copy of which tab is on SCREEN. That question is
   * still the layout's alone, answered by the shell from the snapshot it draws
   * the stage from (ADR 0035); what this holds is which tabs EXIST and what they
   * are called, which nothing else can tell this extension.
   */
  let tabsByGroup = new Map<string, readonly { root: string; label: string; session: string | null }[]>();

  const refreshTabs = async (): Promise<void> => {
    const answer = await commands.invoke<readonly unknown[]>('layout.listRoots', {});
    if (!answer.ok || !Array.isArray(answer.value)) return;
    const next = new Map<string, { root: string; label: string; session: string | null }[]>();
    for (const raw of answer.value) {
      // Read defensively: this crossed a port, and `ok` says the call succeeded
      // rather than that the value has a shape.
      const row = raw as {
        root?: unknown;
        group?: unknown;
        label?: unknown;
        focusedSession?: unknown;
      };
      if (typeof row.root !== 'string' || typeof row.group !== 'string') continue;
      const list = next.get(row.group) ?? [];
      list.push({
        root: row.root,
        // A root with no panes has no label to give. It says so rather than
        // showing its id: `task:t1/tab-2` in the sidebar is an internal name.
        label: typeof row.label === 'string' && row.label !== '' ? row.label : 'Empty',
        session: typeof row.focusedSession === 'string' ? row.focusedSession : null,
      });
      next.set(row.group, list);
    }
    tabsByGroup = next;
    changed();
  };

  /**
   * Subscribing to the topic, WITHOUT declaring any permission.
   *
   * `events.on` is membership-gated only — being a loaded extension is the whole
   * of the check — while `attention.set`/`clear` are what the `attention`
   * permission guards. So this is a read of a fact `agents-core` publishes, and
   * ADR 0026's single-writer rule is untouched: nothing below writes state, it
   * only mirrors what was announced. See the manifest's comment for why
   * declaring the permission would be the actual violation.
   */
  ctx.subscriptions.push(
    events.on<AgentStateChanged>(AGENT_STATE_TOPIC, (payload) => {
      // Structural, not schematic: the payload crossed a port, and a malformed
      // one must be dropped rather than keying the mirror on `undefined` — which
      // could then never be cleared, since no later change can name that key.
      if (typeof payload?.pane !== 'string' || typeof payload.to !== 'string') return;
      const delta = agentState.get(payload.pane) !== payload.to;
      agentState.set(payload.pane, payload.to);
      // The tree is pull-based (ADR 0031): the host re-asks `children()` only
      // when nudged, so a mirror that changed and did not nudge is a sidebar
      // still showing the old state. Nudged on a real delta only, because a
      // state can be re-announced with a new reason and nothing here has moved.
      if (delta) changed();
    }),
  );

  /**
   * Follow first, then pull, and merge the snapshot UNDER what has arrived.
   *
   * An extension that only subscribes misses everything published before it
   * woke, and every row would read idle until its session's next transition. The
   * renderer solved this the same way and for the same reason (`app.tsx`): a
   * transition landing between the two is newer than the snapshot by
   * construction, so the snapshot must never overwrite it.
   *
   * Failure is a warn, not a throw. A seed that did not land costs accuracy
   * until the next transition, which is the state this extension has always
   * started in — and the line is what tells that apart from a dead wire.
   */
  void commands
    .invoke<AgentListAnswer>('agents.list')
    .then((answer) => {
      if (!answer.ok) {
        /**
         * `unknown-command` is not a failure. It means no agent extension is
         * loaded — a legitimate configuration, and one `tasks` must not require:
         * with nobody publishing agent state there is nothing to seed and nothing
         * to seed it FROM, so rows read idle and stay right. Warning about it
         * would put a line at every startup of a build that is behaving
         * correctly, which is how a log stops being read.
         *
         * Anything else IS worth a line — that is a seam that exists and did not
         * answer, and the difference between it and a dead wire is this message.
         */
        const level = answer.error.code === 'unknown-command' ? 'debug' : 'warn';
        ctx.log[level](`agents.list did not seed the agent-state mirror (${answer.error.code}); rows read idle until the next change`);
        return;
      }
      /**
       * Nothing to seed is not a complaint — `agents-core`'s own `readSessionRows`
       * draws the line in exactly this place. An absent or unreadable list means
       * no agent is tracked yet, which is the ordinary state of a build that has
       * just started. The line worth printing is the one where the answer HAD
       * rows and none of them were usable: that is the shape changing under us,
       * and it is what tells a schema drift apart from a quiet morning.
       */
      const rows = Array.isArray(answer.value?.agents) ? answer.value.agents : [];
      let seeded = 0;
      for (const row of rows) {
        if (typeof row?.pane !== 'string' || typeof row.state !== 'string') continue;
        if (agentState.has(row.pane)) continue;
        agentState.set(row.pane, row.state);
        seeded += 1;
      }
      if (rows.length > 0 && seeded === 0) {
        ctx.log.warn(`agents.list answered ${rows.length} row(s) and none carried a pane and a state`);
      }
      if (seeded > 0) changed();
    })
    .catch((error: unknown) => {
      ctx.log.warn(`agents.list threw while seeding the agent-state mirror — ${String(error)}`);
    });

  const suggestions = points.define<RepoSuggestionProvider>(REPO_SUGGESTIONS_POINT, {
    order: 'priority',
  });
  ctx.subscriptions.push(suggestions);

  /**
   * Registration order, not priority: these are side effects on a directory, so
   * "which one wins" is not a question anybody is asking. Every provider runs,
   * and the order they were registered in is the only order that means anything.
   */
  const repoProvisioned = points.define<RepoProvisioned>(REPO_PROVISIONED_POINT, {
    order: 'registration',
  });
  ctx.subscriptions.push(repoProvisioned);

  /**
   * The same, one scope up: every worktree exists and the root is written.
   *
   * Registration order for the same reason — a provider here is a side effect on
   * the task root, and "which one wins" is not a question anybody is asking.
   */
  const taskProvisioned = points.define<TaskProvisioned>(TASK_PROVISIONED_POINT, {
    order: 'registration',
  });
  ctx.subscriptions.push(taskProvisioned);

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
  /**
   * Below this there is nothing to name yet, and asking spends budget for nothing.
   */
  const MIN_BRIEF_CHARS = 24;
  /**
   * How much a brief must have moved before the same question is worth re-asking.
   *
   * On CONTENT rather than on a timer alone: a pause after twenty more characters
   * is a different brief, a pause after two is the same one. §7c named budget as
   * the reason `agents` is its own permission, and a per-keystroke ask would spend
   * it several times per task.
   */
  const BRIEF_DRIFT_CHARS = 20;
  /**
   * How long the ASK may take, and so how long a task's first `worktree add` may
   * be held for a name (D20) — this is the only clock.
   *
   * Measured: a real naming call — this prompt, the whole brief — is ~10.5s, so
   * this is headroom over that rather than a round number. It is a ceiling and not
   * an expectation: a model that is absent or signed out fails in about two
   * seconds, and the composer's speculative ask (D21) means Create usually joins
   * one already most of the way through.
   */
  const NAME_ASK_TIMEOUT_MS = 30_000;

  /**
   * The last naming ask, and the brief it was about.
   *
   * ONE entry, not a map: the composer asks about a brief that is growing, and
   * every earlier answer is about text nobody has on screen any more. Keeping this
   * is what makes the composer's ask and provisioning's ask the same ask (D21) —
   * Create pressed while one is in flight awaits it instead of starting a second
   * and paying for the model twice.
   */
  let pending: { brief: string; answer: Promise<string | undefined> } | undefined;

  const askForName = async (brief: string): Promise<string | undefined> => {
    const answer = await commands.invoke(
      'agents.complete',
      { prompt: namingPrompt(brief), timeoutMs: NAME_ASK_TIMEOUT_MS },
      // The same number twice, and both are needed: the argument is how long the
      // MODEL may take, and this is how long the two transport legs between here
      // and it will wait. Stating only the first is how a 12s naming call came
      // back as `timeout` at 10s while the answer was still on its way.
      { timeoutMs: NAME_ASK_TIMEOUT_MS },
    );
    if (!answer.ok) return undefined;
    /**
     * Read defensively. `ok` says the call succeeded, not that the value has a
     * shape — it crossed a port from an extension this code has never seen, and a
     * cast is not a check.
     */
    const value = answer.value as { ok?: unknown; text?: unknown } | null;
    if (typeof value !== 'object' || value === null || value.ok !== true) return undefined;
    if (typeof value.text !== 'string') return undefined;
    return readName(value.text);
  };

  /**
   * The name for this brief — the in-flight ask if there is one for it, otherwise
   * a new one. Never rejects: a naming failure is not a failure of whatever asked.
   */
  const pendingName = (brief: string): Promise<string | undefined> => {
    const trimmed = brief.trim();
    if (trimmed.length < MIN_BRIEF_CHARS) return Promise.resolve(undefined);
    if (pending !== undefined && Math.abs(pending.brief.length - trimmed.length) < BRIEF_DRIFT_CHARS) {
      return pending.answer;
    }
    const answer = askForName(trimmed).catch(() => undefined);
    pending = { brief: trimmed, answer };
    return answer;
  };

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.suggestName, {
      title: 'Tasks: Suggest a Name',
      schema: s.object({ brief: s.string() }),
      handler: async (args) => ({ name: (await pendingName(args.brief)) ?? null }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.suggestRepos, {
      title: 'Tasks: Suggest Repos',
      schema: s.object({
        title: s.optional(s.string()),
        brief: s.optional(s.string()),
        query: s.optional(s.string()),
        /** Whose checkouts to offer. See `tasks.create`'s `member`. */
        member: s.optional(s.string()),
      }),
      handler: async (args) => {
        /*
         * Asked of the machine the task will be CREATED on, not of this one.
         *
         * A repo path is meaningful only on the machine that holds it, so a
         * picker offering this Mac's checkouts for a task starting on another Mac
         * would offer paths that do not exist over there — and `git worktree add`
         * would fail after the brief had been typed and Create pressed.
         */
        const elsewhere = await forwardToMember(TASK_COMMANDS.suggestRepos, args);
        if (elsewhere !== undefined) return elsewhere;
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

        // A row crosses the port ready to DRAW: the text as a person writes it
        // (home collapsed) and the positions already shifted into that text. The
        // view has neither a home directory nor a matcher, deliberately.
        const drawn = (
          row: Omit<RepoSuggestion, 'display' | 'segments'>,
          positions: readonly number[],
        ): RepoSuggestion => {
          const shown = displayMatch(row.path, positions, ctx.homeDir);
          return { ...row, display: shown.text, segments: shown.segments };
        };

        /*
         * History matches the repo's NAME, never the path around it.
         *
         * A path is mostly other people's words — `/Users/eshaannileshshah`
         * alone supplies an `s`, an `h` and an `e` before any repo name gets a
         * look in, so `shep` matched inside the home prefix and came back as a
         * lone `p` two thirds of the way along: a match the field asserted and
         * could not justify. The name is the part you are actually thinking of,
         * which is why `completeDirectories` has always matched against it and
         * only history did not.
         *
         * The query is reduced the same way, to its last segment, so a typed
         * path and a bare word ask the same question of the same string.
         */
        const shownQuery = collapseHome(query, ctx.homeDir);
        const queryName = shownQuery.slice(shownQuery.lastIndexOf('/') + 1);
        // The score ranks and is then thrown away — it is this handler's working
        // note, not something a view should be able to read and re-sort by.
        const ranked: { readonly row: RepoSuggestion; readonly score: number }[] = [];
        for (const repo of fromPoint.values()) {
          const shown = collapseHome(repo.path, ctx.homeDir);
          const nameAt = shown.lastIndexOf('/') + 1;
          const hit = fuzzyMatch(queryName, shown.slice(nameAt));
          if (hit === null) continue;
          ranked.push({
            score: hit.score,
            row: {
              path: repo.path,
              name: repo.name,
              isRepo: looksLikeRepo(repo.path),
              source: 'history',
              display: shown,
              // Back into the whole string, which is what gets drawn.
              segments: segmentsOf(shown, hit.positions.map((at) => at + nameAt)),
            },
          });
        }
        const history = rankScored(ranked);

        const filesystem: RepoSuggestion[] = [];
        for (const candidate of completeDirectories(query, ctx.homeDir)) {
          if (fromPoint.has(candidate.path)) continue;
          filesystem.push(
            drawn(
              {
                path: candidate.path,
                name: repoName(candidate.path),
                isRepo: candidate.isRepo,
                source: 'filesystem',
              },
              candidate.positions,
            ),
          );
        }

        // The path you typed the whole of, if it is a repo, is a row of its own —
        // completion answers such a path with its CHILDREN, so it appears nowhere
        // in either list above.
        const exact = exactRepoPath(query);
        if (exact !== null && ![...filesystem, ...history].some((row) => row.path === exact)) {
          filesystem.unshift(
            drawn(
              { path: exact, name: repoName(exact), isRepo: true, source: 'filesystem' },
              fuzzyMatch(query, exact)?.positions ?? [],
            ),
          );
        }

        return orderSuggestions(filesystem, history, exact, SUGGESTION_LIMIT);
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
  /**
   * The layout gained, lost or renamed something — go and look again.
   *
   * Payload-free by design at the source, so this re-reads rather than trusts:
   * one authority (`layout.listRoots`), not a second copy arriving by a route
   * that can drop.
   */
  ctx.subscriptions.push(events.on(ROOTS_CHANGED_TOPIC, () => void refreshTabs()));
  // And once at startup, because an extension that only subscribes misses
  // everything that happened before it was activated — including every tab of
  // every task restored at launch.
  void refreshTabs();

  ctx.subscriptions.push(
    events.on<RootClosed>(ROOT_CLOSED_TOPIC, (payload) => {
      // One tab of a task closing is not the task closing.
      if (payload?.groupEmpty === false) return;
      const group = payload?.group ?? payload?.root;
      if (typeof group !== 'string') return;
      const task = store.list().find((candidate) => taskRootId(candidate.id) === group);
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

  /**
   * What each task has CHANGED — read from git, cached, never per render.
   *
   * Transient like `busy` above and for a stronger reason: this is a fact about
   * a WORKTREE, and a worktree can be edited by anything on the machine. A value
   * persisted into the store would be a claim about disk that survives the disk
   * changing, and it would be wrong from the first commit made in a terminal.
   *
   * **Refreshed on a beat, not on a render.** `rowFor` runs on every tree
   * change, and a `git diff` per row per change is a subprocess storm — v1 spent
   * a third of a core learning that lesson with `RepoSignals`. So the tree reads
   * whatever is in this map (drawing no diff line when there is nothing yet) and
   * the refresh below fills it and nudges the tree once, which is the same
   * shape v1 landed on for PR status.
   */
  const diffs = new Map<string, DiffStats>();

  /**
   * The last suite result reported for a task — see `TASK_COMMANDS.reportSuite`.
   *
   * Transient for the same reason `diffs` is: a result describes a moment, and
   * one persisted into the store would outlive the code it measured. A restart
   * showing no meter is correct — nothing has run yet in this session.
   */
  const suites = new Map<string, { readonly total: number; readonly passed: number }>();

  /**
   * One task's diff, re-read.
   *
   * `inFlight` exists because the triggers overlap: a turn finishing, a pane
   * being focused and the periodic refresh can all fire within a second of each
   * other, and without it that is three `git diff` processes racing to write the
   * same key. One read per task at a time; the later callers get the earlier
   * read's answer on the next beat, which is soon enough for a number that
   * changes when a human types.
   */
  const inFlight = new Set<string>();

  async function refreshDiff(task: TaskRecord): Promise<void> {
    if (inFlight.has(task.id)) return;
    inFlight.add(task.id);
    try {
      const stats = await collectTaskDiff(api.proposed.process, task.repos.map((repo) => repo.path));
      const before = diffs.get(task.id);
      if (stats === null) {
        // UNKNOWN, not zero — and an unreadable repo does not erase the last
        // number we did read. A worktree mid-`git worktree remove` would
        // otherwise blank a card and then restore it a second later.
        return;
      }
      diffs.set(task.id, stats);
      // Only nudge the tree when the ANSWER moved. The refresh runs on a timer,
      // and a tree change per tick would re-render the rail twice a minute for
      // nothing.
      if (
        before === undefined ||
        before.added !== stats.added ||
        before.removed !== stats.removed ||
        before.files !== stats.files
      ) {
        changed();
      }
    } catch (error) {
      // A git failure is not a reason to take the sidebar down. The card simply
      // draws no diff line, which is the honest rendering of "we do not know".
      ctx.log.warn(`diff read failed for ${task.id} — ${String(error)}`);
    } finally {
      inFlight.delete(task.id);
    }
  }

  /**
   * Every live task. Archived ones have no worktree to read.
   *
   * **Demand-driven, not fired at activate.** Two reasons, and the second is the
   * one that matters:
   *
   *   - Startup is already provisioning worktrees, which is git work the user is
   *     actually waiting on. Racing it with reads for a number nobody has looked
   *     at yet spends the same subprocess budget on the wrong thing.
   *   - A rail that is never drawn should do no git AT ALL. Hanging this off the
   *     tree read means the cost is paid by the surface that wants it, which is
   *     also why an app with the sidebar closed is silent.
   *
   * It is safe to call from `getChildren`: `inFlight` bounds it to one read per
   * task, and the nudge below only fires when the ANSWER moved — so read →
   * refresh → changed → read settles after one round instead of spinning.
   */
  function refreshDiffs(): void {
    for (const task of store.list()) {
      if (task.lifecycle === 'archived') continue;
      void refreshDiff(task);
    }
  }

  /** The foot row's own expansion key — not a task id, and never colliding. */
  const SHIPPED_KEY = 'group:shipped';

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
      /*
       * `group: root` — the task's root is the ANCHOR of the task's own pane
       * group, and every later tab of it joins that group. One string, two
       * roles, which is exactly what `taskRootId`'s note is about.
       */
      { root, group: root, cwd, initialCommand: command, title },
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
      // Off the record, not the call: every session a task opens uses the same one.
      ...(task.model === undefined ? {} : { model: task.model }),
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
      /*
       * Which TAB it went into, so the sidebar can give that tab its own dot.
       *
       * The anchor, because that is where `openAgentPane` puts every agent — it
       * mints the anchor root or splits it, and never opens a second tab.
       * Spawning into whichever tab is on screen is a nicer gesture and a
       * different decision; recording the truth of today is what keeps this
       * field from being a guess.
       */
      root: taskRootId(task.id),
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
     * The command comes from the agent kind, not from here (ADR 0036 §3).
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
  /** Where an archived screen lives. Outside any task root — a task root is deleted. */
  const archiveDir = (): string => `${ctx.dataDir}/.archives`;

  /**
   * Every tab of a task, and the screen each of its panes was showing.
   *
   * The layout is asked rather than the record: the record knows which sessions
   * a task started, and the layout knows what is actually on screen — splits the
   * user made, panes they opened themselves, a tab with no agent in it at all.
   *
   * **Best-effort, per pane.** A session that has already exited has no mirror,
   * and a task you cannot shelve because one pane's history could not be read is
   * a worse outcome than a tab that comes back blank. Each failure is warned
   * about and the pane is archived without a `history`.
   */
  async function captureTabs(task: TaskRecord): Promise<readonly ArchivedTab[]> {
    const listed = await commands.invoke<readonly unknown[]>('layout.listRoots', {
      group: taskRootId(task.id),
    });
    if (!listed.ok || !Array.isArray(listed.value)) return [];

    const roots: RootReading[] = [];
    const history: Record<string, string> = {};

    for (const raw of listed.value) {
      // Read defensively: this crossed a port, and `ok` says the call succeeded
      // rather than that the value has a shape.
      const row = raw as { root?: unknown; tree?: unknown; focusedPane?: unknown; panes?: unknown };
      if (typeof row.root !== 'string') continue;
      const panes = Array.isArray(row.panes) ? row.panes : [];

      const reading: RootReading['panes'][number][] = [];
      for (const rawPane of panes) {
        const p = rawPane as { pane?: unknown; cwd?: unknown; userTitle?: unknown; session?: unknown };
        if (typeof p.pane !== 'string') continue;
        reading.push({
          pane: p.pane,
          cwd: typeof p.cwd === 'string' ? p.cwd : null,
          userTitle: typeof p.userTitle === 'string' ? p.userTitle : null,
        });

        if (typeof p.session !== 'string') continue;
        const relative = historyPath(task.id, row.root, p.pane);
        try {
          const captured = await commands.invoke<{ bytes?: unknown }>('sessions.capture', {
            session: p.session,
            lines: ARCHIVE_HISTORY_LINES,
          });
          if (!captured.ok || typeof captured.value?.bytes !== 'string') {
            throw new Error(captured.ok ? 'no bytes' : captured.error.message);
          }
          const file = `${archiveDir()}/${relative}`;
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.from(captured.value.bytes, 'base64'));
          history[p.pane] = relative;
        } catch (error) {
          ctx.log.warn(
            `task ${task.id}: pane ${p.pane} was archived without its history — ${(error instanceof Error ? error.message : String(error))}`,
          );
        }
      }

      roots.push({
        root: row.root,
        ...(row.tree === undefined || row.tree === null ? {} : { tree: row.tree }),
        focusedPane: typeof row.focusedPane === 'string' ? row.focusedPane : null,
        panes: reading,
      });
    }

    return archiveTabsFrom({
      roots,
      // `resumeTarget` is the only session field restore needs, and it is opaque
      // (D11) — it names the agent's own way back without this extension ever
      // learning which agent that is.
      sessions: task.sessions.flatMap((session) =>
        session.pane === undefined
          ? []
          : [
              {
                pane: session.pane,
                sessionId: session.id,
                ...(session.resumeTarget === undefined ? {} : { resumeTarget: session.resumeTarget }),
              },
            ],
      ),
      history,
    });
  }

  /**
   * Put an archived task's tabs back — the SCREEN, and nothing else.
   *
   * **It relaunches nothing.** Each pane comes back at its directory with the
   * screen it had, and its agent's resume line is TYPED AND LEFT SITTING at the
   * prompt. Pressing Enter is what resumes an agent, and that is the user's to
   * press: restoring a five-tab task to glance at it must not start five agents.
   *
   * The mechanism is one character. `layout.setInitialInput` documents that a
   * newline in the staged string is an Enter press, so a line with none is typed
   * and waits. There is no new seam here, and the "exactly one initial input per
   * pane" invariant is untouched.
   *
   * Ids are the ARCHIVED ones (`layout.openRoot` takes the root to open), so a
   * restored task's tabs come back under the names they had — which is what the
   * sidebar's rows and the strip both key on.
   */
  async function rebuildTabs(task: TaskRecord): Promise<void> {
    const group = taskRootId(task.id);
    for (const tab of task.tabs ?? []) {
      const first = tab.panes[0];
      const seed = readHistory(tab.panes[0]?.history);
      const staged = await stagedResumeLine(task, first);

      const opened = await commands.invoke('layout.openRoot', {
        root: tab.root,
        group,
        ...(first?.cwd === undefined || first.cwd === null ? {} : { cwd: first.cwd }),
        ...(first?.userTitle === undefined || first.userTitle === null ? {} : { title: first.userTitle }),
        ...(seed === undefined ? {} : { seed }),
        ...(staged === undefined ? {} : { initialCommand: staged }),
      });
      if (!opened.ok) {
        // Reported and stepped over: the other tabs are still worth putting
        // back, and a restore that gave up on the first failure would leave a
        // task half on screen with nothing saying why.
        ctx.log.warn(
          `task ${task.id}: tab ${tab.root} was not restored — ${opened.error.code}: ${opened.error.message}`,
        );
        continue;
      }

      /*
       * The rest of the tab's panes, in order, each with its own screen and its
       * own staged line. The SPLIT SHAPE is not rebuilt: `layout.split` takes an
       * axis and no path, so a tree of ratios cannot be reproduced through it,
       * and a restore that silently produced a different arrangement would be
       * worse than one that is honestly flat. The panes, their directories and
       * their history all come back; the geometry does not, yet.
       */
      for (const pane of tab.panes.slice(1)) {
        const paneSeed = readHistory(pane.history);
        const paneStaged = await stagedResumeLine(task, pane);
        const split = await commands.invoke('layout.split', {
          axis: 'row',
          root: tab.root,
          ...(pane.cwd === null ? {} : { cwd: pane.cwd }),
          ...(paneSeed === undefined ? {} : { seed: paneSeed }),
          ...(paneStaged === undefined ? {} : { initialCommand: paneStaged }),
        });
        if (!split.ok) {
          ctx.log.warn(
            `task ${task.id}: a pane of ${tab.root} was not restored — ${split.error.code}: ${split.error.message}`,
          );
        }
      }
    }
    ctx.log.info(`task ${task.id}: restored ${(task.tabs ?? []).length} tab(s), agents staged but not resumed`);
  }

  /** A captured screen off disk, base64 for the command envelope. Absent if unreadable. */
  function readHistory(relative: string | undefined): string | undefined {
    if (relative === undefined) return undefined;
    try {
      return readFileSync(`${archiveDir()}/${relative}`).toString('base64');
    } catch (error) {
      // A missing file is an expired or hand-cleaned archive; the tab still
      // comes back, blank, which is better than refusing to restore it.
      ctx.log.warn(`task: a tab's screen could not be read — ${String(error)}`);
      return undefined;
    }
  }

  /**
   * The line that WOULD resume this pane's agent — built, not run.
   *
   * Asked of the agent kind through `agents.resumeCommand`, exactly as
   * `resumeSession` does, so `tasks` still never learns a binary or a flag
   * (D11). Trailing whitespace is trimmed because the one thing that must not
   * be in it is a newline.
   */
  async function stagedResumeLine(
    task: TaskRecord,
    pane: { readonly resumeTarget?: string } | undefined,
  ): Promise<string | undefined> {
    const target = pane?.resumeTarget;
    if (target === undefined || target === '') return undefined;
    const answer = await commands.invoke<unknown>(AGENTS_RESUME_COMMAND, { target });
    const command =
      answer.ok && typeof answer.value === 'object' && answer.value !== null
        ? (answer.value as { command?: unknown }).command
        : undefined;
    if (typeof command !== 'string' || command === '') {
      ctx.log.info(`task ${task.id}: a restored pane has no resume command to stage`);
      return undefined;
    }
    // THE character. A trailing newline is an Enter press, and this line is
    // meant to sit at the prompt until somebody decides to run it.
    return command.replace(/\s+$/u, '');
  }

  async function closeTaskRoot(task: TaskRecord): Promise<void> {
    const group = taskRootId(task.id);
    /*
     * The GROUP, not the root.
     *
     * A task's tabs are all of it. Closing only the anchor would leave its other
     * tabs on screen with live agents in them and no task behind them — rows
     * pointing at a task that has just been archived, and ptys nothing will ever
     * close.
     */
    const closed = await commands.invoke('layout.closeGroup', { group });
    if (closed.ok) return;
    if (closed.error.code === 'handler-failed' && closed.error.message.includes(`no group ${group}`)) return;
    ctx.log.warn(
      `task ${task.id}: its pane group was not closed — ${closed.error.code}: ${closed.error.message}`,
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
  /**
   * The row says so for the WHOLE of it — which is the wait a user actually has.
   *
   * Wrapped here rather than at the two call sites, because this function is
   * the slow thing: creating a task calls it and so does restoring one, and a
   * `whileBusy` per caller is the arrangement that left `tasks.create` — the
   * longest wait in the app and the only one you sit through — drawing an idle
   * row while Probe 2's ~2.5s-per-repo of network went by.
   *
   * The whole function, not the repo loop inside it. `provisioning` already
   * tracks each `worktree add`, but the root synthesis, the trust seeding and
   * the orchestrator's own launch come after the last repo lands, and they are
   * seconds of the wait that no per-repo state can speak for.
   */
  /**
   * The slug's one permitted change — before the first git write, and never after
   * (D19).
   *
   * At this moment the record has no sessions, no archives, nothing on disk is
   * named after it and no pane has a cwd inside it. After the first
   * `worktree add`, changing it would mean `git branch -m`, `git worktree move`,
   * moving the task root and re-synthesizing its CLAUDE.md and symlinks, and
   * re-seeding Claude Code's per-path trust — all while an orchestrator is booting
   * with a cwd inside the directory being moved. So: once, here, or never.
   *
   * **The first `worktree add` waits for it** (D20). There is one clock, the ask's
   * own, because a second and shorter one only produced names that could not be
   * used: the window closes at the first git write, so an answer that arrives
   * after it is an answer thrown away — and the 4s that used to bound this lost
   * every real ~10.5s call. `pendingName` never rejects and an absent or
   * signed-out model says so in about two seconds, so the wait a person actually
   * sits through is the tail of an ask the composer already started (D21).
   *
   * `takenSlugs` is re-checked because a concurrent create may have taken the
   * name in the meantime.
   */
  async function settleName(draft: TaskRecord): Promise<TaskRecord> {
    const named = await pendingName(draft.brief);
    if (named === undefined) return draft;

    const slug = uniqueSlug(slugify(named), store.takenSlugs());
    // The title is worth taking even when the slug is unchanged: one call answers
    // both, and the row label is the half nothing on disk depends on.
    const settled: TaskRecord = { ...draft, slug, title: named };
    store.put(settled);
    changed();
    if (slug !== draft.slug) ctx.log.info(`task ${draft.id}: named ${slug} before its first worktree`);
    return settled;
  }

  /**
   * Did this repo get through BOTH steps — `worktree add` and every
   * `repoProvisioned` provider?
   *
   * Named rather than inlined because it is the definition
   * `TaskProvisionedFact.repos` documents, and a second spelling of it would be
   * a second answer.
   */
  const taskIssueFreeRepo = (taskId: string, repo: string): boolean =>
    hookIssue.get(`${taskId}:${repo}`) === undefined;

  async function provision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    naming?: { settle: (task: TaskRecord) => Promise<TaskRecord> },
  ): Promise<void> {
    return whileBusy(task.id, 'provisioning', () => runProvision(task, images, naming));
  }

  async function runProvision(
    draft: TaskRecord,
    images?: readonly PastedImage[],
    naming?: { settle: (task: TaskRecord) => Promise<TaskRecord> },
  ): Promise<void> {
    taskIssue.delete(draft.id);

    /**
     * The refs read starts BEFORE the name is awaited, which is the whole reason
     * `provisionRepo` was split in two: reading a repo's refs does not need to
     * know the branch yet, so the model thinks *during* the network rather than
     * after it (probe 2: ~2.5s of fetch per repo against a 0.16s `worktree add`).
     *
     * **Every** repo is prefetched, not just the first. Master prefetched one and
     * said "by the time the loop reaches a second, the name settled long ago" —
     * true of a serial loop, and no longer true: the chains below run at once, so
     * a second repo's fetch would start at the same moment as the first's and pay
     * the full network wait after the name rather than during it.
     *
     * Each read is wrapped so it cannot reject while nobody is awaiting it.
     * `readRepoRefs` does not catch a transport rejection, and N eager promises
     * would be N chances at an unhandled rejection; the error is carried instead
     * and thrown at the site that can report it.
     */
    const prefetched = draft.repos.map((repo) =>
      readRepoRefs(api.proposed.process, repo).then(
        (refs) => ({ ok: true as const, refs }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );

    /**
     * Everything below works with the SETTLED record, and the shadowing is the
     * point: a task's name may change once, here, and no line after this may see
     * the provisional one — least of all a `worktree add`.
     *
     * The row says `naming…` for it rather than `provisioning…`, because this is
     * now a wait somebody sits through and a row that named the wrong thing would
     * be a row you press again.
     */
    const task =
      naming === undefined ? draft : await whileBusy(draft.id, 'naming', () => naming.settle(draft));
    const root = rootOf(task);

    /**
     * One chain per repo — `addWorktree`, then every `repoProvisioned` provider in
     * that repo's own worktree — and the chains run concurrently.
     *
     * A chain CATCHES ITS OWN failures and answers `undefined`, which is what
     * makes `Promise.all` safe here: a rejecting chain would otherwise abandon its
     * siblings part-way through `worktree add`, and a worktree git has registered
     * but whose directory is gone is the state nothing cleans up later.
     *
     * The results are read back BY INDEX, never by completion. `landed` feeds
     * `synthTaskRoot`, which namespaces skill collisions and writes the repo list
     * into the generated `CLAUDE.md` — ordered by whichever git finished first,
     * the task root would vary run to run and nothing on screen would say why.
     */
    const chains = task.repos.map(async (repo, index): Promise<LandedRepo | undefined> => {
      const key = `${task.id}:${repo.name}`;
      provisioning.set(key, 'working');
      hookIssue.delete(key);
      try {
        const read = await prefetched[index];
        if (read === undefined || !read.ok) throw read?.error ?? new Error('the refs read went missing');
        const outcome = await addWorktree(
          api.proposed.process,
          repo,
          task.slug,
          `${root}/${repo.name}`,
          read.refs,
        );
        if (!outcome.ok) {
          provisioning.set(key, 'failed');
          changed();
          ctx.log.warn(`task ${task.id}: ${repo.name} did not provision — ${outcome.reason}`);
          return undefined;
        }

        provisioning.set(key, 'ready');
        changed();

        /**
         * The seam, here and nowhere else: after the worktree exists, before the
         * root is written and long before a session opens in it. A provider's
         * whole job is to finish a checkout somebody is about to work in, so
         * this is awaited — and its failure is collected rather than raised,
         * because somebody else's extension must not be able to take a task
         * down.
         */
        const complaints: string[] = [];
        for (const provider of repoProvisioned.all()) {
          try {
            const done = await provider({
              repo: { path: repo.path, name: repo.name },
              worktree: outcome.worktree,
              branch: task.slug,
              task: { slug: task.slug, root },
            });
            if (!done.ok) complaints.push(done.message ?? 'reported a failure with no message');
          } catch (error) {
            // A throwing provider is a bug in the provider. It is not a reason
            // to lose a worktree that already exists.
            complaints.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (complaints.length > 0) {
          const message = complaints.join('\n');
          hookIssue.set(key, message);
          ctx.log.warn(`task ${task.id}: ${repo.name} provisioned, but — ${message}`);
          changed();
        }

        return { name: repo.name, path: repo.path, worktree: outcome.worktree };
      } catch (error) {
        // `provisionRepo` reaching git through a transport that rejects. Its
        // siblings are mid-flight; this chain ends and they do not.
        provisioning.set(key, 'failed');
        changed();
        ctx.log.warn(
          `task ${task.id}: ${repo.name} did not provision — ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });

    const landed = (await Promise.all(chains)).filter((entry): entry is LandedRepo => entry !== undefined);

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
     * The second seam: every worktree exists, the root is written, and nothing
     * has opened in any of it yet.
     *
     * After `materializeTaskRoot` rather than before, so the root is finished —
     * a provider can read the generated `CLAUDE.md`, and materialize's
     * stale-link `rmSync` cannot reach in behind it. Awaited for
     * `repoProvisioned`'s reason, one scope up: the orchestrator opens in these
     * directories moments later.
     */
    const ready = landed.filter((repo) => taskIssueFreeRepo(task.id, repo.name));
    const taskComplaints: string[] = [];
    for (const provider of taskProvisioned.all()) {
      try {
        const done = await provider({
          task: { slug: task.slug, root },
          branch: task.slug,
          repos: ready.map((repo) => ({ path: repo.path, name: repo.name, worktree: repo.worktree })),
        });
        if (!done.ok) taskComplaints.push(done.message ?? 'reported a failure with no message');
      } catch (error) {
        // Somebody else's extension must not be able to take a task down.
        taskComplaints.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskComplaints.length > 0) {
      const message = taskComplaints.join('\n');
      taskIssue.set(task.id, message);
      ctx.log.warn(`task ${task.id}: provisioned, but — ${message}`);
      changed();
    }

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
    commands.register(TASK_COMMANDS.machines, {
      // No title: the composer asks it, a person does not.
      schema: s.nothing(),
      /**
       * Where a new task could start.
       *
       * This Mac first and always — it is the one machine that is certainly
       * reachable — then every member of the net with an address. A member with no
       * address is in the net and cannot be dialled (a phone, or a Mac serving on
       * loopback), and offering it would be offering a choice that fails after the
       * brief has been typed.
       *
       * `here` rather than an empty id standing for this Mac: a caller comparing
       * against `''` is a caller that treats "not chosen" and "chosen this Mac" as
       * the same state, and those differ the moment a default changes.
       */
      handler: async () => {
        const members = await commands.invoke<Array<{ id: string; name: string; addrs?: string[] }>>(
          'remote.members',
          {},
        );
        const reachable =
          members.ok && Array.isArray(members.value)
            ? members.value.filter((member) => (member.addrs ?? []).length > 0)
            : [];
        return {
          machines: [
            { id: LOCAL_MACHINE, name: 'This Mac', here: true },
            ...reachable.map((member) => ({ id: member.id, name: member.name, here: false })),
          ],
        };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.create, {
      schema: s.object({
        title: s.string(),
        /**
         * WHICH machine this task belongs on.
         *
         * Absent, or `here`, is this Mac. Anything else is a member of the net,
         * and this verb then forwards ITSELF over there rather than creating a
         * local record about a task that lives elsewhere — a task's repos, its
         * worktrees and its agents are all on one machine, and a half-record here
         * would be a row that can never be provisioned.
         *
         * Forwarding rather than a second verb, because it is the same task
         * creation: the member runs `tasks.create` exactly as its own composer
         * would, and its own sidebar (and therefore this one, merged) shows the
         * result.
         */
        member: s.optional(s.string()),
        /**
         * Which model the task's agents open on. Absent means "whatever the
         * kind advertises" — the app does not get an opinion about a vendor's
         * default, and a hardcoded one goes stale the week they ship a tier.
         *
         * Stored on the record rather than passed straight through, because a
         * task outlives its first spawn: a second agent joining it later, and a
         * restored task reattaching, both have to open on the same model or the
         * task quietly becomes two different things.
         */
        model: s.optional(s.string()),
        /**
         * Where the work is laid down — `worktree` (the default, and the only
         * behaviour until now) or `in-place`.
         *
         * `worktree` cuts one per repo, which is what makes several agents on
         * one repo safe. `in-place` runs in the checkout itself, which is right
         * for a task you want landing on the branch you are already on and
         * wrong the moment a second task picks the same repo — hence not the
         * default.
         */
        placement: s.optional(s.string()),
        brief: s.optional(s.string()),
        /**
         * A name the caller already has — the composer's speculative ask, landed
         * before Create was pressed. Absent is perfectly normal: the heuristic
         * then names the task and the race in `settleName` may improve it.
         */
        name: s.optional(s.string()),
        repos: s.optional(s.array(repoArg)),
        /**
         * Images pasted into the brief, base64, in the order their `[Image #N]`
         * tokens appear. They cross the port as data because the page is where
         * a clipboard exists and this side is where a filesystem does.
         */
        images: s.optional(s.array(s.object({ mediaType: s.string(), data: s.string() }))),
      }),
      handler: async (args) => {
        const elsewhere = await forwardToMember(TASK_COMMANDS.create, args);
        if (elsewhere !== undefined) return elsewhere;
        // The slug is resolved ONCE against what is taken and then stored (D8).
        // Re-deriving it later would let two tasks titled the same resolve to one
        // folder and quietly share a worktree.
        // Derived ONCE and then stored (D8). What it is derived FROM is, in order:
        // a name the caller already has, a filler-stripped heuristic, and finally
        // the raw title — which is the paragraph that produced
        // `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`.
        const named = args.name === undefined ? undefined : readName(args.name);
        const slug = uniqueSlug(
          slugify(named ?? heuristicName(args.brief ?? '') ?? args.title),
          store.takenSlugs(),
        );
        /**
         * The ROW LABEL gets the heuristic too — read off the proposed TITLE,
         * not off the brief.
         *
         * It used to reach only the slug, so a create with no `name` — the model
         * off, signed out, or simply slower than the composer's speculative ask
         * — got a sane branch and a row label that was the whole opening of the
         * brief. That is how the rail filled with
         * `can you handle this please: https://brow…`, twice, byte-identical:
         * the composer's `titleOf` is the brief's first line capped at 72, so
         * the ellipsis was the title's own and two links to the same host made
         * one unreadable row repeated. §6 says a label is 1–3 words and §5 says
         * a task is named once, in the rail; a label that is the paragraph fails
         * the only job the rail has.
         *
         * **The title rather than the brief**, because the heuristic is a
         * cleanup of a proposed NAME and the two callers propose different
         * things. It leaves a real one alone — `--title 'Fix login'` is already
         * three words with no filler and comes back unchanged — while stripping
         * the opening, the link and the truncation mark off one that is a slice
         * of a brief. Reading the brief instead would overwrite the name a CLI
         * caller typed with a guess about the paragraph underneath it. The slug
         * keeps reading the brief: it has always read it, it is tested against
         * it, and a branch name wants the fuller source.
         *
         * `settleName` may still improve on this; it is what the row says in the
         * meantime, and for good when the ask comes back empty.
         */
        const title = named ?? heuristicName(args.title) ?? args.title;
        const task: TaskRecord = {
          schemaVersion: 1,
          id: nextId(),
          slug,
          // One call answers both the branch and the row label (D18) — and when
          // it does not answer at all, the heuristic still answers both.
          title,
          brief: args.brief ?? '',
          lifecycle: 'draft',
          // Absent stays absent, so the vendor's default keeps deciding.
          ...(args.model === undefined ? {} : { model: args.model }),
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
        // The naming hook is passed HERE and nowhere else. `restore` provisions
        // too, and a task with a history must never have its directory renamed
        // under it — the window in which a slug may change closed the first time
        // git ran for it.
        void provision(task, args.images, named === undefined ? { settle: settleName } : undefined).catch((error: unknown) => {
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
          displayState: displayState(task.lifecycle, agentStatesOf(task)),
          root: rootOf(task),
          /** A task-level provisioning complaint — `repos[].hookIssue` one scope up. */
          hookIssue: taskIssue.get(task.id),
          repos: task.repos.map((repo) => ({
            ...repo,
            provisioning: provisioning.get(`${task.id}:${repo.name}`) ?? 'ready',
            hookIssue: hookIssue.get(`${task.id}:${repo.name}`),
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
    commands.register(TASK_COMMANDS.presentation, {
      // No title: not a palette verb. Its whole effect is a return value.
      schema: s.object({
        task: s.string(),
        /** Which TAB of it. Absent = whichever session of the task is live. */
        root: s.optional(s.string()),
      }),
      /**
       * What this task can be SHOWN as — and **nothing else happens.**
       *
       * `reveal` next door opens a root and switches this window to it, which is
       * right for the machine the task lives on and wrong for every other client
       * of this core. Another member of the net draws this task's row in its own
       * sidebar and wants to become a SECOND VIEWER of the session; running
       * `reveal` for it would move a window on this Mac and put nothing on
       * theirs. So the row declares this verb too (`TreeItem.presents`) and a
       * client with its own surface asks it instead.
       *
       * No `layout.openRoot`, no switch, no restore. An archived task has nothing
       * live to watch and bringing it back is a decision, not a side effect of
       * somebody looking at a list.
       *
       * **Liveness is checked here, not remembered.** A task's record outlives
       * the ptys it names — the daemon restarts, a session exits — so a stored
       * session id is a CLAIM (ADR 0036). `reveal` learned this the expensive
       * way: presenting a dead one told a phone to open a terminal that could
       * never paint, and nothing reported a fault because nothing had failed.
       * That is also why this is a verb rather than a field on the row: a row is
       * drawn once and clicked later.
       *
       * Answers `{}` when there is nothing running. A caller then says so, which
       * is the truth rather than an empty terminal pretending otherwise.
       */
      handler: async (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);

        const alive = await commands.invoke<Array<{ id: string }>>('sessions.list', {});
        const running = new Set(
          alive.ok && Array.isArray(alive.value) ? alive.value.map((session) => session.id) : [],
        );
        /*
         * Scoped to the TAB when the row named one, so tapping a task's second
         * tab on a phone attaches to that tab's agent rather than to whichever
         * session of the task happens to be listed first.
         *
         * Liveness is still checked HERE and never remembered: a row is drawn
         * once and clicked later, and presenting a recorded id without checking
         * it is the scar this verb already carries.
         */
        const inTab =
          args.root === undefined
            ? task.sessions
            : task.sessions.filter((session) => (session.root ?? taskRootId(task.id)) === args.root);
        const live = inTab.find((session) => running.has(session.id));
        if (live === undefined) {
          ctx.log.info(`task ${task.id}: nothing running to present`);
          return {};
        }
        return {
          present: { kind: 'session', sessionId: sessionId(live.id) } satisfies PresentEffect,
        };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.reveal, {
      title: 'Tasks: Reveal',
      schema: s.object({
        task: s.string(),
        /**
         * WHICH tab of it — the row that was clicked.
         *
         * Absent means the task's anchor, which is what the task's own row
         * sends and what every caller before tabs sent. It is only ever a tab of
         * THIS task: a root from somewhere else would move the window out of the
         * task the caller named, so it is checked against the group rather than
         * trusted.
         */
        root: s.optional(s.string()),
      }),
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

        /*
         * The tab named by the row, when it is one of this task's — otherwise
         * the anchor. Naming a foreign root here would move the window out of
         * the task the caller asked for, which is a worse failure than ignoring
         * an argument.
         */
        const target =
          args.root !== undefined && (args.root === root || args.root.startsWith(`${root}/`))
            ? args.root
            : root;
        const switched = await commands.invoke('layout.switchRoot', { root: target });
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
         * is ADR 0036's rule arriving at a second door: a stored session id is a
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
         * record, which is ADR 0036's rule at a second door: a stored session id
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
        /*
         * The tabs, and what was on each of their screens.
         *
         * BEFORE `closeTaskRoot`, which is what kills the ptys — and a mirror
         * dies with its session. Capturing afterwards would archive N empty
         * screens and report no fault, because nothing would have failed.
         *
         * AFTER the worktree snapshots, so a conflicted repo that refuses above
         * does not leave a directory of `.term` files behind for a task that is
         * still live.
         */
        const tabs = await captureTabs(task);
        task = { ...task, ...(tabs.length === 0 ? {} : { tabs }) };
        store.put(task);

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

          /*
           * A task archived WITH its tabs comes back as those tabs — and comes
           * back QUIET.
           *
           * `rebuildTabs` paints each pane's screen and leaves its agent's
           * resume line at the prompt, unsubmitted. The loop below is the older
           * path, for a record written before tabs existed: it opens one pane
           * per session and runs the line.
           */
          if ((restored?.tabs ?? []).length > 0) {
            await rebuildTabs(restored as TaskRecord);
            changed();
            return { task: task.id, restored: true };
          }

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

  /**
   * Which tasks are showing ALL of their tabs.
   *
   * In memory and never stored, like `provisioning` beside it: it is a property
   * of a list somebody is looking at right now, and after a restart there is
   * nothing expanded because nobody has expanded anything.
   */
  const tabsExpanded = new Set<string>();

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.expandTabs, {
      // No title: a row's own verb, not something to run from the palette — it
      // means nothing without a task to name.
      schema: s.object({ task: s.string() }),
      handler: (args) => {
        if (tabsExpanded.has(args.task)) tabsExpanded.delete(args.task);
        else tabsExpanded.add(args.task);
        changed();
        return { expanded: tabsExpanded.has(args.task) };
      },
    }),
  );
  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.reportSuite, {
      title: 'Tasks: Report a suite result',
      schema: s.object({ task: s.string(), total: s.int(), passed: s.int() }),
      handler: (args) => {
        const task = store.get(args.task);
        // A result for a task that does not exist is a caller's mistake worth
        // hearing about, not a silently-kept number keyed on nothing.
        if (task === undefined) return { ok: false, reason: 'no such task' };

        // Clamped rather than refused: `4 of 3 passed` is a caller bug, and
        // drawing four full cells is a better answer than drawing none.
        const total = Math.max(0, Math.trunc(args.total));
        const passed = Math.min(Math.max(0, Math.trunc(args.passed)), total);
        if (total === 0) suites.delete(args.task);
        else suites.set(args.task, { total, passed });
        changed();
        return { ok: true, total, passed };
      },
    }),
  );
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

        /*
         * And the archived SCREENS, which live outside the task root on purpose
         * — the task root is what was just deleted.
         *
         * Without this they outlive every record that names them: nothing left
         * in the app could ever mention those files again, and `.archives` would
         * grow by a task's worth of scrollback every time one expired.
         */
        rmSync(`${archiveDir()}/${task.id.replace(/[^A-Za-z0-9_-]/g, '_')}`, {
          recursive: true,
          force: true,
        });

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
      // A form you open, fill in and dismiss — v1's composer, declared rather
      // than hardcoded into the shell. In the dock it would sit there taking a
      // third of the sidebar forever.
      surface: 'overlay',
      /*
       * ⌘N, and ⌘T is the shell's New Tab.
       *
       * The conventional pair, and the one users already have in their fingers:
       * ⌘N makes a new THING, ⌘T makes a new tab of the thing you are in. The
       * composer held ⌘T while a task was a single pane group and there were no
       * tabs to make; now there are, and a task's tabs are the gesture you reach
       * for far more often.
       */
      key: 'CmdOrCtrl+N',
      title: 'New task',
    }),
  );

  ctx.subscriptions.push(
    views.registerViewType(TASK_VIEWS.tree, {
      kind: 'tree',
      title: 'Tasks',
      data: {
        children: (parent) => {
          /*
           * A task's children are its TABS.
           *
           * They used to be its repos, saying `ready` / `provisioning…`. That is
           * now on the task row's own description — one sublist with one
           * meaning, rather than two kinds of child row you have to tell apart
           * by reading them.
           */
          if (parent !== undefined) {
            const task = store.get(parent);
            if (task === undefined) return Promise.resolve([]);
            const tabs = (tabsByGroup.get(taskRootId(task.id)) ?? []).map((tab) => ({
              root: tab.root,
              label: tab.label,
              // Each tab's OWN state: the rollup over the sessions in THAT root.
              // The task row keeps the rollup over all of them, so a task whose
              // tabs are hidden says exactly what it said before tabs existed.
              state: rollUp(agentStatesOfTab(task, tab.root)),
            }));

            return Promise.resolve(
              capTabRows(tabs, tabsExpanded.has(task.id)).map((row): TreeItemOut => {
                if ('kind' in row) {
                  return {
                    id: `${task.id}:${row.kind}`,
                    label: row.kind === 'more' ? `… +${row.count}` : '… less',
                    // Clickable, deliberately: a row reading "… +3" that did
                    // nothing when pressed is what `section` exists to avoid.
                    command: { id: TASK_COMMANDS.expandTabs, args: { task: task.id } },
                  };
                }
                return {
                  id: `tab:${row.root}`,
                  label: row.label,
                  tint: tintFor(row.state),
                  // WHICH root this row is — the identity the shell derives its
                  // highlight from, exactly as the task row does.
                  root: row.root,
                  command: { id: TASK_COMMANDS.reveal, args: { task: task.id, root: row.root } },
                  /*
                   * And the read-only way to ask the same question, for a client
                   * whose surface is somewhere else. Another member of the net
                   * draws this row too, and `reveal` would move THIS machine's
                   * window while putting nothing on theirs.
                   */
                  presents: {
                    id: TASK_COMMANDS.presentation,
                    args: { task: task.id, root: row.root },
                  },
                };
              }),
            );
          }

          /**
           * What the card is handed — every field optional, and absent whenever
           * we do not actually know.
           *
           * A card that omits a fact is honest; one that invents a zero is not.
           * The diff is whatever the last read put in `diffs`, which is nothing
           * at all until the first refresh lands — so a freshly-opened app draws
           * cards with no diff line for a beat rather than a row of `+0 −0`.
           */
          const cardFor = (task: TaskRecord, state: string): unknown => ({
            mark: markOf(state),
            elapsed: formatElapsed(task.createdAt, ctx.clock.now()),
            diff: diffs.get(task.id),
            suite: suites.get(task.id),
            repos: task.repos.map((repo, index) => ({
              name: repo.name,
              /*
               * A ROLE name, and the assignment is by POSITION within the task
               * rather than by a hash of the path.
               *
               * A hash would be stable across tasks, which sounds better and is
               * worse: two repos in one task could collide onto one mark, and
               * the mark's only job is telling THIS task's repos apart. Position
               * cannot collide, and §2 gives exactly four.
               */
              mark: `repo${(index % 4) + 1}`,
            })),
          });

          // The surface that wants the numbers pays for them — see `refreshDiffs`.
          refreshDiffs();

          const all = [...store.list()].sort((a, b) => b.createdAt - a.createdAt);
          if (all.length === 0) {
            // The empty state is the SHELL's, not a fake row: a list saying
            // "no tasks yet" in the shape of a task is a row you can click.
            return Promise.resolve([]);
          }

          /**
           * **Attention routing is the rail's SHAPE** (§5) — sections ordered by
           * what you must do.
           *
           * A state-grouping was removed from here once, on the argument that it
           * "sorted live tasks into buckets they have no relationship through".
           * That argument was about *categorising*; this is about ORDER. The
           * sections are not kinds of task, they are distances from needing you,
           * and they are read top-down: the thing that is blocked on you is
           * first because it is the only thing you can act on, and everything
           * below it is progressively less your problem.
           *
           * The bucket names are the design's and are not negotiable per-state:
           * a fifth section is a fifth thing to scan, and the whole claim is
           * that a glance is enough.
           */
          const live = all.filter((task) => task.lifecycle !== 'archived');
          const done = all.filter((task) => task.lifecycle === 'archived');
          const stateOf = (task: TaskRecord): string =>
            displayState(task.lifecycle, agentStatesOf(task));
          const waiting = live.filter((task) => markOf(stateOf(task)) === 'waiting');
          const inFlight = live.filter((task) => markOf(stateOf(task)) === 'working');
          /*
           * **Failed sits in `Resting`**, not in a section of its own.
           *
           * A run that failed is not doing anything — which is what `Resting`
           * means — and its `red` square already says the rest. A `Failed`
           * heading would split "nothing is happening here" across two places
           * to look, for a state whose whole signal is one mark.
           */
          const resting = live.filter((task) => {
            const mark = markOf(stateOf(task));
            return mark !== 'waiting' && mark !== 'working';
          });

          /**
           * A heading, drawn only when it has something under it.
           *
           * An empty section is a heading that says "nothing is waiting on you"
           * in the shape of a thing you might have to read — and the count would
           * be `0`, which is the one number a count never needs to show.
           */
          const section = (id: string, label: string, of: readonly TaskRecord[], loud = false): void => {
            if (of.length === 0) return;
            rows.push({
              id: `group:${id}`,
              label,
              description: String(of.length),
              section: true,
              // Only the first section's label is at full strength: it is the one
              // you are meant to read, and the rest are structure.
              tint: loud ? 'wool' : undefined,
            });
            for (const task of of) rows.push(rowFor(task));
          };

          const rows: TreeItemOut[] = [];
          const rowFor = (task: TaskRecord): TreeItemOut => {
            const state = displayState(task.lifecycle, agentStatesOf(task));
            // Said on the row rather than in a log nobody has open — and
            // APPENDED, because the task really is in the state the tint shows.
            const issue = taskIssue.get(task.id);
            /*
             * What the repo rows used to say, said HERE.
             *
             * The children are the task's tabs now, so a repo has no row of its
             * own — and `provisioning api…` is exactly the kind of thing this
             * field already carries: appended, because the task really is in the
             * state the tint shows while a repo is still landing. Reported for
             * the first repo that is not ready rather than for all of them: the
             * row is one line, and "something is still arriving" is the whole of
             * what it can usefully say.
             */
            const pending = task.repos.find((repo) => {
              const key = `${task.id}:${repo.name}`;
              return provisioning.get(key) !== undefined || hookIssue.get(key) !== undefined;
            });
            const repoNote =
              pending === undefined
                ? undefined
                : hookIssue.get(`${task.id}:${pending.name}`) !== undefined
                  ? `${pending.name} — hook failed`
                  : `${provisioning.get(`${task.id}:${pending.name}`) ?? 'provisioning'} ${pending.name}…`;
            return {
              id: task.id,
              label: task.title,
              description: [
                issue === undefined ? state : `${state} — set hook failed`,
                ...(repoNote === undefined ? [] : [repoNote]),
              ].join(' · '),
              // The word the shell resolves. `isTaskAgentState` rather than a
              // cast: `displayState` still returns the lifecycle union too, and
              // the branch above has only excluded `archived` — the type cannot
              // see that `review`/`done`/`draft` are written by nothing.
              tint: isTaskAgentState(state) ? tintFor(state) : state,
              /*
               * WHICH root this row is — an identity, written unconditionally.
               *
               * Including while archived: the task has no live root then, but
               * clicking it restores one at this same id (`tasks.reveal`), so
               * withholding it would blank the highlight for exactly the moments
               * after the window has just moved there.
               */
              root: taskRootId(task.id),
              collapsed: true,
              /*
               * The row draws itself as a CARD (ADR 0033's seam, one level
               * down). `label`, `tint` and `command` above stay honest and stay
               * required-shaped: they are what a remote member draws in its own
               * sidebar, what the row is announced as, and what happens when it
               * is clicked — and none of those may depend on a renderer this
               * client might not be. A build with no `tasks.card` draws the
               * ordinary row and loses nothing but the richer form.
               */
              component: 'tasks.card',
              data: cardFor(task, state),
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
               * And the read-only way to ask the same question, for a client whose
               * surface is somewhere else.
               *
               * Another member of the net draws this row too, and `reveal` would
               * move THIS machine's window while putting nothing on theirs. This
               * verb answers what the task can be shown as and does nothing, so
               * they attach to the session and this Mac is untouched. Declared
               * here beside `command` because the shell cannot know either verb —
               * the same rule `actions` keeps (ADR 0031).
               */
              presents: { id: TASK_COMMANDS.presentation, args: { task: task.id } },
              /*
               * The ONE verb worth a button: finishing with a task is the
               * gesture you make most, and it was two clicks into a context
               * menu nobody discovers by looking.
               *
               * Nothing on an archived task — the verb that is available is the
               * one that changes its state, which is the rule `actions` below
               * already follows. Offering "Mark done" on something already done
               * is an item that either fails or does nothing.
               */
              ...(task.lifecycle === 'archived'
                ? {}
                : {
                    primaryAction: {
                      id: TASK_COMMANDS.archive,
                      label: 'Mark done',
                      icon: 'check',
                      args: { task: task.id },
                    },
                  }),
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

          section('waiting', 'Waiting on you', waiting, true);
          section('flight', 'In flight', inFlight);
          section('resting', 'Resting', resting);

          /*
           * **Shipped is ONE ROW pinned to the foot, not a section.**
           *
           * §1: "a Shipped this week footer row pinned to the bottom with
           * `margin-top: auto`". Finished work LEAVES the list and becomes a
           * count — drawing it as a heading with fourteen task rows under it
           * puts the work you are done with back in the list you are reading,
           * which is the one thing closing a task was supposed to stop.
           *
           * The count is the content, so the row is drawn even at zero: a rail
           * whose foot appears and disappears as the week turns over is a rail
           * that moves under the cursor for no reason the reader can see.
           */
          const shippedOpen = tabsExpanded.has(SHIPPED_KEY);
          rows.push({
            id: SHIPPED_KEY,
            label: 'Shipped this week',
            description: String(done.length),
            tint: 'done',
            /*
             * The one row that asks to sit at the physical bottom — and it has to
             * ASK. The dock used to pin everything after the last heading, and
             * this row is not one, so `Resting` was the last heading and the live
             * resting tasks were what got nailed to the foot: `In flight` above a
             * gap, `Resting` at the bottom of the window, which is the reverse of
             * the order §5 reads top-down.
             */
            foot: true,
            /*
             * Collapsed by default and EXPANDABLE, which is the half a count
             * alone would lose: finished work leaving the list must not mean
             * finished work becoming unreachable. Clicking the foot opens it,
             * and clicking it again closes it — the chevron in the drawing is
             * this.
             */
            collapsed: !shippedOpen,
            command: { id: TASK_COMMANDS.expandTabs, args: { task: SHIPPED_KEY } },
          });
          if (shippedOpen) for (const task of done) rows.push(rowFor(task));

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
  /*
   * A beat under the demand-driven read, so a rail left open still tracks work
   * an agent is doing while nobody is clicking.
   *
   * 20s rather than something tighter: a diff moves when a human or an agent
   * writes a file, and neither does it four times a second. v1's nudge watcher
   * shipped without a ceiling and spent a third of a core at idle — the lesson
   * there was that a debounce only cancels PENDING work, so the bound has to be
   * on the rate itself.
   */
  const diffTimer = setInterval(refreshDiffs, 20_000);
  ctx.subscriptions.push(toDisposable(() => clearInterval(diffTimer)));

  ctx.log.info(`ready — ${store.list().length} task(s), data in ${ctx.dataDir}`);
  return { list: () => store.list(), get: (id) => store.get(id) };
}

/**
 * A task's displayed state → the mark the card draws.
 *
 * The same translation `view-dock` does for `tint`, and it is duplicated on
 * purpose rather than shared: that one maps the whole vocabulary of every
 * extension, and this one maps the words THIS extension writes. A shared table
 * would make either side's new word a change to the other's file.
 */
function markOf(state: string): string {
  switch (state) {
    case 'working':
    case 'running':
      return 'working';
    case 'blocked':
    case 'needs-you':
    case 'needsCheck':
    case 'needs-check':
      return 'waiting';
    case 'error':
    case 'failed':
      return 'failed';
    /*
     * `archived` is what `displayState` returns for finished work — `done` is a
     * lifecycle value nothing writes. Without it the card drew a resting ring on
     * every task in the Shipped drawer, which is the one place a check is the
     * whole point: §3 gives shipped its own mark precisely because the row has
     * left the live list and the mark is all that says why.
     */
    case 'archived':
    case 'done':
      return 'shipped';
    default:
      return 'resting';
  }
}

/** Which task owns a session, or none. The scoping predicate, in one place. */
function taskOfSession(store: TaskStore, sessionId: string): TaskRecord | undefined {
  return store.list().find((task) => task.sessions.some((session) => session.id === sessionId));
}
