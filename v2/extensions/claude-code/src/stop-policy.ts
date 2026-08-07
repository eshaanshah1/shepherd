import type { AgentState, StateTransition } from '@shepherd/ext-agents-core/state';

/**
 * The Claude Code lifecycle map — v1's `StopPolicy`, ported.
 *
 * The single highest-value artifact carried over from v1 (the architecture review
 * says so), and it ports as what it always was: a **total function over values**.
 * No IO, no clock, no host. `viewing` is a parameter and stays one.
 *
 * Three behaviours in here look like bugs and are not. Each cost a real debugging
 * session in v1 and each has an ADR:
 *
 *   - **The ordering guard** (ADR 0004). Mid-turn events apply only while the
 *     session is `working`/`blocked`. A finished turn is left only by a new
 *     `UserPromptSubmit` or by focus. Hooks are not totally ordered — a slow
 *     `PreToolUse` can arrive after the `Stop` it preceded — and without this
 *     guard that stray event reopens a turn that has ended.
 *   - **Background-`Stop` suppression** (ADR 0015). Claude fires `Stop` when its
 *     synchronous loop ends, *even with a backgrounded agent still running*. A
 *     `Stop` the turn is paused on is a pause, not a finish.
 *   - **The viewing landing** (ADR 0020). `needsCheck` means *you have not seen
 *     this yet*, so a turn ending under the user's eyes lands `idle` directly.
 *     Without it the dot reads "done" until you click away and back, because the
 *     only clearing path fires on a focus *change*.
 */

/**
 * One hook event, already parsed.
 *
 * **`detail` no longer does double duty**, which is the one deliberate departure
 * from a mechanical port. In v1 `detail` was a single bash-produced string that
 * meant a tool name for one event and a *background-task count* for another —
 * exactly the one-field-two-jobs shape review §Ugly-4 objects to, and it existed
 * only because bash could not hand over structure. The v2 plugin ships the hook
 * payload whole and this package parses it (D11/D12), so the count is its own
 * typed field and `detail` is only ever the cosmetic name.
 */
export interface HookInput {
  /** The hook's name, e.g. `Stop`, `PreToolUse`. Decides almost everything. */
  readonly event: string;
  /** The cosmetic name: `tool_name`, `error_type`, `agent_type`. */
  readonly detail?: string;
  readonly current: AgentState;
  /** The reason already on the session, preserved when nothing sets a new one. */
  readonly reason?: string;
  /** From the ONE predicate (ADR 0020). Never recomputed in here. */
  readonly viewing?: boolean;
  /** How many background tasks the turn is paused on — see `backgroundTaskCount`. */
  readonly backgroundTasks?: number;
}

export function applyEvent(input: HookInput): StateTransition {
  const { event, current } = input;
  const detail = input.detail ?? '';
  const viewing = input.viewing ?? false;
  const background = input.backgroundTasks ?? 0;
  const midTurn = current === 'working' || current === 'blocked';

  const to = (state: AgentState, reason?: string): StateTransition =>
    transition({ state, reason, clearTitle: false, applied: true });
  /** The ordering guard's answer: nothing happened, so nothing may be written. */
  const ignore = (): StateTransition =>
    transition({ state: current, reason: input.reason, clearTitle: false, applied: false });

  switch (event) {
    // Drop the shell's title so the agent's own can replace it.
    case 'SessionStart':
      return transition({ state: 'idle', clearTitle: true, applied: true });
    case 'SessionEnd':
      return to('shell');
    // A new turn, from any state — the one event that escapes the guard.
    case 'UserPromptSubmit':
      return to('working');

    case 'Stop': {
      if (!midTurn) return ignore();
      if (background > 0) {
        return transition({
          state: 'working',
          reason: input.reason,
          clearTitle: false,
          applied: true,
          heldForBackground: true,
        });
      }
      return transition({
        state: viewing ? 'idle' : 'needsCheck',
        clearTitle: false,
        applied: true,
        turnFinished: true,
      });
    }

    // `blocked` and `error` ignore `viewing` deliberately: they want the user
    // whether or not they happen to be looking. An unanswered question does not
    // answer itself because the pane is on screen.
    case 'StopFailure':
      return midTurn ? to('error', detail === '' ? 'API error' : detail) : ignore();
    case 'PermissionRequest':
      return midTurn ? to('blocked', permissionReason(detail)) : ignore();
    case 'Elicitation':
      return midTurn ? to('blocked', 'input requested') : ignore();
    case 'SubagentStart':
      return midTurn ? to('working', detail === '' ? 'subagent' : `subagent: ${detail}`) : ignore();

    case 'PreToolUse': {
      if (!midTurn) return ignore();
      // Detected by the TOOL, not by a `Notification`/`Elicitation` that never
      // fires for it — ADR 0008.
      if (detail === 'AskUserQuestion') return to('blocked', 'answer needed');
      if (detail === 'ExitPlanMode') return to('blocked', 'plan approval');
      return to('working');
    }

    // A launched subagent is no longer special-cased and nothing counts events:
    // ADR 0014's launch-vs-stop counter was unreliable because they do not pair
    // 1:1 (measured: 1 Start, 6 Stops). Background-ness is read from `Stop`.
    case 'SubagentStop':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'ElicitationResult':
      return midTurn ? to('working') : ignore();

    default:
      return ignore();
  }
}

