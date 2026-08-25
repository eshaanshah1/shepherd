import type {
  AgentDecision,
  AgentEventInput,
  AgentKind,
  AgentSlot,
  HeadlessInput,
} from '@shepherd/ext-agents-core';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { applyEvent, backgroundTaskCount, sessionEventAccepted } from './stop-policy.ts';
import { TAIL_BYTES, lastSaid } from './last-said.ts';

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
 * This vendor's cheap tier — the only model id in the workspace, and it may live
 * only in this file. A consumer asks for the quick tier and never learns what
 * served it (D11).
 */
export const QUICK_MODEL = 'claude-haiku-4-5';

/**
 * What the quick tier may be set to, cheapest first — and, like `QUICK_MODEL`,
 * these strings may live only in this file.
 *
 * Aliases rather than dated ids on purpose: `claude -p --model sonnet` resolves to
 * whatever the current Sonnet is, so a user's choice does not go stale the day a
 * point release lands. The default stays the pinned haiku id, because the DEFAULT
 * should not change under anybody without a release saying so.
 */
export const QUICK_MODELS: readonly string[] = [QUICK_MODEL, 'haiku', 'sonnet', 'opus'];

/**
 * **Every model this vendor will run** — `AgentKind.listModels`, and the only
 * place these strings may live (D11).
 *
 * Aliases ONLY, and no dated ids. `--model sonnet` resolves to whatever the
 * current Sonnet is, so a user's choice does not go stale the day a point
 * release lands — and a list of four tiers is a choice somebody can make,
 * where a list that also carries `claude-haiku-4-5` asks them to know what the
 * difference is between that and `haiku`.
 *
 * `QUICK_MODEL` is deliberately NOT here. It is the quick tier's pinned default
 * — a default should not change under anybody without a release saying so — and
 * a default is not a menu entry: it is what you get by not choosing.
 *
 * Declared rather than discovered because Claude Code cannot be asked: there is
 * no `model list` verb, only `--model` and this set of aliases. Growing the list
 * is one line here and reaches every surface that offers a model, which is what
 * having the primitive buys.
 */
export const MODELS: readonly { id: string; label: string; note?: string }[] = [
  { id: 'fable', label: 'Fable', note: 'deepest reasoning' },
  { id: 'opus', label: 'Opus', note: 'complex agentic work' },
  { id: 'sonnet', label: 'Sonnet', note: 'balanced' },
  { id: 'haiku', label: 'Haiku', note: 'fastest' },
];

/**
 * What a new agent opens on when nobody has chosen, and the only place that
 * decision may be made (D11).
 *
 * Opus rather than the top of the list: Fable is the most capable tier and prices
 * accordingly, and a default is what you get without asking. Stated rather than
 * `MODELS[0]`, so reordering the menu cannot silently re-point every new agent.
 */
export const DEFAULT_MODEL = 'opus';

/**
 * One non-interactive call, and why there are exactly two flags beyond the model.
 * All measured 2026-08-10 against a subscription login; the spec carries the
 * table.
 *
 * **`--safe-mode`** disables CLAUDE.md discovery, skills, plugins, hooks, MCP
 * servers, custom agents, commands and workflows, while auth, model selection and
 * admin policy settings keep working. It is worth ~2s against the plain call, and
 * it closes two hazards outright rather than mitigating them: a repo's CLAUDE.md
 * (~46k tokens in this one) being read on every call, and **our own hooks** firing
 * for a nested call and reporting its lifecycle as some pane's.
 *
 * **`--tools ""`** is the documented way to disable every tool ("use `""` to
 * disable all tools"). A call whose whole job is to return six words has no
 * business holding a file handle. Preferred over a `--settings` deny-list, which
 * would enumerate vendor tool names and rot as that set changes; `--max-turns`
 * does not exist in the installed CLI.
 *
 * **`--bare` is deliberately absent and must stay absent.** It never reads OAuth
 * or the keychain, so on a machine whose managed settings pin `forceLoginMethod`
 * it cannot authenticate at all — it exits 1 in under a second, and no API key
 * changes that, because a non-OAuth credential is exactly what such a pin rejects.
 *
 * The prompt travels as an argument rather than on stdin: `runExec` reaches
 * `execFile` with an array, so there is no shell and nothing to quote wrongly.
 */
export function quickArgv(input: HeadlessInput): readonly string[] {
  return ['claude', '-p', input.prompt, '--model', input.model, '--safe-mode', '--tools', ''];
}

