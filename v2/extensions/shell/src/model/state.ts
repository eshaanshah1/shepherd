import type { AgentState } from '@shepherd/ext-agents-core/state';

/**
 * Which agent state a rail row reports when a shell has several, and which
 * survives the cap.
 *
 * **A `Record` over the imported union, not an array.** The words are
 * `agents-core`'s vocabulary and this is a second copy of their ORDER, which is
 * the duplication worth guarding: a seventh state added there fails
 * `pnpm typecheck` here rather than silently ranking as the quiet case forever.
 * The type crosses the boundary and the value does not — `boundaries.js` allows a
 * type import of another extension and refuses a value import, and a runtime read
 * of a constant would be a command round-trip for six words.
 *
 * Loudest wins, which is v1's `Tab.attentionState()` priority arrived at for the
 * same reason: anything wanting you outranks anything merely busy. The accepted
 * cost is that one blocked shell reads blocked while another makes progress —
 * correct, because a blocked agent waits indefinitely and burns nothing.
 *
 * `shell` ties with `idle` rather than sitting below it: a pane at a bare prompt
 * has no agent, and "no agent" is already the quiet case rather than a quieter
 * one.
 */
export const URGENCY: Readonly<Record<AgentState, number>> = {
  blocked: 0,
  error: 1,
  needsCheck: 2,
  working: 3,
  idle: 4,
  shell: 4,
};

/** Ranked loudest first, and the ONE place that order is walked. */
const LOUDEST: readonly AgentState[] = ['blocked', 'error', 'needsCheck', 'working'];

/**
 * The states of every shell → the one its parent row reports, or nothing.
 *
 * Takes `readonly string[]` and NOT `readonly AgentState[]`, deliberately: these
 * values crossed a port and came from an extension this code has never seen, so
 * an unrecognised word is data rather than a crash and folds in with everything
 * else that means nothing is happening.
 *
 * `undefined` rather than `'idle'`, because the row's `tint` is what the caller
 * needs and an absent tint is what draws no mark. A rail of plain shells should
 * report nothing, not claim a state six times.
 */
export function rollUp(states: readonly string[]): AgentState | undefined {
  const present = new Set(states);
  return LOUDEST.find((candidate) => present.has(candidate));
}

/**
 * A state → the design-token word the row carries, or nothing.
 *
 * `needsCheck` emits **`needs-check`**, which the shell draws as the `ready`
 * mark — a green square. A finished turn nobody has looked at is your move, and
 * it is not the same signal as an agent stuck waiting for an answer; the palette
 * says so in as many words, and `extensions/tasks/src/model/agent-rollup.ts`
 * records what it cost to learn.
 *
 * The quiet states emit nothing at all rather than a word for a state nobody is
 * in. An absent tint means "this row has nothing to report", and a shell is a
 * PLACE — it has no lifecycle, so there is no state of it to be in. A task that
 * is merely idle is the opposite case and says so: nothing running is its
 * owner's move, and it wears the green square that means exactly that.
 */
export function tintFor(state: AgentState): string | undefined {
  if (state === 'idle' || state === 'shell') return undefined;
  return state === 'needsCheck' ? 'needs-check' : state;
}
