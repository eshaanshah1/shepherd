import type { ReactElement } from 'react';
import { Icon, namedGlyph } from '@shepherd/ui';
import {
  checksSaid,
  reviewSaid,
  stackLabel,
  stateWord,
  type PullRequest,
  type Said,
} from '../src/model/index.ts';

/**
 * One pull request, as a row of the review tab's home page (7a).
 *
 * Two lines and a fixed height, and the second line is the whole idea: the row
 * says everything you would open the PR to find out, so opening it is a choice
 * rather than the only way to know whether it needs you.
 *
 *   shepherd/sdk  Tab rows in the sdk        typecheck failed  ›
 *   #44 · +41 −2 · 3 files · 1 of 3 checks · no review yet
 *
 * **Repo first, number second.** That is how these are named out loud — "the sdk
 * one", not "forty-four" — and it is what makes a multi-repo task's list
 * scannable: the repo is the axis you are choosing along.
 *
 * The second line is mono and tabular. Everything on it is a count, and counts
 * in a proportional face do not line up between rows, which is the whole reason
 * to have a column of them.
 */

export function PrRow({
  pr,
  all,
  mark,
  selected,
  onOpen,
}: {
  readonly pr: PullRequest;
  /** Its siblings, so the row can say where it sits in a stack. */
  readonly all: readonly PullRequest[];
  /**
   * The repo's identity colour, as a ROLE name — `repo1`…`repo4`, assigned by
   * position in THIS list.
   *
   * By position rather than by a hash of the name, which is the same trade the
   * task card makes and for the same reason: a hash is stable across surfaces
   * and can collide within one, and the mark's only job is telling these repos
   * apart. A name, never a colour — an extension that wrote a hex would be a
   * visible bug the moment somebody swapped themes.
   */
  readonly mark: string;
  readonly selected: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  const state = stateWord(pr);
  const stack = stackLabel(pr, all);
  const review = reviewSaid(pr);

  return (
    <div
      className="sh-pr-row"
      role="button"
      tabIndex={0}
      data-selected={selected ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        // What a `<button>` would give for free. Space is prevented because its
        // default on a focused div is to scroll the list out from under the row.
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="sh-pr-row__head">
        {/*
          The repo's ROLE mark, which is the same one the task card gives it —
          a colour the task assigns by position, so the two surfaces agree about
          which repo is which without either naming a hue.
        */}
        <i className="sh-pr-row__mark" style={{ background: `var(--sh-${mark})` }} aria-hidden="true" />
        <span className="sh-pr-row__repo">{pr.repo}</span>
        <span className="sh-pr-row__title">{pr.title}</span>
        <Say said={state} className="sh-pr-row__state" />
        <Icon icon={namedGlyph('chevron-right')} size="sm" className="sh-pr-row__go" />
      </div>
      <div className="sh-pr-row__facts">
        <span>#{pr.number}</span>
        {stack === null ? null : (
          <>
            <Dot />
            <span className="sh-pr-row__stack">{stack}</span>
          </>
        )}
        <Dot />
        <span>
          <span className="sh-pr-row__added">+{pr.added}</span>{' '}
          <span className="sh-pr-row__removed">−{pr.removed}</span> · {pr.changedFiles}{' '}
          {pr.changedFiles === 1 ? 'file' : 'files'}
        </span>
        <Dot />
        <Say said={checksSaid(pr)} />
        {review === null ? null : (
          <>
            <Dot />
            <Say said={review} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A finished PR — one dimmed line, kept.
 *
 * The same treatment the rail gives shipped tasks, for the same reason: what
 * merged is the record of what you did, and a record is worth keeping visible
 * and worth costing nothing to look past. One step down the ink ramp, never an
 * `opacity`.
 */
export function ClosedPrRow({ pr, onOpen }: { readonly pr: PullRequest; readonly onOpen: () => void }): ReactElement {
  return (
    <div className="sh-pr-row sh-pr-row--closed" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="sh-pr-row__head">
        <span className="sh-pr-row__mark-slot" aria-hidden="true">
          {pr.state === 'merged' ? <Icon icon={namedGlyph('check')} size="sm" /> : null}
        </span>
        <span className="sh-pr-row__repo">{pr.repo}</span>
        <span className="sh-pr-row__title">{pr.title}</span>
        <span className="sh-pr-row__closed-meta">
          #{pr.number} · {pr.state}
        </span>
      </div>
    </div>
  );
}

/**
 * A phrase and its tone, drawn.
 *
 * The tone is a data attribute rather than a class per colour, so the stylesheet
 * owns which of the four roles each one is — the same division that keeps a
 * contributed row from naming a hue, applied to this extension's own pane
 * because the rule is about the palette rather than about who is writing.
 */
function Say({ said, className }: { readonly said: Said; readonly className?: string }): ReactElement {
  return (
    <span className={className} data-tone={said.tone}>
      {said.text}
    </span>
  );
}

const Dot = (): ReactElement => (
  <span className="sh-pr-row__sep" aria-hidden="true">
    ·
  </span>
);
