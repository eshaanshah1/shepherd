import type { AttentionLevel } from '@shepherd/sdk';

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

/** What the sidebar groups by. The lifecycle, plus the one derived value. */
export type TaskDisplayState = TaskLifecycle | 'needs-you';

export function isLifecycle(value: unknown): value is TaskLifecycle {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The one place `needs-you` comes from.
 *
 * Only a **running** task can need you. A `done` or `archived` task with a
 * straggling session at `urgent` is a task that needs cleaning up, not one that
 * needs answering — and without this narrowing, an archived task whose last
 * session never cleared would sit in the needs-you group permanently. `draft`
 * likewise: nothing has been dispatched yet, so there is nothing to answer.
 *
 * `info` deliberately does not count. It is the level that exists precisely
 * because it does not alert; promoting it here would reintroduce the noise
 * `AttentionLevel` splits out.
 */
export function displayState(
  lifecycle: TaskLifecycle,
  sessionAttention: readonly AttentionLevel[],
): TaskDisplayState {
  if (lifecycle !== 'running') return lifecycle;
  const wantsYou = sessionAttention.some((level) => level === 'attention' || level === 'urgent');
  return wantsYou ? 'needs-you' : lifecycle;
}
