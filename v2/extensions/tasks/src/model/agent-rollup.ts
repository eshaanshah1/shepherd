/**
 * A task's sessions' agent states → the one state its dot shows.
 *
 * Loudest wins, which is v1's `Tab.attentionState()` priority arrived at for the
 * same reason: anything wanting you outranks anything merely busy. The accepted
 * cost is that one blocked workstream reads blocked while four others make
 * progress — correct, because a blocked agent waits indefinitely and burns
 * nothing, so it is the fact worth surfacing.
 *
 * Total over values, no IO, no host — the same shape as `lifecycle.ts` beside it.
 */

export const ROLLUP_PRIORITY = ['blocked', 'error', 'needsCheck', 'working', 'idle'] as const;

export type TaskAgentState = (typeof ROLLUP_PRIORITY)[number];

export function isTaskAgentState(value: string): value is TaskAgentState {
  return (ROLLUP_PRIORITY as readonly string[]).includes(value);
}

/**
 * Takes `readonly string[]` and NOT `readonly AgentState[]`, deliberately.
 *
 * These values crossed a port and came from an extension this code has never
 * seen: `ok` says the call succeeded, not that the value has a shape, and a cast
 * is not a check. An unrecognised word is data rather than a crash, and it folds
 * in with everything else that means nothing is happening.
 *
 * `shell` folds to `idle` for the same reason it is not a sixth state: a pane
 * that has dropped back to a bare prompt has no agent, and "no agent" is already
 * the grey case.
 */
export function rollUp(states: readonly string[]): TaskAgentState {
  const present = new Set(states);
  for (const candidate of ROLLUP_PRIORITY) {
    if (present.has(candidate)) return candidate;
  }
  return 'idle';
}

/**
 * The rollup → the design-token word the row carries.
 *
 * Every word here already resolves in `view-dock`'s `TINT_ROLES`, so this ships
 * without touching the renderer. Two of them are worth stating out loud:
 *
 *   - `needsCheck` emits **`needs-check`**, which the shell paints `success` —
 *     GREEN. A finished turn is not the same signal as a blocked one, and the
 *     palette says so in as many words: `pasture` is "done / success", `hay` is
 *     "blocked / attention". v1 agreed and had shipped it that way for months
 *     (`Theme.needsCheck` = `0x43C988`, commented "done — ready for you"), which
 *     is also what the rollup priority comment means when it says `done` — there
 *     was never a separate state by that name, only this one under its
 *     user-facing word.
 *
 *     Spelling it `needs-you` instead would paint it amber and make "finished"
 *     and "waiting on an answer" the same colour, told apart only by a tooltip.
 *     Green still clears to grey the moment you look at the pane, so it reads as
 *     "done, unread" rather than "resolved, ignore me".
 *   - `idle` emits `idle`, which `TINT_ROLES` does NOT contain. It resolves by
 *     falling through `statusRole`'s default, which is the behaviour any
 *     unrecognised word gets — so this is also the only real exercise that
 *     fallback has.
 */
export function tintFor(state: TaskAgentState): string {
  return state === 'needsCheck' ? 'needs-check' : state;
}