/**
 * The answer, unwrapped — or nothing.
 *
 * The **last** non-empty line, not the first: measured, a model asked for six
 * words sometimes writes a sentence about the six words first, and the answer
 * comes after it. Three of seven measured answers also arrived wrapped in
 * backticks, so the decoration is stripped here.
 *
 * Whether the result is *usable* is the consumer's judgement; this only reports
 * what the vendor said.
 */
export function parseQuick(stdout: string): string | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const bare = last.replace(/^[`"'*\s]+/, '').replace(/[`"'*\s]+$/, '').trim();
  return bare === '' ? undefined : bare;
}

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
  /**
   * Where this session's transcript is, as Claude Code itself reported it.
   *
   * **Taken from the hook payload rather than derived.** `report.sh` splices the
   * payload in verbatim and every hook carries `transcript_path`, so the path is
   * simply told to us on every event — where computing it would mean encoding a
   * cwd into a directory name the way the vendor happens to this month.
   */
  transcriptPath?: string;
  /** The last read's answer, and the file size it was read at. See `lastSaidOf`. */
  lastSaid?: { readonly at: number; readonly text: string | null };
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

/**
 * Single-quoted for a shell, with embedded quotes escaped.
 *
 * A resume target is a vendor token we did not mint, so it is quoted rather than
 * trusted — the same care `tasks` took when this lived there.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
    lastSaidOf: (slot) => Promise.resolve(readLastSaid(slot as ClaudeSlot | undefined)),

    /**
     * `claude --resume <target>` — and this package is the ONLY place that
     * string may appear (ADR 0036 §3). It moved here from `tasks`, whose own
     * comment had been asking for it: the binary and the flag are vendor facts,
     * and a consumer that spells them has learned which agent it hired.
     *
     * No prompt and no prompt file: the transcript IS the context, and typing
     * the original brief at a resumed session would restate what it already
     * knows and read as a second instruction.
     */
    resumeCommandOf: (target) => `claude --resume ${shellQuote(target)}`,

    /**
     * The quick tier (§7c). `argv` and `parse` are the whole vendor surface —
     * the deadline, the output cap and the child's environment belong to
     * `agents-core`, which is what stops the second kind from reimplementing
     * them differently.
     */
    headless: { quickModel: QUICK_MODEL, quickModels: QUICK_MODELS, argv: quickArgv, parse: parseQuick },
    listModels: () => MODELS,
    defaultModel: DEFAULT_MODEL,
  };
}

/**
 * The last thing this agent said, read from the tail of its transcript.
 *
 * **Cached on the file's SIZE**, which is the whole reason this is affordable.
 * `tasks` asks for every live task on a beat, and a transcript only ever grows —
 * so a file that has not grown cannot have a newer answer, and the common case
 * is a `stat` and nothing else. The read that follows a change is bounded to the
 * last `TAIL_BYTES` however large the file has become.
 *
 * A shrinking file is a rewritten one (`/clear`, a compaction), and re-reading
 * it is exactly right — the cache is keyed on the size, not on it having grown.
 *
 * **Every failure is `null`, and none of them throws.** A path that no longer
 * exists, a permission error, a file being written as we open it: all of them
 * mean "we do not know what it last said", the row draws nothing, and the next
 * beat tries again. There is nothing here worth taking a sidebar down for.
 */
function readLastSaid(slot: ClaudeSlot | undefined): string | null {
  const path = slot?.transcriptPath;
  if (slot === undefined || path === undefined || path === '') return null;

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  const cached = slot.lastSaid;
  if (cached !== undefined && cached.at === size) return cached.text;

  let text: string | null = null;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(path, 'r');
    try {
      const read = readSync(fd, buffer, 0, length, start);
      text = lastSaid(buffer.subarray(0, read).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    // Left null, and still cached below: a file we cannot read now is one we
    // should not re-attempt every beat until it changes.
    text = null;
  }

  slot.lastSaid = { at: size, text };
  return text;
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

  /*
   * Every hook carries it, so it is recorded on every hook rather than on
   * `SessionStart` alone: a session adopted mid-flight (the app restarting under
   * a running agent) never sees a `SessionStart` and would otherwise have no
   * path for the rest of its life.
   */
  const transcript = stringField(hook, 'transcript_path');
  if (transcript !== '') slot.transcriptPath = transcript;

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
      // Its own field rather than a row in DETAIL_FIELD: `source` decides a
      // branch, and `detail` is the cosmetic name for every event that has one.
      sessionSource: event === 'SessionStart' ? stringField(hook, 'source') : '',
    }),
  };
}
