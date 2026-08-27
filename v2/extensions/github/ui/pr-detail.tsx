import { useState, type ReactElement } from 'react';
import { Button, SectionLabel } from '@shepherd/ui';
import { PrBrief } from './pr-header.tsx';
import {
  CommitDiff,
  Description,
  FilesDiff,
  FilesList,
  Checks,
  Commits,
  Talk,
  type PanelProps,
} from './pr-panels.tsx';
import { canMerge, countChecks, firstFailure, type ChangedFile, type PullRequest } from '../src/model/index.ts';

/**
 * One pull request, as ONE DOCUMENT.
 *
 * It was four tabs over a fixed header and a footer. Tabs are a good answer when
 * their contents compete for the same rectangle and you only ever want one; they
 * are the wrong answer here, because the four things a PR is — what it says, what
 * was said about it, what ran, what changed — are read together. Three quarters
 * of a pull request being one click away is three quarters of it you do not look
 * at, and the counts on the tabs existed to paper over exactly that.
 *
 * So everything is in one scroll and the headings are the navigation. Five
 * sections do not need a control strip to move between them, and removing it
 * took a whole band out of a surface that had three.
 *
 * **Two things still take the pane over**, and both are the same kind of thing:
 * a diff. A file's patch and a commit's are the largest objects here by an order
 * of magnitude, they carry their own tree, and they are a place you GO rather
 * than a section you scroll past. The Commits tab already worked this way and
 * already had the way back; this generalises it rather than inventing it.
 */

type Open = { readonly kind: 'doc' } | { readonly kind: 'files' } | { readonly kind: 'commit'; readonly sha: string };

/**
 * The hand menu's wrapper — see `review.tsx`.
 *
 * The `at` key is which button asked (`check`, `brief`, `thread:<id>`), so only
 * the one you pressed opens. Identity, not decoration: a menu that opened under
 * the brief when you pressed a thread's button would point at the wrong thing.
 */
export type WrapHand = (at: string, button: ReactElement) => ReactElement;

export interface PrActions {
  readonly onMerge: () => void;
  readonly onHandCheck: PanelProps['onHandCheck'];
  readonly onHandThread: PanelProps['onHandThread'];
  readonly onHandReview: (check?: string) => void;
  readonly onOpenExternal: (url: string) => void;
}

export function PrDetail({
  pr,
  actions,
  busy,
  wrapHand,
  now,
  agent,
  task,
  onNeedDiff,
  onNeedCommit,
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
  readonly onNeedCommit?: (sha: string) => Promise<readonly ChangedFile[] | null>;
}): ReactElement {
  /*
   * Where you are, as ONE value.
   *
   * It was `useState<PrTab>` seeded from `firstFailure` — the pane opened on
   * Checks when something was red, because landing on Conversation and making
   * you find it would be the pane knowing something and not saying it. With one
   * document that seed is unnecessary: a failing check is in the same scroll as
   * everything else, and `mergeGate` says so in the first sentence.
   */
  const [open, setOpen] = useState<Open>({ kind: 'doc' });
  const failure = firstFailure(pr);
  const threads = pr.threads.filter((thread) => !thread.resolved);
  const checks = countChecks(pr.checks);

  const shared = {
    pr,
    now,
    busy,
    wrapHand,
    onHandCheck: actions.onHandCheck,
    onHandThread: actions.onHandThread,
    onOpenExternal: actions.onOpenExternal,
    onNeedDiff,
    ...(onNeedCommit === undefined ? {} : { onNeedCommit }),
    ...(agent === undefined ? {} : { agent }),
    ...(task === undefined ? {} : { task }),
  } satisfies PanelProps;

  if (open.kind === 'files') {
    return (
      <div className="sh-pr-detail">
        <Away what={`${pr.changedFiles} files`} onBack={() => setOpen({ kind: 'doc' })} />
        <FilesDiff {...shared} />
      </div>
    );
  }

  if (open.kind === 'commit') {
    return (
      <div className="sh-pr-detail">
        <Away what="the commit" onBack={() => setOpen({ kind: 'doc' })} />
        <CommitDiff {...shared} sha={open.sha} />
      </div>
    );
  }

  return (
    <div className="sh-pr-detail">
      <div className="sh-pr-doc">
        <PrBrief
          pr={pr}
          now={now}
          busy={busy}
          wrapHand={wrapHand}
          {...(agent === undefined ? {} : { agent })}
          {...(task === undefined ? {} : { task })}
          onMerge={actions.onMerge}
          onHand={() => actions.onHandReview(failure?.name)}
          onOpenExternal={actions.onOpenExternal}
        />

        <Description pr={pr} />

        <section className="sh-pr-sec">
          <SectionLabel count={pr.comments.length + pr.threads.length}>Conversation</SectionLabel>
          <Talk {...shared} />
        </section>

        {pr.checks.length === 0 ? null : (
          <section className="sh-pr-sec">
            <SectionLabel count={`${checks.passed}/${checks.total}`}>Checks</SectionLabel>
            <Checks {...shared} />
          </section>
        )}

        {pr.commits.length === 0 ? null : (
          <section className="sh-pr-sec">
            <SectionLabel count={pr.commits.length}>Commits</SectionLabel>
            <Commits {...shared} onOpen={(sha) => setOpen({ kind: 'commit', sha })} />
          </section>
        )}

        <section className="sh-pr-sec">
          <SectionLabel count={pr.changedFiles}>Files</SectionLabel>
          <FilesList {...shared} onOpen={() => setOpen({ kind: 'files' })} />
        </section>
      </div>

      {/*
        `canMerge` and the open threads are read here only to keep the keys
        honest — the verbs themselves live in the brief now, at the top of the
        document where the verdict is.
      */}
      <span hidden data-mergeable={canMerge(pr) ? 'true' : 'false'} data-threads={threads.length} />
    </div>
  );
}

/**
 * The way back from a surface that replaced the pane.
 *
 * It names what you left rather than saying `Back`, so the row says where you
 * are as well as how to leave — the same line the Commits tab already drew, now
 * that two places need it.
 */
function Away({ what, onBack }: { readonly what: string; readonly onBack: () => void }): ReactElement {
  return (
    <div className="sh-pr-away">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ‹ Back to the pull request
      </Button>
      <span className="sh-pr-away__what">{what}</span>
    </div>
  );
}
