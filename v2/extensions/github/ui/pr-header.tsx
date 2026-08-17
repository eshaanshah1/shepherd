import type { ReactElement } from 'react';
import { Icon, namedGlyph } from '@shepherd/ui';
import { agoText } from './review-data.ts';
import { countChecks, stateWord, type PrState, type PullRequest } from '../src/model/index.ts';

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

/**
 * The glyph for each state, from `@shepherd/ui`'s allow-list.
 *
 * By NAME rather than by importing Tabler, which the import boundaries forbid
 * an extension and should: reaching the icon package directly is how a
 * contributed surface ends up shipping a glyph at a fourth size and a second
 * stroke weight.
 */
const GLYPH_OF: Readonly<Record<PrState, string>> = {
  open: 'pull-request',
  draft: 'pull-request-draft',
  merged: 'pull-request-merged',
  closed: 'pull-request-closed',
};

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
        {/*
          The state, on the title line, as a glyph and nothing else.

          It was a pill on the line below — a bordered capsule holding a dot and
          the word `open`. Three marks for one fact, none of which is the fact:
          the border says a control you cannot press, the word repeats what the
          shape already says, and the shape was a circle that means whatever its
          hue means. The git-pull-request family is what every forge draws for
          this and a reader knows it on sight, so it needs no capsule to be
          found and no word to be read.

          Beside the TITLE because that is what it is about. On the line below it
          sat at the head of a sentence about branches and commits, reading as
          that sentence's first word.

          The word now travels as `title` and `aria-label`, which is the rule
          everywhere else in this app and is what the pill was the exception to.
        */}
        <span className="sh-pr-head__state" data-tone={state.tone} title={state.text}>
          <Icon icon={namedGlyph(GLYPH_OF[pr.state])} size="md" label={state.text} />
        </span>
        <h2 className="sh-pr-head__title">{pr.title}</h2>
        <span className="sh-pr-head__number">#{pr.number}</span>
      </div>

      <div className="sh-pr-head__sub">
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
  /*
   * The OPENER, and the first commit's author only as a fallback.
   *
   * These are the same person most of the time and different exactly when it
   * matters: push from a work identity, open the PR from a personal one, and
   * this line named the committer while GitHub's named the opener — two
   * accounts for one PR, on two screens, with nothing saying which was which.
   */
  return pr.author === '' ? (pr.commits[0]?.author ?? 'someone') : pr.author;
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
