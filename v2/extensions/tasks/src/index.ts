import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  CARD_FACTS_CHANGED_TOPIC,
  CARD_FACTS_POINT,
  PASTED_LINK_POINT,
  REPO_PROVISIONED_POINT,
  REPO_SUGGESTIONS_POINT,
  TASK_COMMANDS,
  TASK_PROVISIONED_POINT,
  TASK_VIEWS,
  TRANSCRIPT_SEARCH_POINT,
  type CardFact,
  type CardFactProvider,
  type PastedLinkPattern,
  type PastedLinkProvider,
  type RepoProvisioned,
  type TaskProvisioned,
  type TranscriptHit,
  type TranscriptSearchProvider,
} from './manifest.ts';
import { TaskStore, type RepoArchive, type RepoRef, type TaskRecord, type TaskSession } from './store.ts';
import { uniqueSlug } from './model/slug.ts';
import { branchTaken, mintName, pickBranch } from './model/mint.ts';
import { firstLine, namingPrompt, readName, stillTheSameBrief } from './model/naming.ts';
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
 * What a shelved task's tab says about itself, over the screens it is showing.
 *
 * Named here rather than written at the call site so the two places that open a
 * snapshot — a tab with a shape, and a task with no tabs at all — cannot say it
 * two different ways.
 */
const ARCHIVED_LINE = 'Archived — this is what was on screen when the task was shelved.';
/**
 * Asked of `agents-core`, never of a vendor: a task that named `claudeCode.*`
 * would be a task that knows which agent it hired (D11).
 */
const AGENTS_RESUME_TARGET = 'agents.resumeTarget';
const AGENTS_LAST_SAID = 'agents.lastSaid';

/**
 * The floor of the second line — what it says when the task has said nothing.
 *
 * **A word, beside a mark that means the same thing**, which is the one place
 * §6's no-duplication rule is knowingly bent. Three things pay for it:
 *
 *   - the line is UNCONDITIONAL, so the alternative is not a shorter row, it is
 *     a reserved empty strip under every quiet title — and reserved emptiness
 *     reads as a rendering fault, which is the shape this already shipped as
 *     once and was pulled for;
 *   - it is what makes the duration beside it mean anything. `6m` alone names no
 *     subject; `idle · 6m` is a sentence, and the sentence is the whole job of
 *     the line;
 *   - the mark is a colour and a shape. This is its accessible name, drawn — so
 *     a rail read by somebody who cannot separate the hues says the same thing
 *     as one read by somebody who can.
 *
 * It is the FLOOR, never a competitor: anything the task actually said wins, and
 * on a working task the brief wins. A row reaches this only when there is
 * nothing truer to put there.
 */
const STATE_WORDS: Readonly<Record<string, string>> = {
  blocked: 'waiting on you',
  error: 'failed',
  needsCheck: 'ready to read',
  working: 'working',
  idle: 'idle',
  archived: 'shipped',
};

const STATE_WORD_OF = (state: string): { summary?: string } => {
  const word = STATE_WORDS[state];
  return word === undefined ? {} : { summary: word };
};
const AGENTS_RESUME_COMMAND = 'agents.resumeCommand';
import { formatElapsed } from './model/elapsed.ts';
import { displayState } from './model/lifecycle.ts';
import { isTaskAgentState, rollUp, tintFor } from './model/agent-rollup.ts';
import { fuzzyFilter } from '@shepherd/sdk';
import { SHIPPED_CAP, activeOrder, capShipped, shippedOrder } from './model/order.ts';
import { hitsByTask, totalMatches } from './model/transcript-rollup.ts';
import { groupByDay } from './model/shipped-days.ts';
import { capTabRows } from './model/tab-rows.ts';
import {
  archiveTabsFrom,
  historyPath,
  liveTreeFor,
  snapshotTreeFor,
  type SessionReading,
  type ArchivedTab,
  type RootReading,
} from './model/archive-tabs.ts';
import { synthTaskRoot } from './model/root-synth.ts';
import { planLaunch } from './model/launch.ts';
import { writePastedImages, type PastedImage } from './images.ts';

import {
  archiveWorktree,
  deleteBranch,
  materializeTaskRoot,
  addWorktree,
  readRepoRefs,
  readContribution,
  removeWorktree,
  restoreWorktree,
} from './provision.ts';
import { seedClaudeTrust } from './trust.ts';
import {
  claudeCredentials,
  incognitoCommand,
  incognitoProfileDir,
  orphanProfiles,
  removeIncognitoProfile,
  seedIncognitoProfile,
} from './incognito.ts';

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

/**
 * How long a pasted link gets to say what it is.
 *
 * Long enough for a cold CLI spawn, short enough that nobody is waiting on it —
 * the pill is already drawn with its fallback label by the time this starts, so
 * running out is one more way of answering "nothing", not a failure.
 */
const RESOLVE_LINK_DEADLINE_MS = 4_000;

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
  /** A heading inside the heading above it — drawn a step quieter, with no rule. */
  subsection?: boolean;
  /** This row sits at the physical foot of the list, and so does what follows it. */
  foot?: boolean;
  /** This row operates on the list rather than belonging to it — drawn as chrome. */
  quiet?: boolean;
  /** This row's region has no state column — no leading slot, not an empty one. */
  gutter?: boolean;
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
   * The one verb worth a button on the row itself, revealed on hover.
   *
   * Declared rather than left to a spread, which is how it went unchecked
   * before: `...(cond ? {} : { primaryAction })` is a spread, and TypeScript
   * does not excess-property-check those — so the field could carry anything,
   * including the `icon: 'check'` that named no glyph in the allow-list and drew
   * three dots on every task row for the life of the feature.
   */
  primaryAction?: TreeActionOut;
  /**
   * The row's context menu. Structural, like everything else here — the SDK's
   * `TreeItemAction` is the contract and this is the shape that satisfies it,
   * so the extension keeps compiling against types it does not import.
   */
  actions?: readonly (TreeActionOut | { separator: true })[];
}

