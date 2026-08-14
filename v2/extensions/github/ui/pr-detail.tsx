import { useState, type ReactElement } from 'react';
import { Button, KeyCap } from '@shepherd/ui';
import { canMerge, firstFailure, type CheckRun, type PullRequest, type ReviewThread } from '../src/model/index.ts';
import { PrHeader, type PrTab } from './pr-header.tsx';
import { Checks, Commits, Conversation, Files, type PanelProps } from './pr-panels.tsx';

/**
 * One pull request, in full — and the same component is the whole tab when a
 * task has only one.
 *
 * **Four sub-views, not one column.** Everything a PR has does not fit in a
 * stack: the description, the threads, the commits, twelve checks and their
 * logs, and a diff. Stacked, the useful thing is always below the fold and the
 * pane reads as noise. Split, each tab is one job — and the tab row carries
 * counts, so you can see what is in a tab before opening it.
 *
 * The header and the footer stay put across all four. The header is the thing
 * you are looking at and the tabs are jobs on it; a header that re-rendered per
 * tab would make each tab feel like a different page.
 *
 * The footer's primary is **whatever this PR needs**, which is the one rule
 * worth reading before changing anything here. `Merge` is never offered while it
 * cannot merge — a disabled primary is a button that teaches you nothing, and
 * the footer says the reason in words instead.
 */

export interface PrActions {
  readonly onHandCheck: (check: CheckRun) => void;
  readonly onHandThread: (thread: ReviewThread) => void;
  readonly onHandReview: () => void;
  readonly onMerge: () => void;
  readonly onOpenExternal: (url: string) => void;
}

/**
 * Every `Hand to agent` button, wrapped by whoever owns the menu.
 *
 * A function rather than a `menu` node, because the menu is ANCHORED: Radix
 * hangs it off its trigger, so the trigger has to be the real button and the
 * wrapping has to happen at each site. The `at` key is which button asked —
 * `check`, `footer`, `thread:<id>` — so only the one you pressed opens.
 *
 * Identity, not decoration: a menu that opened under the footer when you pressed
 * a thread's button would point at the wrong thing, which is the entire reason
 * this is a menu rather than a modal.
 */
export type WrapHand = (at: string, button: ReactElement) => ReactElement;

const PANELS: Readonly<Record<PrTab, (props: PanelProps) => ReactElement>> = {
  conversation: Conversation,
  commits: Commits,
  checks: Checks,
  files: Files,
};

export function PrDetail({
  pr,
  actions,
  busy,
  wrapHand,
  now,
  agent,
  task,
  onNeedDiff,
}: {
  readonly pr: PullRequest;
  readonly actions: PrActions;
  /** A verb is in flight. Controls disable; nothing moves. */
  readonly busy: boolean;
  readonly wrapHand: WrapHand;
  readonly now: number;
  readonly agent?: PanelProps['agent'];
  readonly task?: PanelProps['task'];
  readonly onNeedDiff: () => void;
}): ReactElement {
  /**
   * Which tab, and it opens on the one that needs you.
   *
   * A failing check is the reason you came, so landing on Conversation and
   * making you find it would be the pane knowing something and not saying it.
   * State rather than derived, so it stops moving the moment you choose.
   */
  const [tab, setTab] = useState<PrTab>(firstFailure(pr) === undefined ? 'conversation' : 'checks');

  const failure = firstFailure(pr);
  const open = pr.threads.filter((thread) => !thread.resolved);
  const mergeable = canMerge(pr);
  const Panel = PANELS[tab];

  return (
    <div className="sh-pr-detail">
      <PrHeader pr={pr} tab={tab} onTab={setTab} now={now} />

      <div className="sh-pr-detail__body">
        <Panel
          pr={pr}
          now={now}
          busy={busy}
          wrapHand={wrapHand}
          onHandCheck={actions.onHandCheck}
          onHandThread={actions.onHandThread}
          onOpenExternal={actions.onOpenExternal}
          onNeedDiff={onNeedDiff}
          {...(agent === undefined ? {} : { agent })}
          {...(task === undefined ? {} : { task })}
        />
      </div>

      <div className="sh-pr-detail__foot">
        {mergeable ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={actions.onMerge}>
            Merge {pr.repoKey} #{pr.number}
            <KeyCap>M</KeyCap>
          </Button>
        ) : (
          wrapHand(
            'footer',
            <Button
              variant="primary"
              size="sm"
              disabled={busy || (open.length === 0 && failure === undefined)}
              onClick={failure === undefined ? actions.onHandReview : () => actions.onHandCheck(failure)}
            >
              Hand to agent
              <KeyCap>H</KeyCap>
            </Button>,
          )
        )}
        <Button variant="ghost" size="sm" onClick={() => actions.onOpenExternal(pr.url)}>
          Open on GitHub ↗
        </Button>
        <span className="sh-pr-detail__spacer" />
        <span className="sh-pr-detail__why">{whyNot(pr)}</span>
      </div>
    </div>
  );
}

/**
 * Why this cannot merge, in words, in the footer.
 *
 * It is the other half of hiding the Merge button: the button's absence says
 * "not yet" and this says which "not yet". Empty for a PR that CAN merge, since
 * the button is then the answer.
 */
function whyNot(pr: PullRequest): string {
  if (canMerge(pr)) return '';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed without merging';
  if (pr.state === 'draft') return 'draft — mark it ready on GitHub';
  const failure = firstFailure(pr);
  if (failure !== undefined) return `merge blocked · ${failure.name}`;
  if (pr.mergeState === 'dirty') return 'merge blocked · conflicts';
  if (pr.mergeState === 'behind') return 'merge blocked · behind the base branch';
  if (pr.mergeState === 'unknown') return 'GitHub is still working out whether this can merge';
  return 'merge blocked';
}
