import type { AgentDecision, AgentEventInput, AgentKind, AgentSlot } from '@shepherd/ext-agents-core';
import { applyEvent, backgroundTaskCount, sessionEventAccepted } from './stop-policy.ts';

/**
 * Claude Code as one *kind* — no privileged path, the same seam `codex` would
 * register through.
 *
 * Everything vendor-specific lives here: the hook payload's shape, which field
 * carries a cosmetic name for which event, the `background_tasks` reduction, and
 * the ownership lock. `agents-core` sees none of it.
 */

export const CLAUDE_HOOK_TOPIC = 'claude.hook';
export const CLAUDE_KIND_ID = 'claude-code';

/**
 * This kind's per-session state, kept in the slot `agents-core` hands it.
 *
 * **Two ids, and they are not the same field** (review §Ugly-4, which found v1
 * holding them apart with a side-effecting clear in an unrelated function):
 *
 *   - `ownerClaudeSessionID` is a **lock**. It says which Claude session owns
 *     this pane, and it is released on `SessionEnd`.
 *   - `resumeSessionID` is a **target**. It says what `--resume` would reattach
 *     to, and it deliberately OUTLIVES the lock — a session that ended is
 *     precisely the one you want to resume.
 *
 * Conflating them means either resume stops working when a session ends, or the
 * lock never releases and a genuinely new agent is refused.
 */
export type ClaudeSlot = AgentSlot & {
  ownerClaudeSessionID?: string;
  resumeSessionID?: string;
};

/** The envelope `report.sh` posts: an event name and the hook's own payload. */
interface ClaudeHookPayload {
  readonly event?: unknown;
  readonly hook?: unknown;
}

/**
 * Which hook payload field carries the human-facing name for this event.
 *
 * In v1 this table lived in bash and was applied with a `jq` filter per event.
 * Here the payload arrives whole, so the table is data and the lookup is typed —
 * and, unlike a shell filter, it is tested.
 */
const DETAIL_FIELD: Readonly<Record<string, string>> = {
  PreToolUse: 'tool_name',
  PermissionRequest: 'tool_name',
  StopFailure: 'error_type',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
};

function stringField(hook: unknown, field: string): string {
  if (typeof hook !== 'object' || hook === null) return '';
  const value = (hook as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function claudeKind(): AgentKind {
  return {
    id: CLAUDE_KIND_ID,
    topics: [CLAUDE_HOOK_TOPIC],
    /**
     * Declared ahead of the headless seam that consumes them (§7c), so kinds
     * describe themselves against a stable shape from the start. `resume: true`
     * is the one that is actually exercised in M2.
     */
    capabilities: { streaming: true, tools: true, resume: true, structuredOutput: true },
    reduce,
    /**
     * `claude --resume <this>`. Read out of the slot rather than a map of this
     * extension's own, for the reason the slot exists: it dies with the session,
     * and a map would go on answering for a pane that closed.
     *
     * The consumer this was waiting for landed with `tasks`: archiving a task
     * captures one per session so that restoring it reattaches to the same
     * transcript instead of starting a fresh agent on the brief.
     */
    resumeTargetOf: (slot) => (slot as ClaudeSlot | undefined)?.resumeSessionID ?? null,
  };
}

export function reduce(input: AgentEventInput): AgentDecision {
  const payload = input.payload as ClaudeHookPayload;
  if (typeof payload?.event !== 'string' || payload.event === '') {
    return { kind: 'ignore', why: 'the envelope carried no event name' };
  }
  const event = payload.event;
  const hook = payload.hook;
  const slot = input.slot as ClaudeSlot;
  const claudeSession = stringField(hook, 'session_id');

  // The lock, BEFORE anything else looks at the event. A nested `claude -p` that
  // a top-level agent runs via Bash inherits SHEPHERD_SESSION_ID, so its hooks
  // arrive tagged with the parent's session while carrying their own Claude id;
  // unchecked, the child's `Stop` flips the parent to needs-check mid-turn and
  // its `SessionStart` clobbers the parent's resume target.
  if (!sessionEventAccepted(claudeSession, slot.ownerClaudeSessionID)) {
    return {
      kind: 'ignore',
      why: `${event} came from a nested claude (${claudeSession}), not this pane's agent (${slot.ownerClaudeSessionID ?? 'none'})`,
    };
  }

  if (event === 'SessionStart' && claudeSession !== '') {
    // Claiming the lock and recording the resume target are the same moment and
    // two different facts.
    slot.ownerClaudeSessionID = claudeSession;
    slot.resumeSessionID = claudeSession;
  }
  if (event === 'SessionEnd') {
    // The lock goes so a new agent in this pane can claim it. `resumeSessionID`
    // stays: an ended session is exactly the one worth resuming.
    delete slot.ownerClaudeSessionID;
  }

  const field = DETAIL_FIELD[event];
  return {
    kind: 'transition',
    to: applyEvent({
      event,
      detail: field === undefined ? '' : stringField(hook, field),
      current: input.current,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      viewing: input.viewing,
      // Only `Stop` is ever paused on background work, and reducing the array
      // for any other event would be reading a field that is not there.
      backgroundTasks: event === 'Stop' ? backgroundTaskCount(hook) : 0,
    }),
  };
}
