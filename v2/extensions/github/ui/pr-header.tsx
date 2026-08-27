import type { ReactElement } from 'react';
import { Button, Icon, KeyCap, namedGlyph } from '@shepherd/ui';
import { mergeGate, stateWord, type PrState, type PullRequest } from '../src/model/index.ts';
import { agoText } from './review-data.ts';
import type { WrapHand } from './pr-detail.tsx';

/**
 * The head of the document — not a header band.
 *
 * It was three fixed bands: a title block, a tab strip, and a footer carrying
 * the Merge button and a phrase about why it was missing. That arrangement put
 * the one fact you open this pane for at the BOTTOM of a surface you had to
 * scroll, and drew three horizontal rules across a document to do it. The
 * app's own titlebar note says what that costs — with nothing drawn in a band,
 * "a fill is a lid and a hairline is a seam across a picture."
 *
 * So this scrolls with everything else, and the verdict is a SENTENCE: a mark,
 * a word, and the reason in prose (`mergeGate`). Unblocked, it is one green
 * line and the whole apparatus is gone — which is the tell that most of the
 * chrome only ever existed for one state.
 */

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

export function PrBrief({
  pr,
  now,
  busy,
  wrapHand,
  agent,
  task,
  onMerge,
  onHand,
  onOpenExternal,
}: {
  readonly pr: PullRequest;
  readonly now: number;
  readonly busy: boolean;
  /** The hand menu's wrapper — see `review.tsx`. Keyed `brief`, so only this
      button's menu opens when this button is pressed. */
  readonly wrapHand: WrapHand;
  readonly agent?: { readonly title: string; readonly state: string };
  readonly task?: { readonly title: string; readonly others: readonly string[] };
  readonly onMerge: () => void;
  readonly onHand: () => void;
  readonly onOpenExternal: (url: string) => void;
}): ReactElement {
  const state = stateWord(pr);
  const opened = agoText(pr.openedAt, now);
  const gate = mergeGate(pr);
  const reviewer = pr.reviewers[0];

  return (
    <div className="sh-pr-brief">
      <div className="sh-pr-brief__title-line">
        <span className="sh-pr-brief__state" data-tone={state.tone} title={state.text}>
          <Icon icon={namedGlyph(GLYPH_OF[pr.state])} size="md" label={state.text} />
        </span>
        <h2 className="sh-pr-brief__title">{pr.title}</h2>
        <span className="sh-pr-brief__number">#{pr.number}</span>
      </div>

      <p className="sh-pr-brief__says">
        <span className="sh-pr-brief__who">{authorOf(pr)}</span> wants to merge {pr.commits.length}{' '}
        {pr.commits.length === 1 ? 'commit' : 'commits'} into <span className="sh-pr-brief__ref">{pr.baseRef}</span> from{' '}
        <span className="sh-pr-brief__ref">{pr.headRef}</span>
        {opened === null ? '' : ` · ${opened} ago`}
      </p>

      {/*
        What the meta column used to be, as one dim line.
        `Chip`'s rule one surface along: "a bordered box beside a 13px row is
        louder than the row" — and here not even a fill. A fact beside prose does
        not need a box to be a fact.
      */}
      <p className="sh-pr-brief__facts">
        {reviewer === undefined ? (
          <span>No reviewer yet</span>
        ) : (
          <span>
            Reviewer <span className="sh-pr-brief__value">{reviewer.login}</span>
          </span>
        )}
        {agent === undefined ? null : (
          <span>
            {' · agent '}
            <span className="sh-pr-brief__value">{agent.title}</span>
          </span>
        )}
        {task === undefined || task.others.length === 0 ? null : (
          <span>{` · lands with ${task.others.join(', ')}`}</span>
        )}
      </p>

      <div className="sh-pr-brief__gate" data-ok={gate.ok ? 'true' : undefined}>
        <span className="sh-pr-brief__mark" aria-hidden="true">
          {gate.ok ? <Icon icon={namedGlyph('check')} size="sm" /> : null}
        </span>
        <p className="sh-pr-brief__verdict">
          <strong>{gate.verdict}</strong>
          {gate.because === '' ? '' : <span className="sh-pr-brief__because"> — {gate.because}</span>}
        </p>
      </div>

      <div className="sh-pr-brief__verbs">
        {gate.ok ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={onMerge}>
            Merge {pr.repoKey} #{pr.number}
            <KeyCap>M</KeyCap>
          </Button>
        ) : (
          wrapHand(
            'brief',
            <Button variant="ghost" size="sm" disabled={busy} onClick={onHand}>
              Hand to agent
              <KeyCap>H</KeyCap>
            </Button>,
          )
        )}
        <Button variant="ghost" size="sm" onClick={() => onOpenExternal(pr.url)}>
          Open on GitHub ↗
        </Button>
      </div>
    </div>
  );
}

/**
 * Whose PR this is, in one word.
 *
 * The OPENER, and the first commit's author only as a fallback. These are the
 * same person most of the time and different exactly when it matters: push from
 * a work identity, open the PR from a personal one, and this line named the
 * committer while GitHub's named the opener — two accounts for one PR, on two
 * screens, with nothing saying which was which.
 */
function authorOf(pr: PullRequest): string {
  return pr.author === '' ? (pr.commits[0]?.author ?? 'someone') : pr.author;
}
