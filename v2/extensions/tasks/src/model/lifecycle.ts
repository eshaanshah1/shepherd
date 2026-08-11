import { rollUp, type TaskAgentState } from './agent-rollup.ts';

/**
 * A task's state, split into the half that is stored and the half that is not.
 *
 * Sketch §4 writes the lifecycle as one run — `draft → running → needs-you →
 * review → done/archived` — which reads as five stored values plus a sixth. It
 * is not. **`needs-you` is a rollup of the task's sessions' attention**, which
 * `agents-core` already owns and is the only writer of (ADR 0026). Storing it
 * would make two writers for one fact, and they would disagree: the store would
 * say needs-you while every session had gone quiet, or the reverse, depending on
 * which wrote last.
 *
 * So the stored vocabulary below **cannot express `needs-you`**, and the derived
 * one adds it. That is the guard — not a convention, not a comment, but a type
 * with no such member, so a second writer has nothing to write. The test asserts
 * exactly that.
 */

export const LIFECYCLE_STATES = ['draft', 'running', 'review', 'done', 'archived'] as const;

/** What the store holds. */
export type TaskLifecycle = (typeof LIFECYCLE_STATES)[number];

/** What the sidebar tints by: the lifecycle's one surviving value, or the rollup. */
export type TaskDisplayState = TaskLifecycle | TaskAgentState;

export function isLifecycle(value: unknown): value is TaskLifecycle {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The lifecycle and the agents, meeting in one place.
 *
 * It used to fold a lifecycle with the sessions' ATTENTION, and `needs-you` was
 * the only value it could add. That was the bug: `running` covered a working
 * agent and a sleeping one, so both were blue — and `review`/`done`, the values
 * that would have been the other colours, are written by nothing anywhere.
 *
 * Archived is the one lifecycle value that still wins, because an archived task
 * is not a thing whose agents are doing anything and reporting `idle` for it
 * would answer a question nobody asked. In practice the two agree, since an
 * archived task's sessions are gone; the carve-out makes that a guarantee rather
 * than a coincidence a stale session could break.
 *
 * D4 is untouched and, if anything, stronger: nothing here writes. It reads a
 * fact `agents-core` publishes, one topic further upstream than before.
 */
export function displayState(
  lifecycle: TaskLifecycle,
  agentStates: readonly string[],
): TaskDisplayState {
  if (lifecycle === 'archived') return 'archived';
  return rollUp(agentStates);
}
