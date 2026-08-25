import type { CardFact, CardFactSubject } from '@shepherd/ext-tasks/manifest';
import { rollUp, rollUpSaid, type PullRequest, type TaskPrState } from './pr.ts';

/**
 * How a rollup state reads — a tone AND a glyph, because the fact is drawn at
 * rest now rather than revealed on hover.
 *
 * **Never colour alone.** A tone that is the only difference between two states
 * is unreadable to anyone who cannot separate the hues, unreadable in a
 * screenshot, and unassertable in a test — which is §5's rule, and the reason
 * every mark in this app carries its word as a tooltip. `merged` and `closed`
 * therefore take the pull-request family's own variants; the states that share
 * `pull-request` are separated by a tone AND by `rollUpSaid`'s sentence.
 *
 * `blocked` and `running` share `pending` deliberately: they are the same
 * question — *is this still moving?* — and the answer to both is "not yet". What
 * they do not share is the phrase, and `stateWord` names the gate.
 */
export const FACT: Readonly<Record<TaskPrState, { tone: CardFact['tone']; icon: string }>> = {
  failed: { tone: 'negative', icon: 'pull-request' },
  waiting: { tone: 'negative', icon: 'pull-request' },
  blocked: { tone: 'pending', icon: 'pull-request' },
  running: { tone: 'pending', icon: 'pull-request' },
  approved: { tone: 'positive', icon: 'pull-request' },
  /*
   * The PLAIN glyph, not the draft one. `pull-request-draft` is GitHub's mark
   * for a PR explicitly opened as a draft, and `open` here means "open, and
   * nobody has looked yet" — a different claim. It is also the glyph the no-PR
   * case above draws, so using it here would leave two unrelated meanings one
   * tone apart, which is the collision this table exists to avoid.
   */
  open: { tone: 'neutral', icon: 'pull-request' },
  merged: { tone: 'done', icon: 'pull-request-merged' },
  closed: { tone: 'quiet', icon: 'pull-request-closed' },
  /*
   * Unreachable — `cardFact` handles an empty PR list above and never reaches
   * the rollup. Present so the record is exhaustive and a new `TaskPrState`
   * fails the build rather than falling through to a default.
   *
   * The no-PR case is not in this table at all: it draws `brand-git` in `brand`,
   * which is identity rather than state and shares neither a glyph nor a tone
   * with anything here.
   */
  none: { tone: 'quiet', icon: 'pull-request' },
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
    /*
     * **Git's own mark, not a pull-request one.** There is no pull request here
     * — that is the whole point of this branch — so a glyph from that family
     * would name a thing that does not exist. What there IS is a worktree with
     * changes in it, and `brand-git` is the noun for that; clicking it opens
     * exactly those changes.
     *
     * `brand` is identity rather than state: git's orange says whose mark this
     * is and nothing about whether the row needs you. That is the exemption it
     * needs from §2, and it is the same one the repo-identity marks have.
     */
    return {
      icon: 'brand-git',
      tone: 'brand',
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

  const { tone, icon } = FACT[rollUp(prs)];
  return {
    icon,
    tone,
    title,
    /*
     * The review tab, which on a multi-PR task IS the list — one `PrRow` per
     * pull request, repo-first. That is why this fact needs no menu of its own:
     * the glyph rolls the task up to one state, and one click opens the place
     * where the PRs are separate again.
     */
    command: { id: REVIEW_COMMAND, args: { task: task.id } },
  };
}