interface TreeActionOut {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  shortcut?: string;
  args?: unknown;
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
 *
 * **The four provisioning words are STEPS, and that is the point.** Creating a
 * task is the longest wait in the app — a model naming it, then probe 2's ~2.5s
 * of network per repo, then a root to write and an agent to boot — and a single
 * `provisioning…` held across all of it says only "still going" for twenty
 * seconds. The handoff spec's own rule for a wait that long is a stage label
 * (§8: under 100ms nothing, to 1s disable, to 3s a spinner, beyond that a
 * label), so each phase names itself and the row moves while the work does.
 *
 * `provisioning` survives as the FLOOR rather than as a phase: `whileBusy` nests,
 * so it is what a row falls back to in the gaps between phases and what it says
 * during the prefetch that precedes the first one. Without it the row would blink
 * to idle four times on the way through.
 *
 * `worktrees` is the one noun in a list of verbs, and deliberately: the verb for
 * that phase is "adding", which names the git subcommand and tells a reader
 * nothing. The other three are what they say.
 */
type BusyWhat =
  | 'archiving'
  | 'restoring'
  | 'provisioning'
  | 'naming'
  | 'worktrees'
  | 'linking'
  | 'starting';

/**
 * What the row is DOING while it is being built — beside its name, never instead
 * of it.
 *
 * The step used to BE the label. It had to be: a task had no name until the
 * model answered, so the only other thing to draw was a slice of the brief that
 * read like a name somebody typed badly. A task is called something from the
 * moment it exists now — its own brief, then the model's name — so the step
 * moved one cell right and the row stopped taking turns with itself.
 *
 * Sentence case and three words at most, because this is a label and §6 governs
 * it now — the trailing chip this replaces was metadata and had looser rules.
 *
 * `archiving` and `restoring` get one too. They were left out on the argument
 * that their task has a settled name and the name is what says WHICH one is
 * going away — true, and beside the point: the card draws `label` and `data`,
 * and nothing else. The word went into `description`, which the card has never
 * read, so an archiving task said precisely nothing. That is the same defect
 * this whole change started as, re-committed one field along. You are looking at
 * the row you just clicked, so which task it is was never the open question.
 */
function stepLabel(what: BusyWhat, task: TaskRecord): string | undefined {
  switch (what) {
    case 'archiving':
      return 'Archiving';
    case 'restoring':
      return 'Restoring';
    case 'naming':
      return 'Naming the task';
    case 'worktrees':
      // A one-repo task is the common case, and `Creating worktrees` over a
      // single worktree is the kind of plural that reads as a stock string.
      return task.repos.length === 1 ? 'Creating the worktree' : 'Creating worktrees';
    case 'linking':
      return 'Linking agent files';
    case 'starting':
      return 'Starting the agent';
    case 'provisioning':
      /*
       * The floor, and it needs a phrase for the same reason it exists: it is
       * what a row falls back to in the gaps BETWEEN phases, so leaving it to
       * the title would flash the junk name four times on the way through.
       */
      return 'Setting up';
    default:
      return undefined;
  }
}

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
    pushPlaceholder(taskId);
    try {
      return await run();
    } finally {
      // `finally`, so a refusal — the conflicted-worktree case the archive verb
      // exists to have — leaves a row that is idle and wrong-looking rather than
      // one that spins forever.
      if (displaced === undefined) busy.delete(taskId);
      else busy.set(taskId, displaced);
      changed();
      pushPlaceholder(taskId);
    }
  }

  /**
   * The phases that BUILD a task, as opposed to moving one that already exists.
   *
   * Only these may change a row's mark, and therefore which section it sits in.
   * Archiving and restoring are the counter-example that made this a named set:
   * they are busy, but the task is established work with its own real state, and
   * upgrading it to `working` files it under **In flight** — so archiving a task
   * made its row jump into the live-work section on its way out of the list, and
   * jump under the cursor of the person who just clicked it.
   */
  const BUILDING_PHASES: ReadonlySet<BusyWhat> = new Set<BusyWhat>([
    'provisioning',
    'naming',
    'worktrees',
    'linking',
    'starting',
  ]);

  /**
   * The mark a task's row wears — its agents' rollup, or `working` when Shepherd
   * itself is the one BUILDING it.
   *
   * A task being provisioned has lifecycle `draft` and no sessions, so the rollup
   * answers `idle` and `markOf` draws the hollow resting ring — "nothing is
   * happening here" — for the whole of the longest wait in the app. That is the
   * empty row this exists to stop: the handoff spec's first question is whether a
   * state already has a mark, and this one does. Shepherd cutting worktrees for
   * you IS working, and `working` is the three-bar meter that says so.
   *
   * **Two guards, and both are load-bearing.** It only ever upgrades `resting`,
   * so busy never overrides a mark an agent actually reported — archiving a task
   * whose agent is blocked keeps the waiting square, because that square is the
   * user's move and a spinner over it would hide the one thing in the rail they
   * can act on. And it only fires for a BUILDING phase, so a task being archived
   * or restored keeps its own mark and its own section instead of jumping into
   * **In flight** on its way out of the list.
   *
   * Used by the SECTION partition as well as by the card, and that is the whole
   * reason it is a named function: the two answering differently would file a
   * spinning row under `Resting`.
   */
  const markFor = (task: TaskRecord, state: string): string => {
    const mark = markOf(state);
    const what = busy.get(task.id);
    return mark === 'resting' && what !== undefined && BUILDING_PHASES.has(what) ? 'working' : mark;
  };

  /**
   * What the STAGE says while a task is being built — the rail's step, one
   * surface along.
   *
   * `stepLabel` again rather than a second vocabulary: the row and the stage are
   * answering the same question ("what is happening to this task"), and two sets
   * of words for it would drift the first time one of them was edited. §5's rule
   * that a fact is drawn in one place is about the fact, not the pixels.
   *
   * `undefined` for anything that is not a BUILDING phase, which is the same
   * carve-out `markFor` makes and for the same reason: archiving and restoring
   * happen to a task that already has panes, so there is no empty stage to
   * explain and a line here would be written for a surface nobody is looking at.
   *
   * **The repos, and NOT the branch.** The branch is the slug, and the slug is
   * derived from the brief — so on screen it reads as the user's own prompt run
   * through a slugifier (`show-pending-state-for-initializing-tasks`), which is
   * their words handed back to them worse. The repos are the useful half: they
   * are what is being cut, they are what the wait is FOR, and unlike the slug
   * they are fixed from the moment the task is created — so there is no phase
   * they cannot be shown in.
   */
  const placeholderFor = (task: TaskRecord): { line: string; names?: readonly string[] } | undefined => {
    const what = busy.get(task.id);
    if (what === undefined || !BUILDING_PHASES.has(what)) return undefined;
    const line = stepLabel(what, task);
    if (line === undefined) return undefined;
    const names = task.repos.map((repo) => repo.name);
    return names.length === 0 ? { line } : { line, names };
  };

  /**
   * Tell the task's root what to say, if it has one.
   *
   * Fire-and-forget, and quiet by construction rather than by a swallowed error:
   * most of a task's provisioning happens before anyone clicks its row, so the
   * root usually does not exist — which `layout.setPlaceholder` answers as
   * `placed: false` rather than a refusal, precisely so this call does not log a
   * failure per step for work that is going fine. Nothing depends on it landing;
   * it is what an empty stage draws, and an empty stage nobody opened draws
   * nothing.
   */
  /**
   * The line for a task that STOPPED being built without ever starting.
   *
   * `whileBusy` clears in a `finally`, so a provisioning that threw ends with no
   * phase and no agent — and the root somebody opened is still empty. Left to
   * fall through, the stage would draw the shell's own quiet state: `The flock is
   * quiet` over a task that exists, offering to start another one. That is the
   * same class of wrong as the shell this whole change removes — a surface
   * describing something other than what you are looking at.
   *
   * `draft` with no sessions is the whole definition: a task that got as far as
   * an agent has `running` and a session, and one being archived or restored has
   * neither of those things wrong with it.
   *
   * It says the wait ENDED, not what broke — the row carries the complaint
   * (`hookIssue`/`taskIssue`) and repeating it here would be the same fact drawn
   * twice, in two places that can disagree.
   */
  const stalledLine = (task: TaskRecord): { line: string } | undefined =>
    busy.get(task.id) === undefined && task.lifecycle === 'draft' && task.sessions.length === 0
      ? { line: 'Setting up this task did not finish.' }
      : undefined;

  function pushPlaceholder(taskId: string): void {
    const task = store.get(taskId);
    if (task === undefined) return;
    const placeholder = placeholderFor(task) ?? stalledLine(task);
    void commands
      .invoke('layout.setPlaceholder', {
        root: taskRootId(taskId),
        ...(placeholder === undefined ? {} : { placeholder }),
      })
      .then((answer) => {
        // A real failure is still a failure. `placed: false` is not one.
        if (!answer.ok) ctx.log.warn(`task ${taskId}: could not place its line — ${answer.error.message}`);
      });
  }

  /**
   * What shipping this task right now would cost — the question the row hands the
   * shell to ask (`TreeItem.primaryAction.confirm`).
   *
   * It names the CONSEQUENCE rather than asking "are you sure": the reason a
   * confirm is worth a dialog here is that the panes close and a mid-turn agent
   * dies with them, and a user who is told that can decide in one read. It also
   * says the work is recoverable, because the fear a confirm creates is the fear
   * of losing something — and shipping snapshots every uncommitted line.
   */
  const shipConfirm = (task: TaskRecord, state: string): string => {
    const mark = markOf(state);
    const doing =
      mark === 'waiting'
        ? 'is waiting on an answer'
        : mark === 'ready'
          ? 'has finished a turn you have not read'
          : 'is still working';
    const agents = task.sessions.length > 1 ? 'its agents' : 'its agent';
    return (
      `${task.title} ${doing}. Shipping closes its panes and stops ${agents} mid-turn. ` +
      'Uncommitted work is snapshotted, so un-shipping brings it all back.'
    );
  };

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
   * The transcript seam.
   *
   * Defined unconditionally, and `first()` is how it is read: a point with no
   * provider is a question nobody answers yet, which is a different fact from a
   * question nobody asked. The rail's own title filter never depends on it.
   */
  const transcripts = points.define<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT, {
    order: 'priority',
  });
  ctx.subscriptions.push(transcripts);

  /**
   * Registration order, not priority: a URL belongs to at most one vendor, so
   * "which provider wins" is not a question anybody is asking. The first to claim
   * it answers, and the rest are never asked.
   */
  const pastedLinks = points.define<PastedLinkProvider>(PASTED_LINK_POINT, {
    order: 'registration',
  });
  ctx.subscriptions.push(pastedLinks);

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
   * What else a row can say — see `CARD_FACTS_POINT`.
   *
   * Priority order, unlike the two above, and the difference is that this one
   * has a scarce resource to allocate: every provider is asked, each may answer
   * with one fact, and the card draws them in the order they come back. Two
   * integrations both wanting the cell is a real possibility, and "highest
   * priority first" is at least a rule somebody can act on.
   */
  const cardFacts = points.define<CardFactProvider>(CARD_FACTS_POINT, { order: 'priority' });
  ctx.subscriptions.push(cardFacts);

  /**
   * Every provider's answer for one task, dropped down to what a card can draw.
   *
   * Two guards, and both are about a contribution being unable to break the
   * rail. A fact with neither a glyph nor a label is nothing rendered but still
   * a cell drawn, so it is dropped; and a provider that THROWS is logged and
   * skipped rather than taking `getChildren` with it, because this runs inside
   * the one pass that draws the sidebar and an exception here is an empty
   * window.
   */
  const factsFor = (task: TaskRecord): readonly CardFact[] =>
    cardFacts.all().flatMap((provider) => {
      let fact: CardFact | null;
      try {
        fact = provider({
          id: task.id,
          slug: task.slug,
          title: task.title,
          shipped: task.lifecycle === 'archived',
          repos: task.repos.map((repo) => ({ path: repo.path, name: repo.name })),
        });
      } catch (error: unknown) {
        ctx.log.warn(`a ${CARD_FACTS_POINT} provider threw for ${task.id} — ${String(error)}`);
        return [];
      }
      if (fact === null) return [];
      if (fact.icon === undefined && fact.label === undefined) return [];
      return [fact];
    });

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
   * How long the ASK may take, and so how long a task's first `worktree add` may
   * be held for a name (D20) — this is the only clock.
   *
   * Measured over eight real naming calls — this prompt, the whole brief — the
   * spread is 11.5s to 28.3s, and the top of it is what this has to clear.
   * Nothing here joins an ask already in flight: the composer does not ask while
   * you type, so the whole of that latency falls inside this window, from a
   * standing start. It is a ceiling and not an expectation — a model that is
   * absent or signed out fails in about two seconds.
   */
  const NAME_ASK_TIMEOUT_MS = 60_000;

  /**
   * The last naming ask, and the brief it was about.
   *
   * ONE entry, not a map: a brief that is growing gets asked about more than
   * once, and every earlier answer is about text nobody has on screen any more.
   * What this buys is that two asks about the same brief are the same ask (D21) —
   * a second caller awaits the one in flight instead of paying for the model
   * twice. `tasks.suggestName` is the other caller; the composer is not one of
   * them, and does not ask while you type.
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
    if (pending !== undefined && stillTheSameBrief(pending.brief, trimmed)) {
      return pending.answer;
    }
    const answer = askForName(trimmed).catch(() => undefined);
    pending = { brief: trimmed, answer };
    return answer;
  };

  /** What a session's pane is called — one formula, two callers. */
  const paneTitle = (task: TaskRecord, session: { role: string; repo?: string }): string =>
    session.role === 'orchestrator' ? task.title : `${task.title} · ${session.repo ?? 'workstream'}`;

  /**
   * Every live pane of a task, told the task's current name.
   *
   * A pane is named once, when it opens, and its `userTitle` beats the OSC title
   * a program sets — so a name that lands after the panes do reaches them only
   * because this says so. A failure is logged and stepped over, for the reason
   * the call in `openAgentPane` gives: a title is the decorative part of a spawn,
   * and losing one is not worth an exception on a task that is otherwise fine.
   */
  async function relabelPanes(task: TaskRecord): Promise<void> {
    for (const session of task.sessions) {
      if (session.pane === undefined) continue;
      const renamed = await commands.invoke('layout.rename', {
        pane: session.pane,
        title: paneTitle(task, session),
      });
      if (!renamed.ok) {
        ctx.log.warn(`task ${task.id}: pane ${session.pane} kept its title — ${renamed.error.message}`);
      }
    }
  }

  /**
   * Ask what this task should be called, and change ONLY what it is called.
   *
   * Nothing awaits this. It runs beside provisioning rather than in front of it,
   * so a model that is slow, off or signed out costs a task nothing — and
   * `undefined`, which is what a declined or absent model answers, is an ordinary
   * outcome that leaves the brief in place.
   *
   * The record is RE-READ rather than written back from the copy this was handed:
   * the ask takes seconds, and in those seconds a task can be archived, restored
   * or deleted. Writing a captured record would undo whatever happened.
   */
  async function nameLater(task: TaskRecord): Promise<void> {
    const named = await pendingName(task.brief);
    if (named === undefined) return;
    const now = store.get(task.id);
    if (now === undefined || now.title === named) return;
    const settled: TaskRecord = { ...now, title: named };
    store.put(settled);
    changed();
    ctx.log.info(`task ${task.id}: named "${named}"`);
    await relabelPanes(settled);
  }

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
   * A task's pane group emptying frees its disk. **It does not ship it.**
   *
   * This used to invoke `tasks.archive`, which meant closing your last pane on a
   * piece of work declared that work finished. The two halves are separate now
   * (`shelve` versus the lifecycle flip) and only the disk half runs here:
   * shipping is a button, and nothing moves between the rail's two regions
   * without somebody pressing it.
   *
   * Keeping the teardown is not a compromise, it is the measurement. A live
   * worktree came to **838 MB** on the machine this was written for — 807 MB of
   * it the dependencies provisioning installs — against 16 KB for every shipped
   * task combined. Deleting this trigger along with the auto-ship would have made
   * every task the user opens and drifts away from hold most of a gigabyte
   * indefinitely, with nothing anywhere reclaiming it.
   *
   * Snapshotting rather than deleting is what makes the gesture safe: every
   * uncommitted line goes into `refs/shepherd/*`, and clicking the row puts it
   * back. A task with nothing in it shelves to nothing, with no special path.
   *
   * **No lifecycle branch.** A running task stays running and keeps its place in
   * the active list; a shipped one you had opened to look at stays shipped. Both
   * simply stop occupying disk. A task already shelved is skipped — there is
   * nothing left to snapshot, and `archiveWorktree` on an absent directory fails
   * per repo.
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
      // A draft never had a pane to close, and a task whose work is already on
      // the shelf has nothing left to snapshot.
      if (task === undefined || task.lifecycle === 'draft' || isShelved(task)) return;

      ctx.log.info(`task ${task.id}: its pane group closed`);

      // A refusal is the point: a conflicted worktree cannot be snapshotted, so
      // the task keeps its worktrees and says why. Silence here would be work
      // quietly not saved.
      void shelve(task).catch((error: unknown) => {
        ctx.log.warn(`task ${task.id}: its panes closed but its work could not be shelved — ${String(error)}`);
      });
    }),
  );

  /**
   * Archives die after thirty days.      }
    }),
  );

  /**
   * **Shipped work does not expire, and there is no sweep.**
   *
   * There was one: an archived task and its scrollback were deleted seven days
   * after shipping, on the argument that "a shelf that fills up is one nobody
   * trusts". That was written when Shipped was a collapsed drawer holding a
   * weekly recap. It is a permanent region of the rail now, with a search over
   * it, so it is the record of what you finished — and a region that silently
   * empties is worse than a long one.
   *
   * The disk argument does not survive the measurement either: shipping already
   * removes the worktrees and `rm -rf`s the task root, so a shipped task is a
   * small record plus its saved screens. Every shipped task on the machine this
   * was measured on came to **16 KB**, against **838 MB** for a single live
   * worktree. The sweep was deleting history to free kilobytes.
   *
   * `tasks.delete` is still there for work you actually want gone.
   */

  /**
   * **When each task last CHANGED STATE** — the clock behind `waiting 14m`.
   *
   * This is what replaced the diff line, and the reason is what the diff line
   * could not answer. `+12 −4 · 3 files` says work happened; it does not say
   * whether you are needed, and "am I the bottleneck" is the only question a
   * rail of six parallel agents exists to answer. A task that has been waiting
   * on you for a quarter of an hour should itch, and nothing on the row said so.
   *
   * The mark already says a task is WAITING. Only a clock says how long you have
   * been the one holding it up, which is what turns the rail from a status list
   * into a priority queue.
   *
   * **Stamped here rather than in `agents-core`**, whose registry is deliberately
   * pure — no clock, no IO — so that the ordering guard and the sweep's
   * hysteresis can be tested as values. A timestamp is exactly the impurity that
   * design keeps out, so the consumer that wants one keeps it.
   *
   * Transient, like every map around it: a duration measured from a moment in a
   * previous run of the app is not a duration, and a restart honestly showing no
   * elapsed time is better than one showing a number that counted while nothing
   * was running.
   */
  const stateSince = new Map<string, { readonly state: string; readonly at: number }>();

  /**
   * How long this task has been in the state it is in, or undefined the first
   * time we see it.
   *
   * Called from `rowFor`, which runs on every tree change — so it is pure map
   * work and a clock read, never IO. The FIRST sighting records and returns
   * nothing rather than claiming zero: a task that was already waiting when the
   * app started has been waiting longer than we know, and `0m` would be a lie
   * told with confidence.
   */
  /**
   * The DRAWN stamp, spreadable — `{ elapsed: '14m' }` or `{}`.
   *
   * Formatted here rather than in the card, and that is load-bearing: a raw
   * duration is a different number on every render, the renderer diffs rows to
   * decide what to redraw, and a field that never compares equal is an infinite
   * render loop. It was one. See `formatElapsed`.
   */
  function elapsedFor(taskId: string, state: string): { elapsed?: string } {
    const since = sinceOf(taskId, state);
    if (since === undefined) return {};
    const text = formatElapsed(since);
    return text === undefined ? {} : { elapsed: text };
  }

  function sinceOf(taskId: string, state: string): number | undefined {
    const seen = stateSince.get(taskId);
    if (seen === undefined || seen.state !== state) {
      stateSince.set(taskId, { state, at: ctx.clock.now() });
      return undefined;
    }
    return ctx.clock.now() - seen.at;
  }

  /**
   * **What each task's agent last said** — the rail's second line.
   *
   * The line finishes the sentence the state mark starts: ready → *with what
   * result*, failed → *why*. The write half is the instruction `root-synth`
   * puts in every task root's `CLAUDE.md`; this is the read.
   *
   * **Asked of `agents.lastSaid`, never of a transcript.** A task must not learn
   * that its agent keeps a JSONL file anywhere — that is the vendor's, and the
   * command is the same D11 seam `agents.resumeTarget` is. What comes back is
   * already gated: a sentence, or nothing.
   *
   * **Refreshed on a beat, not on a render**, exactly as the diff read it
   * replaces was, and for the reason that read recorded: `rowFor` runs on every
   * tree change, and IO per row per change is how v1 spent a third of a core.
   * The kind caches on the transcript's size, so a quiet task costs a `stat`.
   *
   * Transient. A sentence describes the turn that just ended; one restored from
   * disk would describe a turn from a previous run of the app.
   */
  const saids = new Map<string, string>();
  const saidsInFlight = new Set<string>();

  /**
   * One task's line, re-read.
   *
   * The ORCHESTRATOR's session and no other. A task's workstream agents are
   * saying things about their own piece of it, and a row that showed whichever
   * spoke last would change subject without saying so.
   */
  async function refreshSaid(task: TaskRecord): Promise<void> {
    const session = task.sessions.find((entry) => entry.role === 'orchestrator') ?? task.sessions[0];
    if (session === undefined) return;
    if (saidsInFlight.has(task.id)) return;
    saidsInFlight.add(task.id);
    try {
      const answer = await commands.invoke<{ text?: unknown }>(AGENTS_LAST_SAID, {
        sessionId: session.id,
      });
      // `ok` says the call succeeded, never that the value has a shape.
      const text = answer.ok && typeof answer.value?.text === 'string' ? answer.value.text : undefined;
      const before = saids.get(task.id);
      if (text === undefined) {
        /*
         * UNKNOWN, not empty — the same rule the diff read followed. An agent
         * mid-turn has said nothing NEW, and blanking the row would make the
         * line flicker away every time work started and back when it stopped.
         */
        return;
      }
      saids.set(task.id, text);
      // Only nudge when the ANSWER moved: this runs on a beat, and a tree change
      // per tick would re-render the rail for nothing.
      if (before !== text) changed();
    } catch (error) {
      ctx.log.warn(`could not read what ${task.id} last said — ${String(error)}`);
    } finally {
      saidsInFlight.delete(task.id);
    }
  }

  /**
   * Every live task. Archived ones have no agent to have said anything.
   *
   * Demand-driven, hung off the tree read, for the reason the diff read was: a
   * rail that is never drawn should do no work at all, and the surface that
   * wants the line pays for it.
   */
  function refreshSaids(): void {
    for (const task of store.list()) {
      if (task.lifecycle === 'archived') continue;
      void refreshSaid(task);
    }
  }

  /**
   * The last suite result reported for a task — see `TASK_COMMANDS.reportSuite`.
   *
   * Transient for the same reason `stateSince` is: a result describes a moment, and
   * one persisted into the store would outlive the code it measured. A restart
   * showing no meter is correct — nothing has run yet in this session.
   */
  const suites = new Map<string, { readonly total: number; readonly passed: number }>();

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
   * the pane (mint the root, or split the live one) and naming it. What differs
   * between them is the LINE — a fresh agent reads a prompt file, a resumed one
   * names a session — and that is the whole of the difference, which is why it
   * is the only parameter.
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
    const { cwd, title } = input;
    /*
     * An incognito task's agent runs out of the task's own profile — every
     * launch and every resume, because they go through here and a resume that
     * missed it would reattach the agent to the user's real history.
     */
    const command = task.incognito === true ? incognitoCommand(input.command, profileOf(task)) : input.command;

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

    /*
     * And LEAVE the window where it is. A spawn finishes seconds after it was
     * asked for — provisioning is slow — so switching to it takes the screen
     * away from whatever was read in the meantime. The sidebar row is how a
     * task off screen announces itself, and `tasks.reveal` is how you go.
     */
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
      // Off the CURRENT record: naming runs beside provisioning, so a name can
      // land between this task being handed over and its pane being opened.
      title: paneTitle(store.get(task.id) ?? task, { role: input.role, ...(input.repo === undefined ? {} : { repo: input.repo }) }),
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

  /** What the Shepherd Claude plugin is called where Claude Code loads it from. */
  const SHEPHERD_PLUGIN = 'shepherd-v2';

  /** Where a task's worktrees live. `ctx.dataDir` is the host's answer to D1b. */
  const rootOf = (task: TaskRecord): string => `${ctx.dataDir}/${task.slug}`;

  /**
   * Where an incognito task's Claude profile lives.
   *
   * Keyed on the task ID rather than the slug, unlike everything else here: a
   * slug is renameable and this directory is a secret's container, so a rename
   * that left one profile orphaned and started a second would silently keep the
   * history the feature exists to delete.
   */
  const profileOf = (task: TaskRecord): string => incognitoProfileDir(ctx.dataDir, task.id);

  /**
   * Take an incognito task's profile — and with it every transcript, prompt and
   * `history.jsonl` line the task ever wrote.
   *
   * A no-op for an ordinary task, and safe to call twice: ship, delete and the
   * startup sweep all reach for it, and any of the three may legitimately be
   * second.
   */
  const forgetProfile = (task: TaskRecord): void => {
    if (task.incognito !== true) return;
    const removed = removeIncognitoProfile(profileOf(task));
    if (removed.ok) ctx.log.info(`task ${task.id}: ${removed.detail}`);
    else ctx.log.warn(`task ${task.id}: ${removed.detail}`);
  };

  /**
   * The user's own `lastOnboardingVersion`, if it can be read.
   *
   * Read fresh rather than cached: it changes when Claude Code updates, and a
   * value captured at activation would go stale inside a long-running window.
   */
  const onboardingVersion = (): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${ctx.homeDir}/.claude.json`, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const value = (parsed as Record<string, unknown>)['lastOnboardingVersion'];
      return typeof value === 'string' ? value : undefined;
    } catch {
      // No config, or one that will not parse. Nothing to mirror.
      return undefined;
    }
  };

  /**
   * Where the Shepherd plugin is installed, if it is.
   *
   * The plugin whose hooks report an agent's state back to this app. Found where
   * the user's own profile keeps it rather than shipped from inside the bundle,
   * because the installed copy IS the one the tracking is known to work with —
   * a second copy in the app would be a second thing to keep in step, and would
   * silently disagree with the real profile the day they drifted.
   */
  const shepherdPlugin = (): string | undefined => {
    const path = `${ctx.homeDir}/.claude/skills/${SHEPHERD_PLUGIN}`;
    try {
      realpathSync(path);
      return path;
    } catch {
      // Not installed. The agent still runs; the rail simply will not track it,
      // and the warning at the seed says so.
      return undefined;
    }
  };

  /** The `statusLine` the user's own settings declare, if any. */
  const statusLine = (): unknown => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${ctx.homeDir}/.claude/settings.json`, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      return (parsed as Record<string, unknown>)['statusLine'];
    } catch {
      // No settings, or ones that will not parse. Nothing to mirror.
      return undefined;
    }
  };

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
  /**
   * What would reattach to the agent in this session, or null.
   *
   * Opaque (D11): asked of the agent kind through `agents.resumeTarget`, stored
   * unread, and handed back through the same seam. Read defensively — it crossed
   * a port and came from an extension this one has never seen, and an agent kind
   * that answers `undefined` must not take the whole shelve down with it.
   */
  async function resumeTargetOf(session: string): Promise<string | null> {
    const answer = await commands.invoke<unknown>(AGENTS_RESUME_TARGET, { sessionId: session });
    const value =
      answer.ok && typeof answer.value === 'object' && answer.value !== null
        ? (answer.value as { resumeTarget?: unknown }).resumeTarget
        : undefined;
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /**
   * The conversation this task recorded, when no agent is running to name it.
   *
   * Reached only after the live ask comes back empty, which after a restore is
   * the ORDINARY case: the resume line is typed and left at the prompt, so until
   * the user presses Enter there is no agent in that pty at all.
   *
   * By session id first. That misses whenever a restore has replaced the
   * session — the record's ids go stale there, which is its own debt — so it
   * falls back to the task's single recorded target. **Single**, deliberately:
   * with two, nothing here can say which pane's conversation is which, and
   * guessing would stage one agent's transcript into another's pane. That is a
   * worse outcome than a blank prompt, so it declines and says so.
   */
  function storedTargetFor(task: TaskRecord, session: string): string | null {
    const byId = task.sessions.find((candidate) => candidate.id === session)?.resumeTarget;
    if (byId !== undefined && byId !== '') return byId;

    const recorded = task.sessions.flatMap((candidate) =>
      candidate.resumeTarget === undefined || candidate.resumeTarget === '' ? [] : [candidate.resumeTarget],
    );
    if (recorded.length === 1) return recorded[0] ?? null;
    if (recorded.length > 1) {
      ctx.log.warn(
        `task ${task.id}: session ${session} is not running an agent and this task recorded ${recorded.length} conversations — none can be matched to it`,
      );
    }
    return null;
  }

  async function captureTabs(task: TaskRecord): Promise<readonly ArchivedTab[]> {
    const listed = await commands.invoke<readonly unknown[]>('layout.listRoots', {
      group: taskRootId(task.id),
    });
    if (!listed.ok || !Array.isArray(listed.value)) return [];

    const roots: RootReading[] = [];
    const history: Record<string, string> = {};
    const sessions: SessionReading[] = [];

    for (const raw of listed.value) {
      // Read defensively: this crossed a port, and `ok` says the call succeeded
      // rather than that the value has a shape.
      const row = raw as { root?: unknown; tree?: unknown; focusedPane?: unknown; panes?: unknown };
      if (typeof row.root !== 'string') continue;
      const panes = Array.isArray(row.panes) ? row.panes : [];

      const reading: RootReading['panes'][number][] = [];
      for (const rawPane of panes) {
        const p = rawPane as {
          pane?: unknown;
          cwd?: unknown;
          userTitle?: unknown;
          session?: unknown;
          lastSession?: unknown;
        };
        if (typeof p.pane !== 'string') continue;
        reading.push({
          pane: p.pane,
          cwd: typeof p.cwd === 'string' ? p.cwd : null,
          userTitle: typeof p.userTitle === 'string' ? p.userTitle : null,
        });

        /*
         * `lastSession` when the pane's own has EXITED — which is not an edge
         * case, it is the ordinary end of a turn.
         *
         * A pane whose agent finished has no live session: the binding is
         * dropped the moment the pty goes. It is still on screen and still shows
         * what the agent did, and capturing off `session` alone archived that
         * tab BLANK. The host retains a dead session's mirror for exactly this,
         * and releases it when the pane closes.
         *
         * A pane with neither has no screen anywhere to capture — it never
         * spawned anything.
         */
        const capturable =
          typeof p.session === 'string'
            ? p.session
            : typeof p.lastSession === 'string'
              ? p.lastSession
              : null;
        if (capturable === null) continue;

        /*
         * What would reattach to the agent ON THIS PANE — asked about the
         * session the LAYOUT says is there, right now.
         *
         * Nothing about this question goes through the task record, and two
         * rounds of this bug are why. The record's `pane` is stripped by
         * `shelve` and never restored, so a join through it worked exactly once
         * per task. And the record's `session.id` is **stale from the first
         * restore onward**: `rebuildTabs` opens panes that create new sessions
         * and never writes the new ids back, so asking the agent extension about
         * a recorded id asks about a session that no longer exists — measured
         * on a live install, where every task's recorded session was already
         * dead.
         *
         * The layout is the authority on what is on screen. Its binding is the
         * only correlation here that cannot go stale, because it is read in the
         * same breath as the screen it describes.
         */
        const target = (await resumeTargetOf(capturable)) ?? storedTargetFor(task, capturable);
        if (target !== null) {
          sessions.push({ pane: p.pane, sessionId: capturable, resumeTarget: target });
        } else {
          // Not a failure: a pane with no agent, and none ever recorded. Its
          // screen is still captured; it just comes back with nothing staged.
          ctx.log.info(`task ${task.id}: pane ${p.pane} has nothing to resume`);
        }

        const relative = historyPath(task.id, row.root, p.pane);
        try {
          const captured = await commands.invoke<{ bytes?: unknown }>('sessions.capture', {
            session: capturable,
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
      /*
       * Built above from the LAYOUT's binding, not from the record.
       *
       * `resumeTarget` is the only field restore needs, and it is opaque (D11) —
       * it names the agent's own way back without this extension ever learning
       * which agent that is.
       */
      sessions,
      history,
    });
  }

  /**
   * Every tab of a shelved task, opened as the SCREENS it was shelved with.
   *
   * No git, no directory, no pty. Its worktrees were snapshotted and removed,
   * and this puts what was on the display back without putting any of that
   * back: each tab opens at its archived root id, with its archived shape, and
   * every pane in it shows a file (`Pane.readOnly`).
   *
   * `tasks.reveal` used to call `materialize` here instead, so a click on work
   * from three weeks ago re-provisioned git and reinstalled its dependencies —
   * 838 MB on the machine that was measured. Putting it back is `tasks.restore`
   * now, and only that.
   *
   * The SHAPE comes back too, which the live restore could not do until this
   * change: `layout.split` takes an axis and no path, so a tree of ratios could
   * not be reproduced through it. A tab archived before shapes were stored opens
   * flat — and still read-only, or its one pane would be a shell in a directory
   * that no longer exists.
   */
  async function openSnapshotTabs(task: TaskRecord): Promise<void> {
    const group = taskRootId(task.id);
    for (const tab of task.tabs ?? []) {
      const tree = snapshotTreeFor(tab, archiveDir());
      const first = tab.panes[0];
      const flatHistory = first?.history;
      const opened = await commands.invoke('layout.openRoot', {
        root: tab.root,
        group,
        ...(tree === undefined
          ? {
              readOnly: true,
              ...(first?.cwd === undefined || first.cwd === null ? {} : { cwd: first.cwd }),
              ...(first?.userTitle === undefined || first.userTitle === null
                ? {}
                : { title: first.userTitle }),
              ...(flatHistory === undefined
                ? {}
                : { snapshotFile: `${archiveDir()}/${flatHistory}` }),
            }
          : { tree }),
      });
      if (!opened.ok) {
        // Reported and stepped over, as `rebuildTabs` does: the other tabs are
        // still worth showing, and giving up on the first failure would leave a
        // task half on screen with nothing saying why.
        ctx.log.warn(
          `task ${task.id}: tab ${tab.root} was not shown — ${opened.error.code}: ${opened.error.message}`,
        );
        continue;
      }

      /*
       * And what this root IS, with the one verb that ends the state.
       *
       * The label and the command id travel with it because the shell cannot
       * know either (ADR 0031) — it draws a button for a command it has never
       * heard of. Core answers with a placeholder only for a root whose panes
       * are all read-only, so nothing here has to say when to stop showing it:
       * restoring replaces the panes, and the banner goes with them.
       */
      const said = await commands.invoke('layout.setPlaceholder', {
        root: tab.root,
        placeholder: {
          line: ARCHIVED_LINE,
          action: { command: TASK_COMMANDS.restore, label: 'Restore', args: { task: task.id } },
        },
      });
      if (!said.ok) {
        ctx.log.warn(`task ${task.id}: tab ${tab.root} is shown without its banner`);
      }
    }
    ctx.log.info(`task ${task.id}: showed ${(task.tabs ?? []).length} archived tab(s), started nothing`);
  }

  /** Drop this task's read-only roots. Nothing to drain: they hold no sessions. */
  async function closeSnapshotTabs(task: TaskRecord): Promise<void> {
    for (const tab of task.tabs ?? []) {
      const closed = await commands.invoke('layout.closeRoot', { root: tab.root });
      if (!closed.ok) {
        ctx.log.warn(
          `task ${task.id}: snapshot tab ${tab.root} did not close — ${closed.error.message}`,
        );
      }
    }
  }

  /**
   * Put an archived task's tabs back — the SCREEN, and nothing else.
   *
   * **It relaunches every agent it can.** Each pane comes back at its directory
   * with the screen it had, and its agent's resume line is typed AND run.
   *
   * That is a reversal: the line used to be left sitting at the prompt, because
   * "restoring a five-tab task to glance at it must not start five agents". The
   * snapshot view took that case away — glancing is `tasks.reveal` now, which
   * provisions nothing — so the only thing Restore can mean is that you want the
   * work back, and a per-tab Enter is a confirmation of what was already asked.
   *
   * The mechanism is one character either way. `layout.setInitialInput`
   * documents that a newline in the staged string is an Enter press; the change
   * is that `stagedResumeLine` now ends in one. There is no new seam here, and
   * the "exactly one initial input per pane" invariant is untouched.
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

      /*
       * The archived SHAPE, with none of the snapshot marking: these panes are
       * about to be real. `snapshotTreeFor` is the read-only variant of the same
       * rewrite, and the two must not be confused — one starts nothing, this one
       * starts everything.
       */
      const tree = liveTreeFor(tab);

      const opened = await commands.invoke('layout.openRoot', {
        root: tab.root,
        group,
        ...(tree === undefined ? {} : { tree }),
        ...(first?.cwd === undefined || first.cwd === null ? {} : { cwd: first.cwd }),
        ...(first?.userTitle === undefined || first.userTitle === null ? {} : { title: first.userTitle }),
        // A shaped open mints several panes at once, so there is no "the" pane
        // for `openRoot`'s own seed to land on — every pane of a shaped tab is
        // seeded by id below instead. The flat path keeps using it.
        ...(tree !== undefined || seed === undefined ? {} : { seed }),
        ...(tree !== undefined || staged === undefined ? {} : { initialCommand: staged }),
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
       * A tab that carried a SHAPE is already whole — `layout.openRoot` built
       * every pane of it — so all that is left is to give each one its screen
       * and its staged line, by id.
       *
       * The ids are the archived ones: `deserializeNode` keeps a persisted id
       * (ADR 0036), so the leaf that came back and the `ArchivedPane` that
       * describes it are the same string. Joining them any other way would be a
       * second correlation to keep in step.
       */
      if (tree !== undefined) {
        for (const pane of tab.panes) {
          const paneSeed = readHistory(pane.history);
          const paneStaged = await stagedResumeLine(task, pane);
          if (paneSeed === undefined && paneStaged === undefined) continue;
          const seeded = await commands.invoke('layout.seedPane', {
            pane: pane.pane,
            ...(paneSeed === undefined ? {} : { seed: paneSeed }),
            ...(paneStaged === undefined ? {} : { initialCommand: paneStaged }),
          });
          if (!seeded.ok) {
            ctx.log.warn(
              `task ${task.id}: pane ${pane.pane} of ${tab.root} came back without its screen — ${seeded.error.message}`,
            );
          }
        }
        continue;
      }

      /*
       * The rest of the tab's panes, in order, each with its own screen and its
       * own staged line — for a tab archived BEFORE shapes were stored.
       *
       * This is the flat fallback the comment here used to describe as the only
       * option: `layout.split` takes an axis and no path, so a tree of ratios
       * cannot be reproduced through it, and a restore that silently produced a
       * different arrangement would be worse than one that is honestly flat.
       * `layout.openRoot`'s `tree` is what closed that, above.
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

  /**
   * Put the record's session list back in step with the panes now on screen.
   *
   * **This is the rot the resume bug grew out of.** `correlate` re-points a
   * record's session id at the live one, and it ran on SPAWN only — never on
   * restore. So from the first restore onward every task named sessions that had
   * been dead for weeks (measured on a live install: `live? False` on every
   * session of every task), and `shelve` then asked the agent extension about
   * ids that addressed nothing.
   *
   * The join is by **resume target**, not by session id or by pane:
   *   - the session id is exactly the thing that has gone stale;
   *   - the record's `pane` was stripped by the shelve that made this archive.
   * The target is the one value that survived both, and it is what the archived
   * pane carries — so it identifies which recorded session this pane IS, and
   * carries its `role` and `repo` across with it.
   *
   * Best-effort and quiet: a pane whose session never appears keeps whatever the
   * record said. The bargain `correlate` already strikes, and for the same
   * reason — the pane is real either way.
   */
  async function recorrelate(task: TaskRecord): Promise<void> {
    const archived = (task.tabs ?? []).flatMap((tab) =>
      tab.panes.flatMap((pane) =>
        pane.resumeTarget === undefined ? [] : [{ pane: pane.pane, target: pane.resumeTarget, root: tab.root }],
      ),
    );
    if (archived.length === 0) return;

    for (let attempt = 0; attempt < CORRELATE_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => ctx.clock.setTimeout(() => resolve(), CORRELATE_INTERVAL_MS));
      const listed = await commands.invoke<{ id: string; paneId?: string }[]>('sessions.list');
      if (!listed.ok) continue;
      const livePane = new Map(
        listed.value.flatMap((row) => (row.paneId === undefined ? [] : [[row.paneId, row.id] as const])),
      );
      const found = archived.flatMap((entry) => {
        const live = livePane.get(entry.pane);
        return live === undefined ? [] : [{ ...entry, live }];
      });
      if (found.length < archived.length) continue;

      // Re-read: `materialize` and a spawn may both have written since.
      const current = store.get(task.id);
      if (current === undefined) return;
      const byTarget = new Map(current.sessions.map((session) => [session.resumeTarget, session]));
      store.put({
        ...current,
        sessions: found.map((entry) => {
          const previous = byTarget.get(entry.target);
          return {
            // `role` and `repo` come from the session this pane WAS. A default
            // would quietly demote an orchestrator, and `provision` branches on
            // a task having one.
            role: previous?.role ?? 'orchestrator',
            ...(previous?.repo === undefined ? {} : { repo: previous.repo }),
            id: entry.live,
            pane: entry.pane,
            root: entry.root,
            resumeTarget: entry.target,
          };
        }),
      });
      changed();
      ctx.log.info(`task ${task.id}: re-correlated ${found.length} restored session(s)`);
      return;
    }
    ctx.log.warn(
      `task ${task.id}: a restored pane never reported a session — the record keeps its old ids`,
    );
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
   * The line that resumes this pane's agent — typed AND RUN.
   *
   * Asked of the agent kind through `agents.resumeCommand`, exactly as
   * `resumeSession` does, so `tasks` still never learns a binary or a flag
   * (D11).
   *
   * **The trailing newline is deliberate, and it reverses an earlier decision.**
   * This used to trim it, so the line sat at the prompt waiting for a human — on
   * the argument that "restoring a five-tab task to glance at it must not start
   * five agents". That argument died with the snapshot view: glancing is now
   * `tasks.reveal`, which costs no worktree and no pty, so the only reason left
   * to press Restore is wanting the work BACK. Making the user then press Enter
   * once per tab is asking them to confirm the thing they just asked for.
   *
   * Whitespace is still normalised first, so exactly one newline reaches the
   * pty — two would submit the line and then an empty prompt behind it.
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
    // THE character: a trailing newline is an Enter press. See above for why
    // this one is now sent rather than withheld.
    return `${command.replace(/\s+$/u, '')}\n`;
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
   * A task's folder is minted, not named — and then it never moves.
   *
   * The slug is a directory, and after the first `worktree add` changing it would
   * mean `git branch -m`, `git worktree move`, moving the task root,
   * re-synthesizing its CLAUDE.md and symlinks and re-seeding Claude Code's
   * per-path trust, all while an orchestrator boots with a cwd inside the
   * directory being moved. Rather than hold a task still until a name arrives,
   * nothing on disk is named after the task at all — which is what lets the ask
   * run beside provisioning instead of in front of it (`nameLater`).
   */

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

  /**
   * `spawn: false` — put the worktrees back without inventing an agent.
   *
   * The block at the end of `runProvision` starts an orchestrator for a task with
   * no sessions, which is right when the task is new and wrong when it is coming
   * back off the shelf: what a returning task wants is its own agents reattached
   * (`materialize` does that from the stored resume targets), and a fresh one on
   * the original brief is the same words with none of the transcript. The write
   * that starts it also sets `lifecycle: 'running'`, which would drag a shipped
   * task you only wanted to LOOK at back into the active list.
   */
  interface ProvisionOptions {
    readonly images?: readonly PastedImage[];
    readonly spawn?: boolean;
  }

  async function provision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    opts?: ProvisionOptions,
  ): Promise<void> {
    return whileBusy(task.id, 'provisioning', () => runProvision(task, images, opts));
  }

  async function runProvision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    opts?: ProvisionOptions,
  ): Promise<void> {
    taskIssue.delete(task.id);

    /**
     * Every repo's refs, read at once and before any branch is decided.
     *
     * `provisionRepo` was split in two so this half could start without knowing
     * the branch, and the reason has changed rather than gone: it overlapped the
     * network with a model call, and it now overlaps it with nothing while
     * answering the question `pickBranch` asks — is this minted name already a
     * branch here? Probe 2's numbers are why it is worth starting early either
     * way (~2.5s of fetch per repo against a 0.16s `worktree add`), and why
     * **every** repo is prefetched: the chains below run at once, so a second
     * repo's fetch left until then would pay its full network wait in series.
     *
     * Each read is wrapped so it cannot reject while nobody is awaiting it.
     * `readRepoRefs` does not catch a transport rejection, and N eager promises
     * would be N chances at an unhandled rejection; the error is carried instead
     * and thrown at the site that can report it.
     */
    const prefetched = task.repos.map((repo) =>
      readRepoRefs(api.proposed.process, repo).then(
        (refs) => ({ ok: true as const, refs }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );

    const root = rootOf(task);

    /**
     * The task's branch — chosen once the refs are in, and checked against EVERY
     * repo.
     *
     * A minted name has no relationship to the work, so a name that already
     * exists somewhere is somebody else's branch: `resolveBranch` would check it
     * out rather than create it, and the task would silently adopt a deleted
     * task's commits. Usually this IS the slug; it differs only when that name
     * was taken.
     *
     * A repo whose refs could not be read contributes nothing to the check, which
     * is the honest reading — its chain is about to fail on the same error, and
     * the alternative is treating an unread repo as "everything here is free".
     */
    const readable = (await Promise.all(prefetched)).flatMap((read) => (read.ok ? [read.refs] : []));
    const branch = pickBranch(task.slug, readable, () => mintName(Math.random));
    if (branch !== task.slug) {
      ctx.log.info(`task ${task.id}: branch ${branch}, because ${task.slug} was taken`);
    }

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
          branch,
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
              branch,
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

    const landed = (
      await whileBusy(task.id, 'worktrees', () => Promise.all(chains))
    ).filter((entry): entry is LandedRepo => entry !== undefined);

    /**
     * Writing the root — its generated `CLAUDE.md` and the symlinked skills and
     * agents the repos contribute.
     *
     * Its own phase rather than part of `worktrees`, because it is the step that
     * has nothing to do with git and everything to do with what the agent will
     * read a moment later: `readContribution` walks every landed worktree's
     * `.claude/`, and on a multi-repo task that is the difference between "the
     * network is slow" and "it is assembling my files" — two waits a user reads
     * very differently.
     */
    const { plan, out } = await whileBusy(task.id, 'linking', async () => {
      const planned = synthTaskRoot({
        brief: task.brief,
        branch,
        repos: landed.map((repo) => ({
          name: repo.name,
          path: repo.worktree,
          ...readContribution(repo.worktree),
        })),
      });
      return { plan: planned, out: materializeTaskRoot(root, planned) };
    });
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
    // Still `linking`: a provider here is finishing the root, and it is somebody
    // else's shell script — the one step in the whole run whose duration this
    // codebase cannot predict at all. Leaving it under the floor word would put
    // the longest possible pause on the vaguest possible label.
    const taskComplaints = await whileBusy(task.id, 'linking', async () => {
      const complaints: string[] = [];
      for (const provider of taskProvisioned.all()) {
        try {
          const done = await provider({
            task: { slug: task.slug, root },
            branch,
            repos: ready.map((repo) => ({ path: repo.path, name: repo.name, worktree: repo.worktree })),
          });
          if (!done.ok) complaints.push(done.message ?? 'reported a failure with no message');
        } catch (error) {
          // Somebody else's extension must not be able to take a task down.
          complaints.push(error instanceof Error ? error.message : String(error));
        }
      }
      return complaints;
    });
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
    /*
     * The trust seed opens the `starting` phase rather than closing `linking`,
     * because what it is FOR is the spawn below — it exists so the orchestrator
     * does not open on a dialog. Grouping it with the step it serves is also what
     * keeps the last label on screen until a pane actually appears.
     */
    await whileBusy(task.id, 'starting', async () => {
      /*
       * An INCOGNITO task is trusted in its own profile and nowhere else.
       *
       * Both halves matter. The session will read its trust record out of
       * `CLAUDE_CONFIG_DIR`, so a record in `~/.claude.json` would leave the
       * agent sitting on the dialog this exists to skip; and a record in
       * `~/.claude.json` is itself a durable note that this task happened, in
       * the file the user asked Shepherd to stay out of. One directory, one
       * write, deleted with the task.
       */
      const dirs = [root, ...landed.map((repo) => repo.worktree)];
      /*
       * The credential, carried over so the agent does not open on a login.
       *
       * Read HERE rather than inside the seed so the seed stays a pure write —
       * and read per provision rather than once at activation, because a token
       * refreshed since the window opened is the one this profile should get.
       */
      const credentials = task.incognito === true ? await claudeCredentials(api.proposed.process) : undefined;
      if (task.incognito === true && shepherdPlugin() === undefined) {
        ctx.log.warn(
          `task ${task.id}: the Shepherd Claude plugin is not installed at ` +
            `~/.claude/skills/${SHEPHERD_PLUGIN}, so its incognito agent will run untracked`,
        );
      }
      if (task.incognito === true && credentials === undefined) {
        ctx.log.warn(
          `task ${task.id}: the Keychain would not give up the Claude credential — ` +
            `its incognito agent will open on a login prompt`,
        );
      }
      const seeded = task.incognito === true
        ? seedIncognitoProfile({
            dir: profileOf(task),
            dirs,
            realpath: realpathSync,
            ...(credentials === undefined ? {} : { credentials }),
            ...(() => {
              const plugin = shepherdPlugin();
              return plugin === undefined ? {} : { plugin };
            })(),
            ...(() => {
              const line = statusLine();
              return line === undefined ? {} : { statusLine: line };
            })(),
            // An onboarding flag, mirrored rather than invented — it is about
            // the app's first-run screens, not about the user. Absent when the
            // real config cannot be read, since a version we made up is worse
            // than none.
            ...(() => {
              const version = onboardingVersion();
              return version === undefined ? {} : { onboardingVersion: version };
            })(),
          })
        : seedClaudeTrust({
            homeDir: ctx.homeDir,
            dirs,
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
      if (opts?.spawn !== false && now !== undefined && now.sessions.length === 0) {
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
    });
  }

  /**
   * Put a task's work on the shelf: snapshot it, close its panes, free its disk.
   *
   * **It does not touch the lifecycle, and that separation is the point.** These
   * two things were one operation, and conflating them meant the only thing that
   * reclaimed a worktree was also the thing that declared the work finished — so
   * closing a task's last pane shipped it, which is a decision the app was making
   * on the user's behalf. Shipping is now a button; this is the disk.
   *
   * Worth the size of the number: a live worktree measured **838 MB** on the
   * machine this was written for, 807 MB of it the dependencies provisioning
   * installs, against 16 KB for every shipped task combined. Nothing else frees
   * that, so it has to be able to run without moving the task.
   *
   * Refuses rather than half-succeeds. A conflicted worktree cannot be
   * snapshotted (`git write-tree` fails on an unmerged index), and the panes are
   * only closed once what is on disk is safe — a refusal that had already closed
   * them would leave the user with work to resolve and no agent left to do it.
   */
  async function shelve(task: TaskRecord): Promise<{ readonly warnings: readonly string[] }> {
    return whileBusy(task.id, 'archiving', async () => {
      const root = rootOf(task);

      /**
       * Capture what would reattach to each agent, BEFORE its pty is gone.
       *
       * Without this, materializing a task started a fresh agent on the original
       * brief — the same words, none of the transcript — because the record held
       * nothing that could reattach and `provision` treats a task with no
       * sessions as one that has never run. The value is the kind's and stays
       * opaque here (D11): asked for through `agents.resumeTarget`, stored, and
       * handed back unread.
       *
       * The PANE is dropped in the same write. It closed with the root, and a
       * record naming a pane that does not exist is what made the archive trigger
       * unreliable in the first place.
       */
      const sessions = await Promise.all(
        task.sessions.map(async (session) => {
          const fresh = await resumeTargetOf(session.id);
          /*
           * A target that was captured once is KEPT when it cannot be re-derived.
           *
           * This unconditionally overwrote it, and that is what made the archive
           * lose the agent on the second lap. The two ids in play are different
           * kinds of thing:
           *
           *   - a **Shepherd session** is a live pty. Shelving kills it, and
           *     restoring cannot revive it — a dead id names nothing (ADR 0036),
           *     so a restored pane always gets a NEW session.
           *   - a **resume target** is the agent's own conversation, a transcript
           *     on disk. That is what survives, and what `claude --resume` replays
           *     into a fresh process.
           *
           * `agents.resumeTarget` maps the first to the second, and only while
           * the agent is actually running in that pty. After a restore it is not
           * — the resume line has not been pressed yet — so the ask comes back
           * empty and overwriting on that answer erased the only copy of the
           * transcript id. Which then guaranteed the next restore had nothing to
           * stage: a loop that fed itself.
           *
           * So: a fresh answer wins, and silence changes nothing.
           */
          const target = fresh ?? session.resumeTarget ?? null;
          if (fresh === null && target !== null) {
            ctx.log.info(
              `task ${task.id}: session ${session.id} is not running an agent; keeping the target it was archived with`,
            );
          } else if (target === null) {
            // Genuinely nothing: a session that never adopted an agent at all.
            ctx.log.info(`task ${task.id}: session ${session.id} has nothing to resume`);
          }
          const { pane: _closed, ...rest } = session;
          return { ...rest, ...(target === null ? {} : { resumeTarget: target }) };
        }),
      );
      let current: TaskRecord = { ...task, sessions };
      store.put(current);

      const warnings: string[] = [];
      const archives: RepoArchive[] = [];
      for (const repo of current.repos) {
        const out = await archiveWorktree(api.proposed.process, repo.path, `${root}/${repo.name}`);
        if (!out.ok) {
          // A refusal is the whole point — a conflicted worktree cannot be
          // snapshotted, and failing inside git is how v1 found that out.
          throw new Error(`${repo.name}: ${out.reason}`);
        }
        // Recorded, because a snapshot nothing points at is one materializing
        // cannot find — and an unreferenced pinned commit is worse than no
        // archive: it looks like the work is safe.
        archives.push({ repo: repo.name, ...out.record });
        // Gitignored files go either way; the user hears about it first.
        for (const warning of out.warnings) warnings.push(`${repo.name}: ${warning}`);
      }

      /*
       * The tabs, and what was on each of their screens.
       *
       * BEFORE `closeTaskRoot`, which is what kills the ptys — and a mirror dies
       * with its session. Capturing afterwards would archive N empty screens and
       * report no fault, because nothing would have failed.
       *
       * AFTER the worktree snapshots, so a conflicted repo that refuses above
       * does not leave a directory of `.term` files behind for a task that still
       * has its worktrees.
       */
      const tabs = await captureTabs(current);
      current = { ...current, ...(tabs.length === 0 ? {} : { tabs }) };
      store.put(current);

      // AFTER the snapshots, and that order is the whole of it: a conflicted
      // worktree refuses above, and a refusal that had already closed the task's
      // panes would leave the user with the work still on disk and no agent left
      // to finish resolving it. Shelving is only allowed to touch the screen once
      // what is on disk is safe.
      await closeTaskRoot(current);

      /**
       * The task root goes too — the whole directory, not just the worktrees.
       *
       * `archiveWorktree` removes each repo's checkout and leaves everything the
       * extension GENERATED: the synthesized `CLAUDE.md`, the aggregated
       * `.claude/` links, the now-empty repo folders. So a shelved task left a
       * directory you could still `cd` into that described work no longer there,
       * and the tasks directory grew a folder per task forever.
       *
       * Safe because the root is DERIVED and nothing else: every file in it is
       * either generated from the record (root-synth) or a worktree already
       * snapshotted into `refs/shepherd/*`. Materializing re-provisions and
       * re-writes it, which is the same path that built it the first time — one
       * code path for "make this task real", not two.
       */
      rmSync(root, { recursive: true, force: true });

      const latest = store.get(task.id) ?? current;
      store.put({ ...latest, archives, shelvedAt: ctx.clock.now() });
      changed();
      for (const warning of warnings) ctx.log.warn(`task ${task.id}: ${warning}`);
      return { warnings };
    });
  }

  /**
   * Put a task's work back on disk — the counterpart to `shelve`, and equally
   * silent about the lifecycle.
   *
   * Called for a shipped task you only want to LOOK at, which is why it cannot
   * flip anything: with Shipped permanently on screen, clicking a row three weeks
   * old must show you the work without quietly dragging it back into the list you
   * are working from.
   *
   * Optimistic, for the same reason creating a task is: the record is written
   * first and the git work follows, so this returns before every repo is back and
   * the tree reports the rest.
   */
  async function materialize(task: TaskRecord): Promise<void> {
    // `spawn: false` is load-bearing twice over — see `ProvisionOptions`.
    await provision(task, undefined, { spawn: false });
    // Re-provisioning gives back the branch and a CLEAN tree, which is not what
    // was shelved. Replaying the snapshot is a separate step, and omitting it is
    // what made an earlier build "restore" a task to an empty working tree while
    // reporting success.
    for (const archive of task.archives ?? []) {
      const out = await restoreWorktree(api.proposed.process, `${rootOf(task)}/${archive.repo}`, archive);
      if (!out.ok) ctx.log.warn(`task ${task.id}: ${archive.repo} work not replayed — ${out.reason}`);
    }
    /*
     * The archives are consumed and `shelvedAt` goes with them: they describe a
     * snapshot that has now been put back, and keeping them would let a second
     * materialize overwrite newer work with the old one.
     */
    const now = store.get(task.id);
    if (now !== undefined) {
      const { shelvedAt: _gone, ...rest } = now;
      store.put({ ...rest, archives: [] });
    }

    /**
     * And put the AGENTS back — reattached, not restarted.
     *
     * This is what the shelved resume targets were for. Materializing used to
     * leave a task with its worktrees and no agent, and clicking it then started
     * a fresh one on the original brief: the same words with none of the
     * transcript, which reads as the agent having forgotten everything it did.
     *
     * A task shelved WITH its tabs comes back as those tabs, and comes back
     * QUIET — `rebuildTabs` paints each pane's screen and leaves its agent's
     * resume line at the prompt, unsubmitted. The loop after it is the older
     * path, for a record written before tabs existed.
     *
     * A session with no target is skipped rather than started fresh: an agent
     * that cannot be reattached to is one there is nothing to restore, and
     * re-prompting it is the behaviour being avoided. `tasks.spawn` is right
     * there when you do want a new one.
     */
    const back = store.get(task.id);
    if ((back?.tabs ?? []).length > 0) {
      await rebuildTabs(back as TaskRecord);
      changed();
      /*
       * Not awaited: the panes are on screen and the record catching up with
       * them is bookkeeping, while `recorrelate` polls `sessions.list` for up to
       * a second. Making a restore wait on it would put that second in front of
       * the user for a write they cannot see.
       */
      void recorrelate(back as TaskRecord).catch((error: unknown) => {
        ctx.log.warn(`task ${task.id}: restored sessions were not re-correlated — ${String(error)}`);
      });
      return;
    }
    for (const session of back?.sessions ?? []) {
      if (session.resumeTarget === undefined) continue;
      try {
        await resumeSession(store.get(task.id) as TaskRecord, session);
      } catch (error: unknown) {
        ctx.log.warn(`task ${task.id}: session ${session.id} not resumed — ${String(error)}`);
      }
    }
    changed();
  }

  /**
   * Is this task's work on the shelf rather than on disk?
   *
   * `shelvedAt` for anything shelved from now on. The lifecycle clause is for
   * records written before that field existed, where being archived was the only
   * way to have no worktrees — new records carry both, so the second half is
   * history rather than a parallel rule.
   */
  const isShelved = (task: TaskRecord): boolean =>
    task.shelvedAt !== undefined || task.lifecycle === 'archived';

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
        /**
         * A title the caller chose.
         *
         * Optional, and the optionality is load-bearing: the composer sends only
         * a brief, so a title that IS present is one a person typed and is left
         * alone. While it was required, the composer supplied the brief's first
         * line and nothing could tell the two apart.
         */
        title: s.optional(s.string()),
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
        repos: s.optional(s.array(repoArg)),
        /**
         * Images pasted into the brief, base64, in the order their `[Image #N]`
         * tokens appear. They cross the port as data because the page is where
         * a clipboard exists and this side is where a filesystem does.
         */
        images: s.optional(s.array(s.object({ mediaType: s.string(), data: s.string() }))),
        /**
         * Run this task's agents out of a Claude profile of their own, deleted
         * when the task is.
         *
         * Creation-time only, and `store.ts` says why: a task that has already
         * written a transcript into the user's real profile cannot be made
         * incognito after the fact.
         */
        incognito: s.optional(s.boolean()),
      }),
      handler: async (args) => {
        const elsewhere = await forwardToMember(TASK_COMMANDS.create, args);
        if (elsewhere !== undefined) return elsewhere;
        /**
         * Minted, resolved ONCE against what is taken, and then stored (D8).
         *
         * Re-deriving it later would let two tasks resolve to one folder and
         * quietly share a worktree — and there is nothing to re-derive it FROM
         * any more, which is the point: a folder that owes nothing to the brief
         * is a folder no name has to arrive before.
         */
        const slug = uniqueSlug(mintName(Math.random), store.takenSlugs());
        /**
         * A title the caller TYPED wins, and is never revised.
         *
         * `--title 'Fix login'` is a person's choice; overwriting it with a guess
         * about the paragraph underneath would be a regression, so it also
         * suppresses the ask below. Everything else opens on the brief itself —
         * unfinished rather than wrong, which is what it is — and `nameLater`
         * replaces it if the model answers.
         */
        const chosen = args.title?.trim();
        const authored = chosen !== undefined && chosen !== '';
        const title = authored ? chosen : firstLine(args.brief ?? '');
        const task: TaskRecord = {
          schemaVersion: 1,
          id: nextId(),
          slug,
          title,
          brief: args.brief ?? '',
          lifecycle: 'draft',
          // Absent stays absent, so the vendor's default keeps deciding.
          ...(args.model === undefined ? {} : { model: args.model }),
          // Only ever `true` on the record: an explicit `false` is the ordinary
          // task, and storing it would be a second spelling of the default.
          ...(args.incognito === true ? { incognito: true as const } : {}),
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
        /*
         * An INCOGNITO task records nothing here.
         *
         * The history is what the composer offers on its next open, so an
         * incognito task's repos in it would name the work on the very surface
         * the mode exists to keep it off — and unlike the profile, this store
         * survives the task, so there would be nothing left to delete it with.
         * Not-writing is the only version of this that is actually private.
         *
         * The cost is a real one and it is the right trade: picking the same repo
         * for an incognito task does not move it up the list, so the ranking
         * behaves as though that task never happened. Which is the promise.
         */
        if (task.incognito !== true) {
          store.recordRepoUses(
            task.repos.map((repo) => `${rootOf(task)}/${repo.name}`),
            ctx.clock.now(),
          );
        }
        ctx.log.info(`created task ${task.id} (${slug}) with ${task.repos.length} repo(s)`);

        // OPTIMISTIC (D12): the record exists and is answerable NOW, and the
        // worktrees fill in behind it. Probe 2 sized why — a `worktree add` is
        // 0.16s but one network round-trip is 2.51s, paid ONCE PER REPO, so a
        // three-repo task is ~7.5s of nothing before a file is written. The
        // caller gets the task; provisioning reports itself through the record.
        void provision(task, args.images).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: provisioning threw — ${String(error)}`);
        });
        /**
         * BESIDE provisioning, never in front of it.
         *
         * Nothing awaits this and nothing it answers reaches disk, so a model
         * that is slow, off or signed out costs the task exactly nothing. Here
         * and not in `restore`: a returning task has been named already, and a
         * second opinion about a name a person has been reading for a week is
         * not an improvement.
         */
        if (!authored) {
          void nameLater(task).catch((error: unknown) => {
            ctx.log.error(`task ${task.id}: naming threw — ${String(error)}`);
          });
        }
        changed();
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
          /**
           * The PANE GROUP this task's tabs live in — `taskRootId`, and not to
           * be confused with `root` above, which is a DIRECTORY.
           *
           * Reported because another extension has a legitimate reason to open a
           * tab of a task (`github` opens a review tab) and the alternative is
           * spelling `task:${id}` in its own source. That string is this
           * extension's convention, it is derived in one place on purpose
           * (`root-id.ts` says why), and a second writer of it is exactly the
           * disagreement that file exists to prevent — with the failure being a
           * tab that opens in a group of its own instead of in the task.
           */
          group: taskRootId(task.id),
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
         * A shelved task is SHOWN, not put back — and **stays where it is**.
         *
         * Its worktrees were snapshotted and removed, so this renders the screens
         * they were removed with. Nothing is provisioned, nothing is spawned, and
         * the row does not move: looking at shipped work must not un-ship it, and
         * looking at any shelved work must not spend a git restore on a glance.
         * Putting it back is its own button (`tasks.restore`).
         *
         * The same path serves an ACTIVE task whose panes were closed — that is a
         * thing, because closing them reclaims the worktrees without shipping
         * anything.
         *
         * This used to call `materialize` here. The cost was not theoretical: a
         * live worktree measured 838 MB on the machine this was written for, and
         * a stray click paid it.
         */
        const shelved = isShelved(task);
        if (shelved) {
          await openSnapshotTabs(task);
        }

        /**
         * A task that is still being BUILT opens with no pane at all.
         *
         * The shell below is right for a task that exists — you clicked it, here
         * is its directory. It is wrong for one whose directory is still being
         * cut: the pane mounts in a folder that may not be there yet, under a
         * slug that may still change, and — the part that outlives the wait —
         * **it is the pane the agent then splits beside.** `openAgentPane` asks
         * `layout.openRoot` and branches on whether the root already has one;
         * finding this shell, it appends the agent next to it and nothing ever
         * reclaims it. So the fix is upstream of the split: do not mint the shell.
         *
         * The root is still opened, and that matters — the window switches to it
         * below and the rail highlight is derived from which root is active (ADR
         * 0035), so a task you clicked has to BE somewhere. It is simply
         * somewhere with nothing in it, which the stage already knows how to draw.
         * When provisioning finishes, `openRoot` sees a root with no panes, seeds
         * the agent as its first, and the wait retires itself.
         */
        /*
         * A SHELVED task with no captured tabs opens empty, saying so.
         *
         * Without this it would fall through to the shell below — a pane at
         * `rootOf(task)`, which is a directory the archive deleted. That is the
         * app pretending the task is there, which is the failure `materialize`
         * used to prevent by rebuilding it. Nothing was captured for it (it never
         * spawned, or it was shelved before tabs were stored), so the honest
         * answer is an empty root with the Restore verb on it.
         */
        const placeholder = placeholderFor(task);
        const archivedEmpty =
          shelved && (task.tabs ?? []).length === 0
            ? {
                line: ARCHIVED_LINE,
                action: { command: TASK_COMMANDS.restore, label: 'Restore', args: { task: task.id } },
              }
            : undefined;
        const opened = await commands.invoke<{ created: boolean; pane: string | null }>('layout.openRoot', {
          root,
          cwd: rootOf(task),
          title: task.title,
          ...(archivedEmpty !== undefined
            ? { empty: true, placeholder: archivedEmpty }
            : placeholder === undefined
              ? {}
              : { empty: true, placeholder }),
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
      /**
       * Ship it: shelve the work, and record that you are done with it.
       *
       * Two halves that used to be one function, and the split is what makes the
       * rail's two regions honest — `shelve` frees the disk and can run on its
       * own (closing a task's panes does exactly that), while the lifecycle flip
       * here happens only because somebody pressed the button.
       */
      handler: async (args) => {
        const found = store.get(args.task);
        if (found === undefined) throw new Error(`no task ${args.task}`);
        /*
         * **An incognito task is DELETED by this verb, not shelved.**
         *
         * Shipping is "shelve the work and record that you are done with it",
         * and the record is the problem: a shipped row lives in Today forever
         * carrying the task's title and its repo paths. On an incognito task
         * that row IS the leftover — the profile is gone, the transcript is
         * gone, and what survives is a permanent note saying this task happened
         * and which folders it touched. Deleting the profile while keeping the
         * row was a mode that cleaned up everything except the evidence.
         *
         * Routed through the delete verb rather than reimplemented, so the
         * worktrees come off through git (an `rm -rf` strands a registration in
         * the source repo) and there is one description of what "gone" means.
         * The branch is still left, as `tasks.delete` documents: it lives in the
         * source repo and may carry commits, and destroying that is a larger act
         * than either verb was asked for.
         */
        if (found.incognito === true) {
          const gone = await commands.invoke(TASK_COMMANDS.delete, { task: found.id });
          if (!gone.ok) throw new Error(`could not delete incognito task ${found.id}: ${gone.error.message}`);
          return gone.value;
        }
        /*
         * Its work may ALREADY be on the shelf, and then this is the flip alone.
         *
         * The ordinary path for a task you have stopped looking at: closing its
         * panes shelved it, and you press Ship on that row later. Shelving twice
         * fails inside git — the worktree directory is gone, so `write-tree` has
         * nothing to run against and `archiveWorktree` reports "could not write
         * the archive commit". Found by the smoke, which has real worktrees; no
         * unit test could have, which is the argument for that smoke existing.
         */
        const warnings = isShelved(found) ? [] : (await shelve(found)).warnings;
        const latest = store.get(found.id) ?? found;
        store.put({ ...latest, lifecycle: 'archived', archivedAt: ctx.clock.now() });
        /*
         * Shipping an incognito task is the end of its session, so its profile
         * goes now rather than at delete.
         *
         * The consequence is deliberate and is the feature: **an incognito task
         * cannot be restored with its agents resumed.** A resume replays a
         * transcript, the transcript lived in the profile, and keeping the
         * profile so that Restore could work would mean keeping exactly what the
         * user asked to have deleted. Restore still returns the worktrees and the
         * branch — the work — and opens a fresh agent on them.
         */
        forgetProfile(latest);
        changed();
        return { id: found.id, lifecycle: 'archived', warnings };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.restore, {
      schema: s.object({ task: s.string() }),
      /**
       * Put the work back: disk, git, panes, and each agent's resume line.
       *
       * **The only thing that materializes a task.** `tasks.reveal` used to do it
       * as a side effect of being clicked, so reading three-week-old work
       * re-provisioned git for it; the two are separate now and this is the half
       * that costs something.
       *
       * The lifecycle flip is CONDITIONAL, and that is the difference between the
       * two shelved states. A shipped task is being un-shipped, so it goes back to
       * `running` and is dated — `activatedAt` is what makes it land at the BOTTOM
       * of the active list, since you pulled it back because you are working on it
       * now, and sorting by `createdAt` would file three-week-old work above
       * everything current. A task that was merely shelved never left that list,
       * and dating it would shuffle a row for a reason the user did not give.
       *
       * Optimistic: the record flips first so the row moves immediately, and the
       * git work follows behind a `busy` mark.
       */
      handler: (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        const shipped = task.lifecycle === 'archived';
        if (shipped) {
          store.put({ ...task, lifecycle: 'running', activatedAt: ctx.clock.now() });
          changed();
        }
        void whileBusy(task.id, 'restoring', async () => {
          /*
           * The snapshot roots go FIRST.
           *
           * They hold this task's own tab ids, and `layout.openRoot` is
           * idempotent — rebuilding into them would find roots that already have
           * panes and hand back the READ-ONLY ones. The restore would then
           * finish with nothing live on screen and no error anywhere.
           */
          await closeSnapshotTabs(task);
          await materialize(task);
        }).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: restoring threw — ${String(error)}`);
        });
        return { id: task.id, lifecycle: shipped ? 'running' : task.lifecycle };
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
   * A `tasks.cardFacts` provider saying its answer moved.
   *
   * The other half of that point — the rail re-reads and every provider is asked
   * again. Subscribing is membership-gated only and adds a READER, so the
   * single-writer rules elsewhere are untouched: nothing here learns what the
   * fact was, only that there is something new to ask for.
   */
  ctx.subscriptions.push(events.on(CARD_FACTS_CHANGED_TOPIC, () => changed()));

  /**
   * Which tasks are showing ALL of their tabs.
   *
   * In memory and never stored, like `provisioning` beside it: it is a property
   * of a list somebody is looking at right now, and after a restart there is
   * nothing expanded because nobody has expanded anything.
   */
  const tabsExpanded = new Set<string>();

  /**
   * What is in the sidebar's search box.
   *
   * In memory and never stored, like `tabsExpanded` beside it: it is a property of
   * a list somebody is looking at right now, and after a restart nobody has typed
   * anything.
   */
  let query = '';

  /**
   * What the transcript provider last said, and which query it was answering.
   *
   * Held beside `query` and never stored, for `query`'s own reason: it is a
   * property of a list somebody is looking at right now. `hitsFor` is what makes
   * a stale answer visible — a count drawn from the previous query is worse than
   * no count, because it is a number you would believe.
   */
  let hits: readonly TranscriptHit[] = [];
  let hitsFor = '';
  let searching: AbortController | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  /**
   * Each task's directories — its root, and one worktree per repo beneath it.
   *
   * Built from `rootOf`, which is the ONE derivation of a task root in this file
   * (D1b: an extension cannot resolve a path, so `ctx.dataDir` is the host's
   * answer and a second derivation would be a second chance to be wrong).
   */
  const taskDirs = (): ReadonlyMap<string, readonly string[]> =>
    new Map(
      store.list().map((task) => {
        const root = rootOf(task);
        return [task.id, [root, ...task.repos.map((repo) => `${root}/${repo.name}`)] as const];
      }),
    );

  /**
   * Ask the provider, debounced, and redraw when the answer lands.
   *
   * **The title filter never waits on this.** Fuzzy matching over titles is
   * synchronous and instant, so the rows render on the keystroke and the count
   * row appears a beat later. A search that blocked the filter would make every
   * keystroke as slow as the disk — which is the whole reason the results live in
   * an overlay rather than in the rail.
   */
  const searchTranscripts = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    searching?.abort();

    if (query === '') {
      hits = [];
      hitsFor = '';
      return;
    }

    debounce = setTimeout(() => {
      // Read at call time, not at activation: a provider registers when its
      // extension activates, which may be after this one did.
      const provider = transcripts.first();
      if (provider === undefined) return;

      const asked = query;
      const controller = new AbortController();
      searching = controller;

      provider
        .search({ query: asked, dirs: [...taskDirs().values()].flat(), signal: controller.signal })
        .then((answer) => {
          // A superseded keystroke's answer must not overwrite a newer one — the
          // abort is advisory, and a provider is free to resolve anyway.
          if (controller.signal.aborted || asked !== query) return;
          hits = answer;
          hitsFor = asked;
          changed();
        })
        .catch((error: unknown) => {
          // A provider that throws is a degraded search, not a broken rail.
          ctx.log.warn(`transcript search failed: ${String(error)}`);
        });
    }, 120);
  };

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.filter, {
      // No title — see the manifest. This is a field reporting its contents, not
      // a verb anybody picks.
      schema: s.object({ query: s.string() }),
      handler: (args) => {
        const next = args.query.trim();
        if (next === query) return { query };
        query = next;
        changed();
        searchTranscripts();
        return { query };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.linkPatterns, {
      // No title, for `filter`'s reason: it answers a page's question and is not
      // a verb anybody would pick out of a palette.
      schema: s.object({}),
      handler: () => {
        // Deduplicated: two providers claiming the same shape is a legitimate
        // thing to have done, and this list is walked on every paste.
        //
        // The vendor is part of the key, so the same shape claimed for two
        // different vendors survives as two entries rather than one of them
        // being drawn in the other's colour. Which of the two a pill wears is
        // then the renderer's first-match, and the resolver's answer overrides
        // it either way.
        const seen = new Set<string>();
        const patterns: PastedLinkPattern[] = [];
        for (const provider of pastedLinks.all()) {
          for (const pattern of provider.patterns) {
            const key = `${pattern.hostSuffix}|${pattern.pathPrefix}|${pattern.query ?? ''}|${pattern.vendor}`;
            if (seen.has(key)) continue;
            seen.add(key);
            patterns.push(pattern);
          }
        }
        return { patterns };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.resolveLink, {
      schema: s.object({ url: s.string() }),
      handler: async (args) => {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), RESOLVE_LINK_DEADLINE_MS);
        try {
          for (const provider of pastedLinks.all()) {
            try {
              const answer = await provider.resolve(args.url, deadline.signal);
              if (answer !== null) return answer;
            } catch (error: unknown) {
              // A vendor that failed leaves a pill wearing its fallback label,
              // which is a state the composer already draws — so this is a line
              // in the log rather than anything the person writing a brief sees.
              ctx.log.warn(
                `a ${PASTED_LINK_POINT} provider threw and was skipped — ${String(error)}`,
              );
            }
          }
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.transcriptHits, {
      // No title, for `filter`'s reason: it answers a page's question and means
      // nothing without a query somebody has typed.
      schema: s.object({}),
      handler: () => {
        // Only ever the CURRENT query's hits. Answering with the previous
        // query's would fill the overlay with rows that do not match the field
        // it opened with.
        const current = hitsFor === query ? hits : [];

        /**
         * **The join a provider cannot do.**
         *
         * A `TranscriptHit` names a directory and a session and stops there — it
         * comes from a reader that must not know what a task is (D11). Which task
         * that directory belongs to, what that task is called, and what state it
         * is in are all facts THIS extension holds, so they are attached here.
         *
         * Without it the overlay drew the SESSION's own title on every row, which
         * for three matches in one session is the same words three times and
         * never once the name of the work. And a state mark beside a session
         * title would be a task's state drawn next to something that is not the
         * task.
         */
        const dirsOf = taskDirs();
        const enriched = [...hitsByTask(current, dirsOf)].flatMap(([taskId, taskHits]) => {
          const task = store.get(taskId);
          // A task deleted between the search and this call: its hits are dropped
          // rather than drawn under a row nothing can open.
          if (task === undefined) return [];
          const mark = markFor(task, displayState(task.lifecycle, agentStatesOf(task)));
          return taskHits.map((hit) => ({ ...hit, task: task.title, mark }));
        });

        return { query, total: totalMatches(current), hits: enriched };
      },
    }),
  );

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
  /**
   * A git branch name, conservatively.
   *
   * Not `git check-ref-format`'s whole grammar: this is a name a person or an
   * agent types for a branch we made, and the shapes it excludes are the ones
   * that turn a rename into an argument git reads as a flag (`-rf`), a ref
   * nobody meant (`a..b`), or a path (`../etc`).
   */
  /** A local branch rename is instant; this is a hang guard, not an expectation. */
  const RENAME_TIMEOUT_MS = 30_000;

  const BRANCH_NAME = /^[a-z0-9][a-z0-9._\-/]*$/i;
  const legalBranch = (name: string): boolean =>
    BRANCH_NAME.test(name) && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('/');

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.renameBranch, {
      title: 'Tasks: Rename the Branch',
      schema: s.object({ task: s.optional(s.string()), name: s.string() }),
      /**
       * Scoped to the caller's own task, exactly as `tasks.spawn` is: the kernel
       * authenticates the caller KIND, and which task a session belongs to is a
       * question only this extension can answer.
       *
       * **Nothing is written to the record.** Git holds the branch, so a rename
       * through this verb and one typed by hand in a terminal are the same event
       * — and a stored copy would be a claim about somebody's repository that
       * goes stale the first time they disagree.
       */
      handler: async (args, caller) => {
        const owning = caller.kind === 'agent' ? taskOfSession(store, caller.sessionId) : undefined;
        if (caller.kind === 'agent' && owning === undefined) {
          throw new Error('this session does not belong to a task, so it has no branch to rename');
        }
        const id = args.task ?? owning?.id;
        if (id === undefined) throw new Error('no task named, and the caller is not in one');
        if (owning !== undefined && id !== owning.id) {
          throw new Error(`a session in task ${owning.id} may not rename task ${id}'s branch`);
        }
        const task = store.get(id);
        if (task === undefined) throw new Error(`no task ${id}`);

        const name = args.name.trim();
        if (!legalBranch(name)) throw new Error(`"${name}" is not a branch name`);

        const root = rootOf(task);
        const process_ = api.proposed.process;

        // Every repo is asked BEFORE any is touched. A half-renamed task is two
        // branches, and one task keeping one branch name is the property the
        // `taskProvisioned` fact rests on.
        const refs = await Promise.all(
          task.repos.map((repo) => readRepoRefs(process_, { name: repo.name, path: repo.path })),
        );
        if (branchTaken(name, refs)) {
          throw new Error(`"${name}" is already a branch in one of this task's repos`);
        }

        const renamed: string[] = [];
        const failed: string[] = [];
        let from = task.slug;
        for (const repo of task.repos) {
          const cwd = `${root}/${repo.name}`;
          const head = await process_.gitRead(['symbolic-ref', '--short', 'HEAD'], { cwd, timeoutMs: RENAME_TIMEOUT_MS });
          if (!head.ok) {
            // `symbolic-ref` rather than `rev-parse --abbrev-ref`: the second
            // answers the literal string `HEAD` on a detached head, which is a
            // branch name git would happily rename to.
            failed.push(`${repo.name}: ${head.stderr.trim() || 'not on a branch'}`);
            continue;
          }
          from = head.stdout.trim();
          if (from === name) {
            renamed.push(repo.name);
            continue;
          }
          const out = await process_.gitWrite(['branch', '-m', from, name], { cwd, timeoutMs: RENAME_TIMEOUT_MS });
          if (out.ok) renamed.push(repo.name);
          else failed.push(`${repo.name}: ${out.stderr.trim() || `git exited ${out.code}`}`);
        }

        // Reported, never rolled back (D15): a rename that succeeded is not a
        // thing to undo behind the user's back, and the next read of git
        // describes whatever is actually there.
        if (failed.length > 0) ctx.log.warn(`task ${task.id}: rename incomplete — ${failed.join('; ')}`);
        else ctx.log.info(`task ${task.id}: branch is now ${name}`);
        changed();
        return { id: task.id, from, to: name, renamed, failed };
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
              /*
               * **An incognito task's branch goes too; every other task keeps
               * its own.**
               *
               * The branch was the last thing that outlived such a task — a name
               * sitting in the user's repo saying this work happened. What is
               * NOT touched is the remote: anything pushed is the user's own
               * copy, on a machine that is not this one, and Shepherd deleting
               * it would be reaching well past the task it was asked to remove.
               * So pushed work survives and unpushed work does not, which is the
               * trade `deleteBranch`'s `-D` states outright.
               *
               * Reported, never fatal: a branch that will not come off (checked
               * out somewhere else, most likely) leaves the task deleted and the
               * branch named in the answer, exactly as an ordinary task's is.
               */
              if (task.incognito === true) {
                const branch = await deleteBranch(api.proposed.process, repo.path, out.branch);
                if (!branch.ok) failed.push(`${repo.name}: ${branch.reason}`);
                else if (out.branch !== null) ctx.log.info(`task ${task.id}: deleted branch ${out.branch} in ${repo.path}`);
              } else if (out.branch !== null) {
                kept.push(`${repo.name}: ${out.branch}`);
              }
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

        // Before the record goes: the record is the only thing that knows this
        // task was incognito, and a profile whose task has been forgotten is
        // findable only by the startup sweep.
        forgetProfile(task);
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
    views.registerViewType(TASK_VIEWS.sessionSearch, {
      kind: 'component',
      component: TASK_VIEWS.sessionSearch,
      /*
       * An overlay for the composer's reason: you raise it, read it and dismiss
       * it. Parked in the rail it would be a results list competing with the task
       * list for a 264px column, which is the arrangement this whole design
       * exists to avoid.
       */
      surface: 'overlay',
      /*
       * ⇧⌘F, and the two keys it is deliberately NOT.
       *
       * ⌘F stays pane-local: `find-bar.tsx` argues that a find spanning panes
       * would answer with a count across screens you cannot see, and taking it
       * here would delete that gesture from every terminal in the app. ⌘K is
       * commands. ⇧⌘F is what every editor binds to "find across everything", so
       * it is the one gesture a person arrives already knowing.
       *
       * Note what this is NOT bound to: focusing the rail's search field. If
       * clicking into that field raised this, the rail would have no filter at
       * all — and filtering titles in place is the thing you do most.
       */
      key: 'CmdOrCtrl+Shift+F',
      title: 'Session search',
    }),
  );

  ctx.subscriptions.push(
    views.registerViewType(TASK_VIEWS.tree, {
      kind: 'tree',
      title: 'Tasks',
      /*
       * The rail asks for a search field and answers it itself. It has to be this
       * way round: the shell only ever holds the rows this provider chose to send,
       * so a page-side filter could not reach a shipped task past `SHIPPED_CAP`,
       * and `collapsed` is set here, so it could not open a match to its tabs.
       */
      search: { command: TASK_COMMANDS.filter, placeholder: 'Search' },
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
           * `elapsedMs` is the sharpest case: the first time a task is seen it is
           * absent rather than zero, because a task that was already waiting when
           * the app started has been waiting longer than we know.
           */
          /**
           * Which line the row's slot gets, per state. See the note at the call.
           *
           * Returns a SPREADABLE object rather than a string, so "there is no
           * summary" is a field that is absent rather than one that is empty —
           * the card's own rule, and what stops an empty string drawing a blank
           * meta line.
           */
          const summaryFor = (task: TaskRecord, state: string): { summary?: string } => {
            /*
             * `blocked`, not `waiting` — the writer's vocabulary, not the mark's.
             * This read `state === 'waiting'` and so never fired at all: the mark
             * is `waiting`, the STATE is `blocked`, and `markFor` is the map
             * between them. It looked correct because the branch it fell through
             * to also answered nothing.
             *
             * The word rather than the last thing said: an agent that is asking
             * you something last SPOKE at the end of its previous turn, which is
             * stale, and the question itself is the card's own block below.
             */
            if (state === 'blocked') return STATE_WORD_OF(state);
            if (state === 'working') {
              const brief = task.brief.trim();
              return brief === '' ? STATE_WORD_OF(state) : { summary: brief };
            }
            const said = saids.get(task.id);
            if (said === undefined || said === '') return STATE_WORD_OF(state);
            /*
             * **Never the row's own label.** §6 refuses repeating a name down the
             * hierarchy, and a summary identical to the title is that: the same
             * words drawn twice, one under the other, in a rail whose whole
             * argument is that a row says one thing.
             *
             * Not hypothetical — measured against eight real transcripts, two
             * ended on a line that was exactly the task's title. A short session
             * whose last assistant record is the title Claude Code minted for it
             * is indistinguishable, from here, from one that said something.
             */
            return said.trim().toLowerCase() === task.title.trim().toLowerCase()
              ? STATE_WORD_OF(state)
              : { summary: said };
          };

          const cardFor = (task: TaskRecord, state: string, count?: number, stage?: string): unknown => {
            const factsOf = factsFor(task);
            return {
            mark: markFor(task, state),
            /*
             * Which of your tasks is the quiet one.
             *
             * A property of the task rather than a state of it, so it rides
             * BESIDE the mark and never as one — the card draws it in the meta
             * line's reserved gutter, and §5's five states stay five. Absent on
             * an ordinary task, so the row carries no key for the common case.
             */
            ...(task.incognito === true ? { incognito: true } : {}),
            /*
             * The step this task is on, while it is being built.
             *
             * BESIDE the label rather than replacing it — a row that said
             * `Creating the worktree` where its name goes was answering the wrong
             * question — and beside rather than under, because §10 refuses a row
             * that grows to say something. Absent the moment the work ends, which
             * is what makes its disappearance the "ready" signal.
             */
            ...(stage === undefined ? {} : { stage }),
            /*
             * **There is no time stamp on a task row, and that is the third answer
             * rather than an omission.**
             *
             * It was `formatElapsed(task.createdAt)` on every row, live and shipped
             * alike, which on finished work reported task AGE: begun three weeks
             * ago, shipped ten minutes ago, and the row said `21d`. It became a
             * `16:40` clock off `archivedAt` on shipped rows, which was at least
             * true of the right event. It is now gone from both regions, because
             * true is not the same as worth a column.
             *
             * What the trailing cell holds instead is the row's ONE verb — `Ship`
             * on live work, `Unship` on finished — revealed on hover. That cell was
             * always shared (§6: a row must not grow to reveal its actions), so the
             * stamp and the button were never on screen together anyway: the stamp
             * hid the moment you reached for the thing you could actually do.
             *
             * What time it is remains answerable where it is cheap. The Shipped
             * region carries a day header, which says "when" once for a whole group
             * instead of once per row; a live task's own panes and its agent say
             * what is happening far better than a minute counter does.
             */
            /*
             * How many tasks this row stands for, when it is more than one.
             *
             * Absent at 1, so the card's test is presence rather than `> 1` — and
             * absent entirely on live work, where two tasks of the same name are
             * two things you are separately doing and collapsing them would hide
             * one you might need to answer.
             */
            ...(count !== undefined && count > 1 ? { dupe: count } : {}),
            /*
             * Shipped rows are DIMMED and one line — the whole reason finished
             * work can sit permanently in the rail without costing attention.
             *
             * Everything below describes live work: a diff is what a worktree
             * currently holds, a repo chip is somewhere you can go, a suite result
             * is a run that just happened. None of it is true of a task whose
             * checkouts are a snapshot, so the flag suppresses all of it rather
             * than each field going quietly absent for its own reason.
             */
            ...(task.lifecycle === 'archived' ? { shipped: true } : {}),
            /*
             * ABOVE the `shipped` suppression, deliberately, and it is the only
             * thing that is.
             *
             * Everything below this line describes live work, which is why one
             * flag can suppress all of it. A fact is not that: the motivating one
             * is a merged PR number, and `v2 #309` beside a shipped task is the
             * record of what shipped — the single most durable thing a finished
             * row can say. A provider that has nothing to say about finished work
             * is told (`CardFactSubject.shipped`) and answers `null`.
             */
            ...(factsOf.length === 0 ? {} : { facts: factsOf }),
            suite: suites.get(task.id),
            /*
             * **The second line's changing slot** — the one that finishes the
             * sentence the mark starts.
             *
             * WORKING shows the brief, not the last line. Mid-turn the last line
             * is the PREVIOUS turn's ending, which is stale exactly while the
             * task is most active; the brief is what you asked for and cannot go
             * stale. Working answers "on what", and the brief is that answer.
             *
             * WAITING shows nothing. A waiting card opens with the question and
             * its two answers inline, so saying it again above them would be the
             * same words twice in one card.
             *
             * Everything else shows what the agent last said, which is where
             * "with what result" and "why" live.
             */
            ...summaryFor(task, state),
            /*
             * Suppressed on a shipped row with everything else that describes
             * live work — "archived 3d" is a fact about a record, not about
             * something you could act on, and the Shipped region already answers
             * "when" once per day in its own headers.
             */
            ...(task.lifecycle === 'archived' ? {} : elapsedFor(task.id, state)),
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
            };
          };

          // The surface that wants the line pays for it — see `refreshSaids`.
          refreshSaids();

          const all = store.list();
          if (all.length === 0) {
            // The empty state is the SHELL's, not a fake row: a list saying
            // "no tasks yet" in the shape of a task is a row you can click.
            return Promise.resolve([]);
          }

          /**
           * **Two regions: not shipped, and shipped.** Nothing else.
           *
           * This replaced `Waiting on you` / `In flight` / `Resting`, and the
           * replacement is a product decision rather than a tidy-up — read that
           * before restoring them, because this file has flipped on the question
           * once already and left both sides' comments behind.
           *
           * Those sections ordered live tasks by *distance from needing you*,
           * which is the app having an opinion about what matters. The position
           * taken here is that the status dot already carries that, an active list
           * is a handful of rows, and scanning a handful of rows for a colour is a
           * glance. The cost is real and was accepted: a blocked task in a list of
           * fifteen is row nine with an amber dot, and nothing floats it. Do not
           * reintroduce a blocked-first exception — a row that moves when its
           * state changes is exactly what the append order exists to prevent.
           *
           * The shipped half is no longer a count behind a chevron either. It is a
           * region of dimmed rows you can read, search and un-ship from.
           */
          /**
           * The search, applied to both regions.
           *
           * Fuzzy over the title AND the repo names, because a task is often
           * remembered by the repo it was in — `railsapp` finds every task that
           * touched it. Same `fuzzyFilter` the ⌘K palette uses, so one query
           * behaves the same way in both places.
           *
           * `fuzzyFilter` returns best-match-first, which is the wrong order for
           * a rail whose whole promise is that rows do not move. So the matches
           * are collected as a SET and each region keeps its own order — the
           * filter decides which rows, never where they sit.
           */
          const matching =
            query === ''
              ? undefined
              : new Set(
                  fuzzyFilter(query, all, (task) => `${task.title} ${task.repos.map((r) => r.name).join(' ')}`).map(
                    (task) => task.id,
                  ),
                );
          const shown = matching === undefined ? all : all.filter((task) => matching.has(task.id));

          const live = activeOrder(shown.filter((task) => task.lifecycle !== 'archived'));
          const done = shippedOrder(shown.filter((task) => task.lifecycle === 'archived'));

          const rows: TreeItemOut[] = [];
          /**
           * A row, and for a shipped one how many tasks it stands for.
           *
           * `count` is decided by the GROUPING rather than by the task — it is a
           * property of the day-bucket the row collapsed within — so it is passed
           * in. That is what keeps a row standing for two tasks from being
           * something this function could produce by accident.
           */
          const rowFor = (task: TaskRecord, count?: number): TreeItemOut => {
            const state = displayState(task.lifecycle, agentStatesOf(task));
            const busyWhat = busy.get(task.id);
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
              /*
               * "Not ready" is the predicate the comment above always claimed and
               * the code did not have: `ready` stays in the map for the life of
               * the task, so a landed repo kept the row saying `ready app…` —
               * a done thing wearing an ellipsis. Nothing caught it because the
               * busy spread below used to overwrite this line before it was drawn.
               */
              const state = provisioning.get(key);
              return (state !== undefined && state !== 'ready') || hookIssue.get(key) !== undefined;
            });
            const repoNote =
              pending === undefined
                ? undefined
                : hookIssue.get(`${task.id}:${pending.name}`) !== undefined
                  ? `${pending.name} — hook failed`
                  : `${provisioning.get(`${task.id}:${pending.name}`) ?? 'provisioning'} ${pending.name}…`;
            // Beside the name, not instead of it — see `stepLabel`.
            const step = busyWhat === undefined ? undefined : stepLabel(busyWhat, task);
            /*
             * The same fact, in the field the ORDINARY row draws.
             *
             * A contributed card reads `label` and `data`; a plain `TreeItem` —
             * the fallback, and what a remote member's own sidebar draws — reads
             * `label` and `description`. So the operation goes in both, and the
             * duplication is deliberate rather than sloppy: it is one word on the
             * one surface that shows both, and the alternative is a build without
             * `tasks.card` saying nothing at all. Gating this on the card's needs
             * is what put the archiving row in that state for a whole ship.
             */
            const busyNote = busyWhat === undefined ? undefined : `${busyWhat}…`;
            const shipped = task.lifecycle === 'archived';
            /*
             * An ACTIVE task whose work is on the shelf, which is a state that did
             * not exist before: closing a task's panes reclaims its worktrees now
             * without shipping it.
             *
             * Said in words rather than given a mark of its own. Nothing is
             * happening to it, which is what the resting dot already means, and a
             * colour cannot carry "your code is in a snapshot, not a directory".
             */
            const shelvedNote = !shipped && isShelved(task) ? 'shelved' : undefined;
            const mark = markFor(task, state);
            const liveAgent =
              !shipped && (mark === 'working' || mark === 'waiting' || mark === 'ready');
            return {
              id: task.id,
              label: task.title,
              description: [
                // The operation displaces the STATE rather than joining it: a row
                // that says `idle · archiving…` is answering the same question
                // twice and disagreeing with itself.
                busyNote ?? (issue === undefined ? state : `${state} — set hook failed`),
                ...(shelvedNote === undefined ? [] : [shelvedNote]),
                ...(repoNote === undefined ? [] : [repoNote]),
                /*
                 * A collapsed row says so IN WORDS, because it is the one row in
                 * the rail that stands for more than one task.
                 *
                 * The card draws a `×2` badge, but this is the field that reaches
                 * the row's tooltip and a remote member's own sidebar — and "this
                 * line is two things" must not be a fact that exists only in our
                 * renderer. Clicking still opens the most recent of them, which is
                 * what the count is there to disclose.
                 */
                ...(count !== undefined && count > 1 ? [`${count} tasks`] : []),
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
              /*
               * A shipped row has no chevron, because it has nothing to open. Its
               * tabs were captured into the record and closed when it was shelved,
               * so a disclosure triangle there would expand to an empty list —
               * `capTabRows` reads the LIVE tabs, and a shipped task has none.
               *
               * A row that MATCHES a search is drawn open, so a hit on a multi-repo
               * task shows the tabs and you can go straight to the right pane
               * rather than clicking the row to find out what is in it. This is the
               * one place the query touches the row's shape, and it is the reason
               * the query has to live in the extension: `collapsed` is ours.
               */
              ...(shipped ? {} : { collapsed: matching === undefined }),
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
              data: cardFor(task, state, count, step),
              /*
               * Something is happening to it right now — a snapshot being taken,
               * worktrees being rebuilt. The row says so where its status mark is,
               * rather than looking idle for the seconds git takes.
               *
               * It no longer REPLACES the description, and that is a fix: this
               * spread sits after `description` above, so writing one here
               * overwrote it — and `repoNote`, the `working api…` the block above
               * goes to the trouble of composing, could never appear. `busy`
               * covers the whole of provisioning, which is precisely when a repo
               * is landing, so the two were never on screen at the same time and
               * the note was dead code wearing a comment about being useful. The
               * step is the LABEL now, so nothing here needs to say it.
               */
              ...(busy.has(task.id) ? { busy: true } : {}),
              /*
               * Clicking a task takes you to it, whatever region its row is in.
               * For one whose work is on the shelf that means putting the
               * worktrees back first (see `tasks.reveal`) — and NOT moving the
               * row: looking at shipped work must not un-ship it.
               */
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
               * The ONE verb worth a button, and each region gets its own: ship
               * the thing you are finished with, un-ship the thing you are not
               * after all. Both were buried in a context menu nobody discovers by
               * looking, and shipping is the gesture made most.
               *
               * The pair is deliberately symmetrical — same slot, same hover, one
               * click each — because they undo one another and an undo that is
               * harder to reach than the action reads as a one-way door.
               */
              primaryAction: shipped
                ? {
                    id: TASK_COMMANDS.restore,
                    label: 'Unship',
                    icon: 'unship',
                    args: { task: task.id },
                  }
                : {
                    id: TASK_COMMANDS.archive,
                    // The verb says what the press DOES. On an incognito task
                    // this command deletes rather than shelves, and a button
                    // labelled Ship over that is the same lie the ship's-wheel
                    // glyph was.
                    label: task.incognito === true ? 'Delete' : 'Ship',
                    /*
                     * A TRASH glyph on an incognito task, and the same verb.
                     *
                     * Shipping an ordinary task shelves work you can come back
                     * to — that is what a ship's wheel promises, and on an
                     * incognito task it promises the wrong thing: shipping
                     * deletes the profile, so the transcript, the history and
                     * the whole session go with it. The command, the label and
                     * the one click are unchanged, because it IS the same verb;
                     * only the picture stops saying "safely stowed".
                     *
                     * Not `danger: true`. Red is for the verb that destroys the
                     * TASK, and this one still leaves a row in Shipped — a
                     * second red action on the row would make the two look
                     * equally final when only one of them is.
                     */
                    icon: task.incognito === true ? 'trash' : 'ship',
                    args: { task: task.id },
                    /*
                     * Instant when nothing is running, and a question when
                     * something is.
                     *
                     * Shipping closes the task's panes, which kills a mid-turn
                     * agent — so the one case worth interrupting is the one where
                     * a misclick throws away work in progress. Everything else
                     * ships on a single click, because this is the gesture made
                     * most and a confirm on all of it would be a dialog nobody
                     * reads by the third time.
                     *
                     * `waiting` and `ready` both count as live: an agent sitting
                     * on a question, or on a turn you have not read, is one turn
                     * from continuing, and shipping it discards the answer you
                     * were about to give.
                     */
                    ...(liveAgent ? { confirm: shipConfirm(task, state) } : {}),
                  },
              /*
               * The row's right-click menu. Declared HERE because the shell
               * cannot know a task's verbs — a sidebar that hardcoded Reveal /
               * Ship / Delete would be a sidebar that knows what a task is,
               * which is the special case ADR 0031 exists to prevent.
               *
               * Each entry is a command id plus the args naming WHICH task, the
               * same shape `command` above uses, and each runs attributed to this
               * extension rather than to the user (D14) — so `tasks.delete` from
               * a menu is authorized exactly as `tasks.delete` from the CLI is.
               *
               * A shipped task offers Unship where an active one offers Ship: the
               * verb that is available is the one that changes its state, and
               * offering "Ship" on something already shipped is an item that
               * either fails or does nothing.
               */
              actions: [
                {
                  id: TASK_COMMANDS.reveal,
                  label: 'Reveal',
                  icon: 'eye',
                  args: { task: task.id },
                },
                { separator: true },
                /*
                 * An ACTIVE task whose work is on the shelf has one verb the
                 * others do not: put it back.
                 *
                 * Its `primaryAction` stays Ship — that is the gesture made most
                 * on a row you have stopped looking at — so this lives in the
                 * menu, where the shipped row's own Unship button already points
                 * at the same command. Revealing it now shows a snapshot, so
                 * without this the only way back to a live worktree on an active
                 * task would be to ship it and un-ship it again.
                 */
                ...(!shipped && isShelved(task)
                  ? [
                      {
                        id: TASK_COMMANDS.restore,
                        label: 'Restore work',
                        icon: 'unship',
                        args: { task: task.id },
                      },
                      { separator: true } as const,
                    ]
                  : []),
                shipped
                  ? {
                      id: TASK_COMMANDS.restore,
                      label: 'Unship',
                      icon: 'unship',
                      args: { task: task.id },
                    }
                  : {
                      id: TASK_COMMANDS.archive,
                      label: task.incognito === true ? 'Delete' : 'Ship',
                      // The same swap the hover button makes, so the two doors
                      // onto one verb do not disagree about what it does.
                      icon: task.incognito === true ? 'trash' : 'ship',
                      args: { task: task.id },
                    },
                /*
                 * ONE destructive verb on an incognito row.
                 *
                 * The row above already IS the delete for such a task, so
                 * listing this too would draw the same act twice under one
                 * word — and the two would differ only in that one is red.
                 */
                ...(task.incognito === true
                  ? []
                  : [
                      {
                        id: TASK_COMMANDS.delete,
                        label: 'Delete',
                        icon: 'trash',
                        danger: true,
                        args: { task: task.id },
                      },
                    ]),
              ],
            };
          };

          // The active list, appended to and never re-ordered — and with NO
          // heading. The Shipped divider below is the rail's only structure, and
          // a second heading over "everything else" would name the obvious.
          for (const task of live) rows.push(rowFor(task));

          /*
           * **Shipped is a region, drawn only when there is something in it.**
           *
           * It was one row pinned to the window bottom with `foot: true`, holding
           * a count and a drawer. Two things changed: finished work is worth
           * seeing (dimmed, so it costs no attention), and the block now FLOWS
           * after the active list rather than being nailed to the bottom — with
           * three tasks, a pinned foot left a window-height gap above it.
           *
           * `foot` itself is untouched and still supported by the dock. It is a
           * general `TreeItem` capability that tasks merely happened to be the
           * only user of, and removing a shell mechanism to change one
           * extension's layout is the wrong direction of blast radius.
           *
           * Drawn only when non-empty, which reverses the old rule that it be
           * drawn at zero. That rule existed so the pinned foot would not appear
           * and disappear under the cursor; a divider that flows after the list
           * has nothing to hold still, and `Shipped 0` is a heading over nothing.
           */
          if (done.length > 0) {
            /*
             * **A search is never capped.** Reaching the fortieth shipped task is
             * exactly what the field is for, so a cap here would turn it into a
             * dead end — you would type the name of something you shipped and be
             * told to press "Show all" to find out whether it was there.
             */
            const showingAll = matching !== undefined || tabsExpanded.has(SHIPPED_KEY);
            /*
             * **Capped in TASKS, then grouped into rows** — that order, and it is
             * the reason day headers cost no work off the region.
             *
             * `SHIPPED_CAP` has always counted tasks, so eight tasks are kept and
             * then drawn as however many rows they collapse to: eight tasks in
             * seven rows plus two day labels, where a cap on ROWS would make the
             * number of tasks on screen depend on how many happened to share a
             * name and leave `hidden` wrong by the difference.
             *
             * Only rail HEIGHT pays for the labels, and two lines on a region you
             * chose to keep permanently is the cheapest thing in it.
             */
            const { shown: shippedTasks, hidden } = capShipped(done, SHIPPED_CAP, showingAll);
            rows.push({
              id: SHIPPED_KEY,
              label: 'Shipped',
              // The TRUE total, not the number of rows under it: a count that
              // agreed with the visible rows would make the hidden ones invisible
              // in both places at once.
              description: String(done.length),
              section: true,
            });
            /*
             * **Day headers, unconditionally** — not a threshold, not a setting.
             *
             * `16:40` is only unambiguous under a label naming the day, so the
             * header and the clock are one treatment rather than two behaviours
             * that could disagree; a region that grouped itself only past some
             * number of rows would be a state machine whose states are both worse
             * than either of them alone.
             *
             * The headers are ordinary `section` rows, nested — the shell draws
             * them a step quieter with no rule of their own. `groupByDay` walks the
             * order it is handed and never re-sorts, so introducing them cannot
             * move a row: the labels land BETWEEN rows that were already in the
             * order `shippedOrder` chose.
             */
            for (const day of groupByDay(shippedTasks, ctx.clock.now())) {
              rows.push({
                id: `${SHIPPED_KEY}:day:${day.label}`,
                label: day.label,
                /*
                 * **No count on a day.** `Shipped · 28` says how much there is;
                 * `Today · 4` beside it invites the reader to add the days up and
                 * find they do not reach 28, because the region is capped. The
                 * outer heading is the one that can afford a number, since it is
                 * the one telling the truth about the whole archive.
                 */
                section: true,
                subsection: true,
              });
              for (const row of day.rows) {
                rows.push(rowFor(row.task, row.count));
              }
            }
            /*
             * The rest, behind one row — and it reuses `expandTabs` rather than
             * adding a verb, because that command already means "this row is
             * showing a subset, toggle it" and already holds `SHIPPED_KEY` as one
             * of its keys.
             */
            if (matching === undefined && (hidden > 0 || showingAll)) {
              rows.push({
                id: `${SHIPPED_KEY}:more`,
                /*
                 * **The number you cannot get anywhere else.**
                 *
                 * This said `Show all 28`, which restates the total the divider
                 * two rows up already draws; the fact only this row can carry is
                 * how many are hidden. `20 more` is also shorter than the verb
                 * phrase, which matters for the one line in the region that is not
                 * a task title.
                 */
                label: showingAll ? 'Show fewer' : `${hidden} more`,
                /*
                 * **A control, drawn as chrome.** The ink ramp writes `textFaint`
                 * as "a control at rest", and the search field at the top of the
                 * rail already quotes that rule to sit a step under the rows. This
                 * row did not, so the quietest region of the rail ended in its
                 * loudest line — brighter than the task the user was mid-turn on.
                 *
                 * **No tint**, unchanged and for its own reason: a state mark here
                 * drew a shipped CHECK on something that is not a task.
                 */
                quiet: true,
                /*
                 * And no reserved slot either, because the region it closes has no
                 * state column: the shipped rows above it drop their mark, so a box
                 * held open here would indent this row 21px past every title it is
                 * offering to reveal. `Shipped`, the day labels, the titles and this
                 * all sit at one left edge.
                 */
                gutter: false,
                command: { id: TASK_COMMANDS.expandTabs, args: { task: SHIPPED_KEY } },
              });
            }
          }

          /**
           * **The one row that admits what the rail cannot show.**
           *
           * A transcript hit is four things — which task, which session, the line
           * that matched, and when — and it needs two lines and roughly 500px.
           * This column is 264px with a 21px-padded field, so a snippet indented
           * under a session gets ~31 characters against recall's 120: drawn here
           * it would truncate the exact string you searched for. So the rail
           * reports that the matches exist, and ⇧⌘F opens a surface that can hold
           * them.
           *
           * `foot`, so it sits at the physical bottom rather than merely last —
           * the shipped region grows and this must stay under it. `quiet` and no
           * `gutter`, for the two reasons the `n more` row above states.
           *
           * **Drawn only when the answer is for the query on screen.** A count
           * from the previous keystroke is a number you would believe.
           */
          if (query !== '' && hitsFor === query) {
            const total = totalMatches(hits);
            if (total > 0) {
              rows.push({
                id: 'transcripts',
                /*
                 * The label is duplicated in the component, and deliberately: this
                 * one is what a remote member draws in its own sidebar and what a
                 * screen reader announces, so it must stand alone in a build that
                 * has never heard of `tasks.transcriptCount`. Same contract as
                 * `label` on a task row that draws itself as a card.
                 */
                label: `${String(total)} in transcripts`,
                foot: true,
                quiet: true,
                gutter: false,
                component: TASK_VIEWS.transcriptCount,
                data: { total },
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
  /*
   * The minute hand.
   *
   * `waiting 14m` is a number that moves with no event behind it, so something
   * has to nudge the tree or the rail would show the duration a task had when it
   * last changed for some other reason. A minute is the cadence the number is
   * drawn at, so anything faster repaints for nothing.
   *
   * This REPLACED a 20s `git diff` across every repo of every live task. The
   * rail is cheaper than it was: a nudge is a re-render, where the thing it
   * replaced was a subprocess per repo per beat.
   */
  const minuteTimer = setInterval(() => changed(), 60_000);
  ctx.subscriptions.push(toDisposable(() => clearInterval(minuteTimer)));

  /**
   * Every incognito profile no task claims, deleted at startup.
   *
   * Teardown on ship and on delete is the ordinary path and it is not a
   * guarantee: a crash, a force-quit or a `kill -9` runs neither handler, and
   * what survives is precisely the transcript the user asked not to keep. So the
   * invariant is RESTATED here rather than trusted — a profile outlives its task
   * by at most one launch.
   *
   * Keyed on the record rather than on the lifecycle: an archived task still has
   * a record and its profile is already gone, so the sweep finds nothing for it
   * and the second `rm` never runs.
   */
  for (const dir of orphanProfiles(ctx.dataDir, store.list().map((entry) => entry.id))) {
    const removed = removeIncognitoProfile(dir);
    if (removed.ok) ctx.log.info(`swept an incognito profile no task claims: ${dir}`);
    else ctx.log.warn(removed.detail);
  }

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
      return 'waiting';
    /*
     * A square, like `waiting` — reading a finished turn is still your move —
     * but the GREEN one. The two shared `waiting` until now, which made a task
     * that had answered you indistinguishable from one that was asking.
     */
    case 'needsCheck':
    case 'needs-check':
      return 'ready';
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
