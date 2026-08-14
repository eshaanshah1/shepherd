import type { ReactElement } from 'react';
import { agoText } from './review-data.ts';
import { countChecks, stateWord, type PullRequest } from '../src/model/index.ts';

/**
 * The PR's identity, and the sub-tab row under it — both of which stay put while
 * you move between the tabs.
 *
 * That is the whole point of splitting the pane into sub-views: the header is the
 * thing you are looking at, and the tabs are four jobs on it. A header that
 * re-rendered per tab would make each tab feel like a different page.
 *
 * The line under the title is GitHub's own sentence — `claude wants to merge 4
 * commits into main from tasks/…` — and it is worth copying rather than
 * inventing, because it says the direction of the change in the order people
 * think about it. The two refs are chips because they are identifiers you might
 * copy, not prose.
 */

/** The four jobs. `Conversation` is first because it is where you land. */
export const PR_TABS = ['conversation', 'commits', 'checks', 'files'] as const;
export type PrTab = (typeof PR_TABS)[number];

const LABELS: Readonly<Record<PrTab, string>> = {
  conversation: 'Conversation',
  commits: 'Commits',
  checks: 'Checks',
  files: 'Files',
};

/**
 * What each tab's count is, and what colour it reads in.
 *
 * The counts are the reason the row is worth its height: you can see what is in
 * a tab before opening it, so `Checks 1` in red is the tab you go to. Only that
 * one is ever coloured — a red count means "one of these failed", and a second
 * coloured count would make the first stop meaning it.
 */
export function tabCount(tab: PrTab, pr: PullRequest): { text: string; failed: boolean } {
  switch (tab) {
    case 'conversation':
      return { text: String(pr.threads.length), failed: false };
    case 'commits':
      return { text: String(pr.commits.length), failed: false };
    case 'checks': {
      const counts = countChecks(pr.checks);
      // The FAILING count, not the total: the number you want on a tab you have
      // not opened is how much is wrong, and `12` tells you nothing.
      return counts.failed > 0
        ? { text: String(counts.failed), failed: true }
        : { text: String(counts.total), failed: false };
    }
    case 'files':
      return { text: String(pr.files?.length ?? pr.changedFiles), failed: false };
  }
}

export function PrHeader({
  pr,
  tab,
  onTab,
  now,
}: {
  readonly pr: PullRequest;
  readonly tab: PrTab;
  readonly onTab: (tab: PrTab) => void;
  readonly now: number;
}): ReactElement {
  const state = stateWord(pr);
  const opened = agoText(pr.openedAt, now);

  return (
    <div className="sh-pr-head">
      <div className="sh-pr-head__title-line">
        <h2 className="sh-pr-head__title">{pr.title}</h2>
        <span className="sh-pr-head__number">#{pr.number}</span>
      </div>

      <div className="sh-pr-head__sub">
        {/*
          The state, as a pill with a dot. The one place in this pane a state is
          drawn as a shape AND a word together — everywhere else the word travels
          as a tooltip — because this is the PR's own identity line rather than a
          row in a list, and there is nothing else here for the shape to be read
          against.
        */}
        <span className="sh-pr-head__pill" data-tone={state.tone}>
          <i aria-hidden="true" />
          {pr.state}
        </span>
        <span className="sh-pr-head__says">
          {authorOf(pr)} wants to merge {pr.commits.length} {pr.commits.length === 1 ? 'commit' : 'commits'} into
        </span>
        <span className="sh-pr-head__ref">{pr.baseRef}</span>
        <span className="sh-pr-head__says">from</span>
        <span className="sh-pr-head__ref">{pr.headRef}</span>
        {opened === null ? null : <span className="sh-pr-head__says">· {opened} ago</span>}
      </div>

      <div className="sh-pr-head__tabs" role="tablist" aria-label="Pull request">
        {PR_TABS.map((candidate) => {
          const count = tabCount(candidate, pr);
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={candidate === tab}
              className="sh-pr-head__tab"
              data-at={candidate === tab ? 'true' : undefined}
              onClick={() => onTab(candidate)}
            >
              {LABELS[candidate]}
              <span className="sh-pr-head__count" data-tone={count.failed ? 'negative' : undefined}>
                {count.text}
              </span>
            </button>
          );
        })}
        <span className="sh-pr-head__spacer" />
        {/*
          The size of the change, in the tab row rather than in a tab. It is true
          of the whole PR and does not belong to any one of the four — and the
          Checks tab replaces it with its own summary, because there the useful
          number is time rather than lines.
        */}
        {tab === 'checks' ? (
          <span className="sh-pr-head__total">{checksTotal(pr)}</span>
        ) : (
          <span className="sh-pr-head__total">
            <span data-tone="positive">+{pr.added}</span> <span data-tone="removed">−{pr.removed}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Whose PR this is, in one word.
 *
 * From the commits rather than a field, because GitHub's `author` is the account
 * that opened it and the interesting answer here is who WROTE it — which for
 * this app is usually an agent, and is what the commits say.
 */
function authorOf(pr: PullRequest): string {
  return pr.commits[0]?.author ?? 'someone';
}

/** `1 of 3 passed · 2m 41s total`, which is what the Checks tab wants instead of a diff. */
function checksTotal(pr: PullRequest): string {
  const counts = countChecks(pr.checks);
  const ms = pr.checks.reduce((total, check) => total + (check.durationMs ?? 0), 0);
  const passed = `${counts.passed} of ${counts.total} passed`;
  return ms === 0 ? passed : `${passed} · ${duration(ms)} total`;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
