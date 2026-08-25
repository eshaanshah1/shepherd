import type { CardFact, CardFactSubject } from '@shepherd/ext-tasks/manifest';
import { rollUp, rollUpSaid, type PullRequest, type TaskPrState } from './pr.ts';

/** Which of the palette's four readings each rolled-up state is. */
const TONES: Readonly<Record<TaskPrState, CardFact['tone']>> = {
  failed: 'negative',
  waiting: 'negative',
  running: 'neutral',
  approved: 'positive',
  open: 'quiet',
  merged: 'quiet',
  none: 'quiet',
};

/** The verbs this decision names, re-stated so the model imports no host. */
export const REVIEW_COMMAND = 'github.review';
export const OPEN_COMMAND = 'github.open';

/**
 * One glyph per task card — the "git icon".
 *
 * Extracted from `activate` when the no-PR case gained behaviour: it is the
 * whole of what the rail says about a task's GitHub state, and it was the one
 * decision here with no test.
 *
 * Pure, and synchronous as the point requires: the caller passes what the last
 * sync left in memory, and nothing asks GitHub.
 */
export function cardFact(
  task: Pick<CardFactSubject, 'id' | 'shipped'>,
  prs: readonly PullRequest[],
  synced: boolean,
): CardFact | null {
  if (prs.length === 0) {
    /*
     * **No pull request is a state, not an absence.**
     *
     * This used to return `null`, so a task without a PR had no icon — and with
     * no icon there was no way in to the one view that would tell you what you
     * had actually changed. The row now carries a quiet draft mark whose job is
     * to open the working-tree diff, where the PR can be created.
     *
     * A task nobody has SYNCED yet still gets nothing: a glyph drawn before
     * anything is known would claim a state, and "no PR" is a claim. That is
     * the same reasoning the old `null` was written for, kept and narrowed.
     */
    if (!synced || task.shipped) return null;
    return {
      icon: 'pull-request-draft',
      tone: 'quiet',
      title: 'No pull request yet — review your changes',
      command: { id: REVIEW_COMMAND, args: { task: task.id } },
    };
  }

  const title = rollUpSaid(prs);
  if (title === null) return null;

  /*
   * A shipped row says the NUMBER, a live row says the glyph.
   *
   * The two are different questions. On live work you want to know whether
   * anything needs you, which is a state and reads faster as a mark; on
   * finished work the state is always "merged" and the useful fact is which PR
   * it was — the record of what shipped.
   */
  if (task.shipped) {
    const merged = prs.filter((pr) => pr.state === 'merged');
    const only = merged.length === 1 ? merged[0] : undefined;
    if (only === undefined) return null;
    return {
      label: `${only.repoKey} #${only.number}`,
      tone: 'quiet',
      title,
      command: { id: OPEN_COMMAND, args: { url: only.url } },
    };
  }

  return {
    icon: 'pull-request',
    tone: TONES[rollUp(prs)],
    title,
    command: { id: REVIEW_COMMAND, args: { task: task.id } },
  };
}
