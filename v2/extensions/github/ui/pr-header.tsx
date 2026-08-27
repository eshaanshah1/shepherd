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

      {/*
        Who, where, and how much — as FACTS rather than a sentence.
        "wants to merge 3 commits into main from …" spent eleven words saying
        what an arrow says, and wrapped to two lines to do it. The arrow points
        the way the code travels: head → base, and the word it stands for is
        carried for anything not reading the glyph.
      */}
      <p className="sh-pr-brief__says">
        <span className="sh-pr-brief__who">{authorOf(pr)}</span>{' '}
        <span className="sh-pr-brief__ref">{pr.headRef}</span>{' '}
        <span className="sh-pr-brief__into" aria-hidden="true">
          →
        </span>
        <span className="sh-ui-sr-only"> into </span>{' '}
        <span className="sh-pr-brief__ref">{pr.baseRef}</span>
        {` · ${pr.commits.length} ${pr.commits.length === 1 ? 'commit' : 'commits'}`}
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
          /*
            Bordered, because when the merge is blocked this IS the one thing to
            do here. As a ghost it sat at the same volume as `Open on GitHub`
            beside it and at the same volume as the prose under it, so the row
            read as two words in the description rather than as controls.
          */
          wrapHand(
            'brief',
            <Button variant="secondary" size="sm" disabled={busy} onClick={onHand}>
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

/**
 * The facts, in the room the measure leaves over.
 *
 * Prose is capped at 76 characters because past that a line stops being
 * scannable — which on a wide pane leaves half the surface empty. That space was
 * the argument for the meta column the old pane had, and removing it did not
 * remove the argument; it just left the space blank.
 *
 * So they are here AND in the brief's one dim line, and the container query
 * picks. A CONTAINER query, not a viewport one: this pane can be split, so its
 * width is not the window's, and a media query would give a half-width pane the
 * full-width layout. It is the first in this codebase; it is also the first
 * surface whose own width is the question.
 *
 * On the RIGHT, which is the whole reason a second column is legal here at all —
 * the app's rail is on the left, and two lists shoulder to shoulder is the thing
 * that made the first attempt at this wrong.
 */
export function PrSide({
  pr,
  agent,
  task,
}: {
  readonly pr: PullRequest;
  readonly agent?: { readonly title: string; readonly state: string };
  readonly task?: { readonly title: string; readonly others: readonly string[] };
}): ReactElement {
  return (
    <aside className="sh-pr-side">
      <section className="sh-pr-side__block">
        <h3 className="sh-pr-side__label">Reviewers</h3>
        {pr.reviewers.length === 0 ? (
          <p className="sh-pr-side__none">Nobody yet</p>
        ) : (
          pr.reviewers.map((reviewer) => (
            <p key={reviewer.login} className="sh-pr-side__row">
              <span className="sh-pr-side__who">{reviewer.login}</span>
              <span className="sh-pr-side__note">{reviewer.verdict}</span>
            </p>
          ))
        )}
      </section>

      {agent === undefined ? null : (
        <section className="sh-pr-side__block">
          <h3 className="sh-pr-side__label">Agent</h3>
          <p className="sh-pr-side__row">
            <span className="sh-pr-side__who">{agent.title}</span>
          </p>
          <p className="sh-pr-side__note">{agent.state} · owns this branch</p>
        </section>
      )}

      {task === undefined ? null : (
        <section className="sh-pr-side__block">
          <h3 className="sh-pr-side__label">Task</h3>
          <p className="sh-pr-side__row">{task.title}</p>
          {task.others.length === 0 ? null : (
            <p className="sh-pr-side__note">lands with {task.others.join(', ')}</p>
          )}
        </section>
      )}
    </aside>
  );
}