function permissionReason(detail: string): string {
  if (detail === 'ExitPlanMode') return 'plan approval';
  return detail === '' ? 'approval needed' : `approve ${detail}`;
}

/** Fills the defaults so every branch above stays one readable line. */
function transition(
  parts: {
    state: AgentState;
    reason?: string;
    clearTitle: boolean;
    applied: boolean;
    heldForBackground?: boolean;
    turnFinished?: boolean;
  },
): StateTransition {
  return {
    state: parts.state,
    ...(parts.reason === undefined ? {} : { reason: parts.reason }),
    clearTitle: parts.clearTitle,
    applied: parts.applied,
    heldForBackground: parts.heldForBackground ?? false,
    turnFinished: parts.turnFinished ?? false,
  };
}

/**
 * How many background tasks a `Stop` is paused on (ADR 0015).
 *
 * Claude Code v2.1.145+ puts `background_tasks` on the `Stop` payload precisely so
 * "the session is done" can be told from "the session is waiting on background
 * work". A backgrounded **subagent / workflow / shell** holds the turn; a passive
 * **monitor** does not, and that allow-list is the whole decision.
 *
 * In v1 this reduction ran in bash. It runs here now because the plugin sends the
 * payload whole (D11) — which means it is *tested*, where a `jq` filter in a shell
 * script never was.
 *
 * **Fail-safe, and that direction is deliberate**: anything unparseable counts as
 * zero, reverting to plain finish-on-`Stop`. The failure mode of guessing high is
 * a session stuck at `working` forever with no way out; guessing low costs one
 * premature "done" that the next event corrects.
 */
const HOLDING_TASK_TYPES = new Set(['subagent', 'workflow', 'shell']);

export function backgroundTaskCount(hook: unknown): number {
  if (typeof hook !== 'object' || hook === null) return 0;
  const tasks = (hook as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((task) => {
    if (typeof task !== 'object' || task === null) return false;
    const type = (task as { type?: unknown }).type;
    return typeof type === 'string' && HOLDING_TASK_TYPES.has(type);
  }).length;
}

/**
 * Whether a hook event belongs to the session that owns this pane.
 *
 * A nested `claude` — `claude -p …` that a top-level agent runs via Bash —
 * inherits `SHEPHERD_SESSION_ID`, so it fires hooks tagged with the **parent's**
 * Shepherd session while carrying its **own** Claude `session_id`. Unchecked, the
 * child's `Stop` flips the parent to need-to-check mid-turn and its `SessionStart`
 * clobbers the parent's resume id.
 *
 * A session locks to the first Claude session that sends `SessionStart`, and only
 * that one counts until `SessionEnd` releases the lock.
 *
 * **Fail-safe: never stricter than having no lock at all.** An empty `sid` (a
 * plugin predating the field) or an unlocked session accepts everything — the cost
 * of being wrong here is dropping the *real* agent's events and freezing its
 * indicator, which is worse than the nesting it guards against.
 *
 * Note both arguments are **Claude's** `session_id`, not Shepherd's `SessionID`.
 * Two id spaces, and v1 conflated names around them (review §Ugly-4).
 */
export function sessionEventAccepted(sid: string, owner: string | undefined): boolean {
  if (sid === '') return true;
  if (owner === undefined || owner === '') return true;
  return sid === owner;
}
