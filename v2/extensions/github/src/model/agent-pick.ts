/**
 * Which of a task's agents should be handed this — and when to stop guessing and
 * ask.
 *
 * Pure, and its own file, because it is a decision with real consequences: a
 * task can be running four agents, and handing a review comment about
 * `sdk/tree.ts` to the one working in `v2` produces confident work on the wrong
 * tree.
 *
 * ── the rule ─────────────────────────────────────────────────────────────────
 *
 *   1. **Exactly one live agent in the PR's own repo** → it. Already in that
 *      worktree with that code loaded; nothing else comes close, and this is the
 *      overwhelming case.
 *   2. **More than one** → **ask**. There is no fact that would break the tie:
 *      every agent of a task shares one branch, so "the one that owns the PR" is
 *      not recorded anywhere and cannot be recovered from git either — same
 *      author, same branch, and the push came out of a worktree they share.
 *      Picking the oldest, or the idlest, would be inventing an answer; the
 *      caller has a screen and the user knows which one they meant.
 *   3. **None in the repo, but a live orchestrator** → it. A task's orchestrator
 *      runs at the task root and can reach every worktree, so it can act on any
 *      repo — it simply has further to go. Unambiguous, so no need to ask.
 *   4. **Nothing live** → nothing, and the caller spawns. A real answer rather
 *      than a failure.
 *
 * A workstream in ANOTHER repo is never chosen automatically, and never the sole
 * reason to ask: it is in the wrong tree, and being told about a file it does not
 * have is worse than not being told. It still APPEARS in the list once the list
 * is being shown — by then a person is choosing, and hiding an agent from them
 * would be the app deciding on their behalf after saying it would not.
 */

export interface TaskAgent {
  readonly id: string;
  /** Which repo it works in. Absent for one running at the task root. */
  readonly repo?: string;
  readonly role: 'orchestrator' | 'workstream';
  /**
   * What it is doing, from `agents.list` — `working`, `idle`, `blocked`…
   *
   * Absent for a session no agent kind has adopted (a plain shell), which is a
   * real state and not a gap.
   */
  readonly state?: string;
  /**
   * Which agent kind adopted it — `claude`, and one day something else.
   *
   * On the row because `sdk worktree` alone reads as a directory rather than as
   * somebody you can hand work to. Never spelled by this extension: an extension
   * never names a vendor (D11), so this comes off the agent record and is
   * printed unread.
   */
  readonly kind?: string;
}

/** One agent, resolved by the rule above. */
export interface Chosen {
  readonly kind: 'one';
  readonly session: string;
  /** Why this one — carried so the caller can say what it did. */
  readonly because: 'in the repo' | 'the orchestrator';
}

/** Several could be meant, so the user picks. Repo matches first. */
export interface Ambiguous {
  readonly kind: 'choose';
  readonly candidates: readonly TaskAgent[];
}

export type Pick = Chosen | Ambiguous | { readonly kind: 'none' };

export function pickAgent(agents: readonly TaskAgent[], live: ReadonlySet<string>, repo: string): Pick {
  const running = agents.filter((agent) => live.has(agent.id));
  const inRepo = running.filter((agent) => agent.repo === repo);

  if (inRepo.length > 1) return { kind: 'choose', candidates: order(running, repo) };

  const only = inRepo[0];
  if (only !== undefined) return { kind: 'one', session: only.id, because: 'in the repo' };

  const orchestrator = running.find((agent) => agent.role === 'orchestrator');
  if (orchestrator !== undefined) return { kind: 'one', session: orchestrator.id, because: 'the orchestrator' };

  return { kind: 'none' };
}

/**
 * The order the list is offered in: this repo's agents, then the orchestrator,
 * then everyone else.
 *
 * The first row is the one a person would pick nine times out of ten, so it is
 * the one Enter lands on without moving. Stable within each group — the order
 * the task recorded them — because a list that reorders itself between openings
 * is a list you have to read every time.
 */
function order(running: readonly TaskAgent[], repo: string): readonly TaskAgent[] {
  const rank = (agent: TaskAgent): number =>
    agent.repo === repo ? 0 : agent.role === 'orchestrator' ? 1 : 2;
  return [...running].sort((a, b) => rank(a) - rank(b));
}

/**
 * A task's sessions, as `tasks.list` reports them — read rather than cast.
 *
 * A session with no id is dropped: it is the placeholder a task records before
 * the pane's session exists (`TaskSession.pane` documents that window), and
 * writing to it would address nothing.
 */
export function readAgents(value: unknown): readonly TaskAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TaskAgent[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id === '') return [];
    const repo = record['repo'];
    return [
      {
        id,
        ...(typeof repo === 'string' && repo !== '' ? { repo } : {}),
        // Anything that is not the orchestrator is a workstream. The role only
        // decides a fallback, so an unrecognised one erring toward "not the
        // orchestrator" costs a hand-off nothing.
        role: record['role'] === 'orchestrator' ? 'orchestrator' : 'workstream',
      },
    ];
  });
}

/**
 * Each session's agent state, from `agents.list`.
 *
 * A separate read from `sessions.list`'s liveness, because they answer different
 * questions and one can be true without the other: a session can be running with
 * no agent adopted (a plain shell), and a record can name an agent whose pty has
 * gone. Liveness decides who is offered; state decides what the row says.
 */
export function readStates(value: unknown): ReadonlyMap<string, { state: string; kind?: string }> {
  const rows = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['agents'] : undefined;
  if (!Array.isArray(rows)) return new Map();
  const states = new Map<string, { state: string; kind?: string }>();
  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row['sessionId'];
    const state = row['state'];
    if (typeof id !== 'string' || typeof state !== 'string') continue;
    /*
     * The kind's id is `shepherd.claude-code`-shaped; the row wants the word a
     * person would say. Taken as the last dotted segment and printed UNREAD —
     * an extension never learns which agent it hired (D11), and reading this
     * string to branch on it is exactly what that rule forbids.
     */
    const kindId = row['kindId'];
    const kind = typeof kindId === 'string' ? (kindId.split('.').at(-1) ?? undefined) : undefined;
    states.set(id, { state, ...(kind === undefined || kind === '' ? {} : { kind }) });
  }
  return states;
}

/**
 * What handing to this agent MEANS, in the two words a row can carry.
 *
 * The whole reason a row shows an agent's state at all: an idle agent takes the
 * prompt now and a mid-turn one takes it when the turn ends, and finding that
 * out afterwards — by watching a pane not respond — is the thing this avoids.
 *
 * Both outcomes are fine, which is why neither is a warning. `queues` is
 * literally what a TUI does with input arriving mid-turn, so this is a
 * description rather than a prediction.
 */
/**
 * What to CALL an agent in the conversation view's `Agent` block.
 *
 * The title of the pane it runs in, which is a layout fact and the whole point
 * of it is that a user typed it or a program set it. Then the repo, then where
 * it is rooted — a block has to say something, and a session id says nothing a
 * person can use.
 *
 * Deliberately WITHOUT the agent's kind, which the hand-off picker does prefix.
 * The two are answering different questions: a row in a list of candidates has
 * to say what sort of thing it is, and this block is already headed `Agent`, so
 * leading with `claude-code` spends the first word repeating the heading and
 * the second on a directory. Naming the vendor here also broke the rule the
 * rest of this extension keeps — it never says whose agent it hired.
 */
export function agentName(agent: TaskAgent, paneTitle: string | undefined): string {
  return paneTitle ?? agent.repo ?? 'task root';
}

export function handingMeans(agent: TaskAgent): 'sends now' | 'queues' {
  return agent.state === 'working' ? 'queues' : 'sends now';
}

/**
 * The five agent states, reduced to the five marks the app draws.
 *
 * The translation lives HERE, at the boundary, for the reason the dock's
 * `markState` does: `agents-core` writes its own vocabulary and the mark takes a
 * SHAPE, so a word this build does not know is a hollow ring — the mark that
 * claims nothing — rather than an invented sixth state.
 */
export function markFor(agent: TaskAgent): 'working' | 'waiting' | 'resting' | 'failed' {
  switch (agent.state) {
    case 'working':
      return 'working';
    case 'blocked':
    case 'needsCheck':
      return 'waiting';
    case 'error':
      return 'failed';
    default:
      return 'resting';
  }
}

/** The ids `sessions.list` says are running, read the same way. */
export function readLive(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  const ids = value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const id = (entry as Record<string, unknown>)['id'];
    return typeof id === 'string' && id !== '' ? [id] : [];
  });
  return new Set(ids);
}
