import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { getIconForType, processFile, SVGSpriteSheet } from '@pierre/diffs';
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react';
import { Button, Icon, KeyCap, namedGlyph } from '@shepherd/ui';
import { agoText } from './review-data.ts';
import { Markdown } from './markdown.tsx';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_THEME } from './diff-theme.ts';
import type { WrapHand } from './pr-detail.tsx';
import {
  isLineInDiff,
  unifiedPatch,
  type ChangedFile,
  type CheckRun,
  type Comment,
  type PullRequest,
  type ReviewThread,
} from '../src/model/index.ts';

/**
 * The four sub-views of one pull request.
 *
 * They are in one file because they are one decision: each tab is ONE job, and
 * the value of that is only legible when you can see the four side by side.
 * Split across four files, the third one grows a second job and nothing objects.
 *
 * What each is for, and the one rule that produced them:
 *
 *   conversation  the description, the threads, and — the Shepherd-specific
 *                 block — which agent owns this branch's worktree
 *   commits       what landed on the branch, newest first
 *   checks        names on the left, THAT check's log on the right
 *   files         paths on the left, THAT file's diff on the right, with review
 *                 comments where they were written
 *
 * Checks and Files are the only two with a second list, and both are the same
 * shape for the same reason: a name and its contents. That is a log viewer, not
 * navigation — the rule against two vertical rails is about NAVIGATION, and
 * neither of these moves you anywhere.
 */

export interface PanelProps {
  readonly pr: PullRequest;
  readonly now: number;
  readonly busy: boolean;
  readonly wrapHand: WrapHand;
  readonly onHandCheck: (check: CheckRun) => void;
  readonly onHandThread: (thread: ReviewThread) => void;
  readonly onOpenExternal: (url: string) => void;
  /** The agent that owns this branch's worktree, if one is live. */
  readonly agent?: { readonly title: string; readonly state: string };
  /** The task this PR belongs to, and its other PRs. */
  readonly task?: { readonly title: string; readonly others: readonly string[] };
  /**
   * "I need this PR's patches" — the Files tab asking, once, when it opens.
   *
   * A callback rather than the pane fetching up front, because that is the whole
   * point of the split: a diff is the largest thing about a PR and most people
   * never open this tab. The panel is the only thing that knows it is on screen.
   */
  readonly onNeedDiff: () => void;
  /**
   * "Give me this commit's files" — the Commits tab asking when one is opened.
   *
   * Returns them rather than folding them into the PR, because a commit's diff
   * is not a fact about the pull request: it is immutable, it is fetched once,
   * and nothing else on this surface reads it.
   */
  readonly onNeedCommit?: (sha: string) => Promise<readonly ChangedFile[] | null>;
}

// ------------------------------------------------------------- conversation

type TimelineEntry =
  | { readonly kind: 'comment'; readonly at: number; readonly comment: Comment }
  | { readonly kind: 'thread'; readonly at: number; readonly thread: ReviewThread };

/**
 * One list, in the order things were said.
 *
 * The two halves of a PR's conversation arrive as separate collections and mean
 * nothing apart: a line comment answered on the PR, or a bot's gate posted
 * between two threads, reads as a non-sequitur in either list alone. GitHub
 * merges them and so does this.
 *
 * Ties keep comments ahead of threads, which is arbitrary and only has to be
 * stable — `sort` is not, and a list that reshuffles on every repaint is worse
 * than one whose ties are in the wrong order.
 */
export function timelineOf(pr: PullRequest): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...pr.comments.map((comment) => ({ kind: 'comment' as const, at: comment.at, comment })),
    ...pr.threads.map((thread) => ({ kind: 'thread' as const, at: thread.at, thread })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}


export function Conversation({
  pr,
  now,
  busy,
  wrapHand,
  onHandThread,
  agent,
  task,
}: PanelProps): ReactElement {
  return (
    <div className="sh-pr-panel sh-pr-panel--split">
      <div className="sh-pr-thread">
        {pr.body === '' ? null : (
          /*
            The description: no card, and no byline.

            NOT A CARD, though the threads under it are. A card is a boundary,
            and a boundary answers "where does this one end and the next begin" —
            a real question about a list of comments and no question at all
            about the one description. Boxed, it read as the first of several
            equal things; it is the thing the several are about. It is also the
            longest thing on this surface, and an inset border down a hundred
            lines is a frame around a page.

            NO BYLINE, because the header already is one. It says `<author>
            wants to merge N commits into <base> · <age>` — built from
            `pr.commits[0].author` and `agoText(pr.openedAt)`, the same
            expression this line called and the same field it read. Two facts,
            twice, one screen apart, and this copy was the one with nothing
            around it to make it mean anything.
          */
          <article className="sh-pr-body">
            {/*
              Markdown, because an AGENT writes this field.
              
              It used to split on blank lines and emit paragraphs, on the
              argument that a body is usually two sentences. That is a human's
              PR. The bodies this app exists to show are written by an agent, and
              they are headings, fenced commands and lists — flattened, a real
              one is a wall of prose with the description, the reproduction and
              the test plan indistinguishable. Measured on `cli/cli#14136`.
            */}
            <Markdown text={pr.body} />
          </article>
        )}

        {timelineOf(pr).map((entry) =>
          entry.kind === 'comment' ? (
            <article key={entry.comment.id} className="sh-pr-card">
              <header className="sh-pr-card__who">
                <span className="sh-pr-card__login">@{entry.comment.author}</span>
                <span className="sh-pr-card__when">{agoText(entry.comment.at, now) ?? ''}</span>
              </header>
              {/*
                Markdown, and a bot's comment is the reason. The one that matters
                most on this surface is a gate reporting itself, which it does in
                fenced commands and bold status names — flattened, the command
                you are meant to run is a sentence.
              */}
              <Markdown text={entry.comment.body} />
            </article>
          ) : (
            <ThreadCard
              key={entry.thread.id}
              thread={entry.thread}
              url={pr.url}
              busy={busy}
              wrapHand={wrapHand}
              onHandThread={onHandThread}
            />
          ),
        )}

        {pr.threads.length === 0 && pr.comments.length === 0 && pr.body === '' ? (
          <p className="sh-pr-panel__none">Nothing has been said about this yet.</p>
        ) : null}
      </div>

      {/*
        The meta column, and it is NOT a nav rail — every line in it is a fact
        about this PR, and none of them moves you anywhere. That distinction is
        what makes a second column legal here at all.
      */}
      <aside className="sh-pr-meta">
        <section>
          <h3 className="sh-pr-meta__label">Reviewers</h3>
          {pr.reviewers.length === 0 ? (
            <p className="sh-pr-meta__none">Nobody yet</p>
          ) : (
            pr.reviewers.map((reviewer) => (
              <div key={reviewer.login} className="sh-pr-meta__row">
                <span className="sh-pr-card__mark" data-state={markFor(reviewer.verdict)} aria-hidden="true">
                  {reviewer.verdict === 'approved' ? <Icon icon={namedGlyph('check')} size="sm" /> : null}
                </span>
                <span className="sh-pr-card__login">@{reviewer.login}</span>
                <span className="sh-pr-meta__said">{saidBy(reviewer)}</span>
              </div>
            ))
          )}
        </section>

        {/*
          The one block on this surface that GitHub could not draw: which agent
          is in this branch's worktree, and what it is doing. It is the answer to
          "who do I hand this to" before you press the button — and the reason
          the review tab is in this app rather than a browser tab.
        */}
        {agent === undefined ? null : (
          <section>
            <h3 className="sh-pr-meta__label">Agent</h3>
            <div className="sh-pr-meta__row">
              <span className="sh-pr-card__mark" data-state="resting" aria-hidden="true" />
              <span className="sh-pr-meta__agent">{agent.title}</span>
              <span className="sh-pr-meta__said">{agent.state}</span>
            </div>
            <p className="sh-pr-meta__note">owns this branch’s worktree</p>
          </section>
        )}

        {task === undefined ? null : (
          <section>
            <h3 className="sh-pr-meta__label">Task</h3>
            <p className="sh-pr-meta__task">{task.title}</p>
            {task.others.length === 0 ? null : (
              <p className="sh-pr-meta__note">
                {task.others.length} more {task.others.length === 1 ? 'PR' : 'PRs'} · {task.others.join(' ')}
              </p>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

const markFor = (verdict: 'approved' | 'changes' | 'commented'): string =>
  verdict === 'approved' ? 'approved' : verdict === 'changes' ? 'waiting' : 'resting';

const saidBy = (reviewer: { verdict: string; comments: number }): string => {
  if (reviewer.verdict === 'approved') return 'approved';
  if (reviewer.verdict === 'changes') return 'changes requested';
  return `${reviewer.comments} ${reviewer.comments === 1 ? 'comment' : 'comments'}`;
};

/**
 * One thread of the diff, as it appears in the conversation.
 *
 * Its own component because the timeline is a ternary over two card shapes, and
 * a branch that long written inline is one nobody can see the ends of.
 */
function ThreadCard({
  thread,
  url,
  busy,
  wrapHand,
  onHandThread,
}: {
  readonly thread: ReviewThread;
  readonly url: string;
  readonly busy: boolean;
  readonly wrapHand: WrapHand;
  readonly onHandThread: (thread: ReviewThread) => void;
}): ReactElement {
  return (
    <article className="sh-pr-card" data-resolved={thread.resolved ? 'true' : undefined}>
      <header className="sh-pr-card__who">
        <span className="sh-pr-card__mark" data-state={thread.resolved ? 'resolved' : 'waiting'} aria-hidden="true">
          {thread.resolved ? <Icon icon={namedGlyph('check')} size="sm" /> : null}
        </span>
        <span className="sh-pr-card__login">@{thread.author}</span>
        <span>on</span>
        <span className="sh-pr-card__where">
          {thread.path}
          {thread.line === null ? '' : `:${thread.line}`}
        </span>
      </header>
      {/* A review comment is markdown too, and an agent's is code more often than not. */}
      <Markdown text={thread.body} />
      {thread.resolved ? null : (
        <div className="sh-pr-card__verbs">
          {wrapHand(
            `thread:${thread.id}`,
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onHandThread(thread)}>
              Hand to agent
              <KeyCap>H</KeyCap>
            </Button>,
          )}
          {/*
            Reply goes OUT. Writing a comment needs an editor, a draft, a
            submit and a failure state, and none of that is what this pane
            is for — the pane exists to get a comment to an agent. The
            arrow says it leaves.
          */}
          <Button variant="ghost" size="sm" onClick={() => window.open(url, '_blank')}>
            Reply ↗
          </Button>
        </div>
      )}
    </article>
  );
}

// ----------------------------------------------------------------- commits

export function Commits({ pr, now, busy, wrapHand, onHandThread, onNeedCommit }: PanelProps): ReactElement {
  /*
   * Which commit is open, and what it changed.
   *
   * A sha rather than an index, because the list re-sorts under a sync and an
   * index would then point at a different commit than the one that was clicked.
   * `files` is `undefined` while the fetch is out and `[]` for a commit that
   * genuinely touched nothing — two states a single empty array cannot hold.
   */
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly ChangedFile[] | undefined>(undefined);

  useEffect(() => {
    if (open === null) return;
    let live = true;
    setFiles(undefined);
    void (async () => {
      const answer = await onNeedCommit?.(open);
      // The component may have moved on — closed, or opened another commit —
      // while this was in flight, and writing then would show one commit's
      // diff under another's heading.
      if (live) setFiles(answer ?? []);
    })();
    return () => {
      live = false;
    };
  }, [open, onNeedCommit]);

  if (pr.commits.length === 0) {
    return <p className="sh-pr-panel__none">No commits on this branch yet.</p>;
  }

  const shown = pr.commits.find((commit) => commit.sha === open);
  if (shown !== undefined) {
    return (
      <div className="sh-pr-panel sh-pr-panel--list sh-pr-panel--stack">
        {/*
          The way back, which a surface that replaced itself has to have. It
          names the commit rather than saying `Back`, so the row says where you
          are as well as how to leave.
        */}
        <button type="button" className="sh-pr-diff__head sh-ui-focusable" onClick={() => setOpen(null)}>
          <Icon icon={namedGlyph('chevron-left')} size="sm" />
          <span className="sh-pr-commit__sha">{shown.sha.slice(0, 7)}</span>
          <span className="sh-pr-diff__path">{shown.subject}</span>
          <span className="sh-pr-diff__count" data-tone="added">
            +{shown.added}
          </span>
          <span className="sh-pr-diff__count" data-tone="removed">
            −{shown.removed}
          </span>
        </button>
        <DiffList
          pr={pr}
          files={files ?? []}
          /* Keyed on the SHA alone: a commit is immutable, so its rendered
             result can be cached for as long as the app lives. */
          cacheKey={shown.sha}
          busy={busy}
          wrapHand={wrapHand}
          onHandThread={onHandThread}
          pending={files === undefined}
        />
      </div>
    );
  }

  return (
    <div className="sh-pr-panel">
      {pr.commits.map((commit) => (
        /*
         * A row that opens its own diff, so it is a button.
         *
         * "What did this one commit do" is the question a list of subjects
         * raises and cannot answer, and the answer is one request away — a
         * commit is immutable, so it is fetched once and held.
         */
        <button
          key={commit.sha}
          type="button"
          className="sh-pr-commit sh-ui-focusable"
          onClick={() => setOpen(commit.sha)}
        >
          {/* Seven characters, which is what git itself abbreviates to and what
              a person types when they want one. */}
          <span className="sh-pr-commit__sha">{commit.sha.slice(0, 7)}</span>
          <span className="sh-pr-commit__subject">{commit.subject}</span>
          <span className="sh-pr-diff__count" data-tone="added">
            +{commit.added}
          </span>
          <span className="sh-pr-diff__count" data-tone="removed">
            −{commit.removed}
          </span>
          <span className="sh-pr-commit__who">{commit.author}</span>
          <span className="sh-pr-commit__when">{agoText(commit.at, now) ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ checks

export function Checks({ pr, busy, wrapHand, onHandCheck, onOpenExternal }: PanelProps): ReactElement {
  const failing = pr.checks.find((check) => check.state === 'failed');
  const [at, setAt] = useState<string | null>(failing?.name ?? pr.checks[0]?.name ?? null);
  const shown = pr.checks.find((check) => check.name === at) ?? pr.checks[0];

  if (pr.checks.length === 0 || shown === undefined) {
    return <p className="sh-pr-panel__none">Nothing has run on this branch.</p>;
  }

  return (
    <div className="sh-pr-panel sh-pr-panel--list">
      <div className="sh-pr-list">
        {pr.checks.map((check) => (
          <button
            key={check.name}
            type="button"
            className="sh-pr-list__row"
            data-at={check.name === shown.name ? 'true' : undefined}
            data-state={check.state}
            onClick={() => setAt(check.name)}
          >
            <span className="sh-pr-list__mark" aria-hidden="true">
              <CheckMark state={check.state} />
            </span>
            <span className="sh-pr-list__name">{check.name}</span>
            <span className="sh-pr-list__meta">
              {check.state === 'skipped' ? 'skipped' : durationText(check.durationMs)}
            </span>
            <span className="sh-ui-sr-only">{check.state}</span>
          </button>
        ))}
      </div>

      <div className="sh-pr-log">
        <pre className="sh-pr-log__text">
          {shown.log ?? shown.summary ?? 'GitHub has no output for this check.'}
        </pre>
        <div className="sh-pr-log__foot">
          {wrapHand(
            'check',
            <Button variant="primary" size="sm" disabled={busy || shown.state !== 'failed'} onClick={() => onHandCheck(shown)}>
              Hand to agent
              <KeyCap>H</KeyCap>
            </Button>,
          )}
          {shown.url === undefined ? null : (
            <Button variant="ghost" size="sm" onClick={() => onOpenExternal(shown.url as string)}>
              Full log ↗
            </Button>
          )}
          <span className="sh-pr-log__spacer" />
          <span className="sh-pr-log__note">
            {shown.state === 'failed' ? 'sends the output and the failing file' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The mark for one check, for the two states that carry a glyph.
 *
 * Everything else in this column is a CSS shape on the slot — a filled square
 * for a failure, a ring for a run in flight — and stays there. A glyph is spent
 * on the two states a shape cannot say: `passed`, which is the tick every forge
 * draws, and `queued`, which is a ring with holes in it because the check has
 * been reserved and nothing has reported.
 *
 * `blocked` deliberately has no glyph. It is honey's other case — GitHub
 * finished and a human must act — and it wears the FAILED shape in honey,
 * because it is the other state that is actually stopping you and the column
 * should say so with the same silhouette.
 */
function CheckMark({ state }: { readonly state: CheckRun['state'] }): ReactElement | null {
  if (state === 'passed') return <Icon icon={namedGlyph('check')} size="sm" />;
  if (state === 'queued') return <Icon icon={namedGlyph('circle-dashed')} size="sm" />;
  return null;
}

const durationText = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/**
 * Why there is no diff, which is not one answer.
 *
 * "The diff for this file has not been fetched" was drawn for every patchless
 * file, and for most of them it was false. A rename with no edits has NOTHING
 * to diff — GitHub sends no patch because there is none — and this PR had six
 * of them from one directory move, every one reported as a fetch that had not
 * happened. Telling somebody to wait for something that will never arrive is
 * worse than saying nothing.
 */
export function noDiffReason(file: ChangedFile): string {
  if (file.status === 'renamed' && file.added === 0 && file.removed === 0) {
    return file.previousPath === undefined
      ? 'Renamed. Its contents did not change, so there is no diff.'
      : `Renamed from ${file.previousPath}. Its contents did not change, so there is no diff.`;
  }
  if (file.added === 0 && file.removed === 0) return 'No changes to show — its contents are identical.';
  /*
   * Binary, or over GitHub's per-file limit. Both are GitHub declining to send
   * a patch it HAS, which is a different thing from one nobody asked for — and
   * the only one of these three where going to GitHub is worth the trip.
   */
  return 'GitHub did not send a diff for this file. Open it on GitHub to see the change.';
}

// ------------------------------------------------------------------- files

/** Over this many changed lines, a file opens folded. */
const FOLD_OVER = 500;

/**
 * What happened to a file, as `@pierre/diffs`' OWN mark.
 *
 * The package draws one in the header we replaced, and losing it is what took
 * this fact off the row. It is `getIconForType` and the package's sprite rather
 * than a lookalike from our glyph set: the same shape, from the same source, so
 * it cannot drift from the one the library still draws elsewhere.
 *
 * The counts beside it can only tell three of the five apart — a new file and
 * an edit are both additions, and a pure rename is `+0 −0`, which is the shape
 * of nothing happening at all.
 *
 * Only two hues, and both agree with the counts they sit next to: grass for a
 * file that arrived, red for one that went. An edit and a move take the quiet
 * ink, because the palette's hues are spoken for by state and a third one here
 * would be a colour meaning "ordinary".
 */
function changeMark(file: ChangedFile): { readonly symbol: string; readonly tone: string } {
  const moved = file.added + file.removed === 0 ? 'rename-pure' : 'rename-changed';
  if (file.status === 'added') return { symbol: getIconForType('new'), tone: 'added' };
  if (file.status === 'removed') return { symbol: getIconForType('deleted'), tone: 'removed' };
  if (file.status === 'renamed' || file.status === 'copied')
    return { symbol: getIconForType(moved), tone: 'quiet' };
  /*
   * No status is the case worth naming: GitHub sends it on the REST call that
   * carries the patch, so a file described only by the list query has none. An
   * edit is the honest default — it is what most files in most PRs are, and the
   * counts are right there to correct it.
   */
  return { symbol: getIconForType('change'), tone: 'quiet' };
}

/**
 * The sprite those marks are `<use>`d from, mounted once into the light DOM.
 *
 * `<use href="#id">` resolves inside the tree it is written in, and the
 * package's own copy lives in ITS shadow root — out of reach of a header we
 * render ourselves. So the sheet has to exist beside our marks.
 *
 * `innerHTML` of a package CONSTANT, which is a different act from the one
 * `markdown.tsx` refuses: that file will not turn a pull request BODY into
 * markup because a body is written by anyone who can open a PR. This string is
 * an import — it is in the bundle, it is the same on every render, and no
 * caller can reach it.
 */
function DiffSprite(): ReactElement {
  const host = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (host.current !== null && host.current.childElementCount === 0) {
      host.current.innerHTML = SVGSpriteSheet;
    }
  }, []);
  return <span ref={host} aria-hidden="true" hidden />;
}

/** One mark, from the sprite above. */
function ChangeMark({ file }: { readonly file: ChangedFile }): ReactElement {
  const mark = changeMark(file);
  return (
    <span className="sh-pr-diff__mark" data-tone={mark.tone} title={file.status ?? 'modified'}>
      <svg width="14" height="14" viewBox="0 0 16 16" role="img" aria-label={file.status ?? 'modified'}>
        <use href={`#${mark.symbol}`} />
      </svg>
    </span>
  );
}

/**
 * The two heights the virtualiser has to be told, because it reserves space
 * before there is anything to measure.
 *
 * `DIFF_HEAD_HEIGHT` is `.sh-pr-diff__head` rendered — 12.5px text, two
 * `space-sm` of padding and a hairline. `DIFF_LINE_HEIGHT` is
 * `--diffs-line-height` from `diff-theme.ts`. Both are measured values kept in
 * step by hand; there is no way to ask the DOM before the DOM exists.
 */
const DIFF_HEAD_HEIGHT = 29;
const DIFF_LINE_HEIGHT = 18;

/**
 * A file's review threads, split by whether the diff can actually show them.
 *
 * **A thread naming a file is not the same as a thread the diff can show.** Its
 * line may have moved out of the change since it was written, or sit in a hunk
 * nobody asked for. Pinning it anyway puts the remark against whatever code now
 * occupies that line number — a comment about a function attached to an import,
 * with nothing saying so. Dropping it loses the conversation.
 *
 * The SIDE is read rather than assumed, for the same class of reason: a comment
 * on a removed line belongs beside the code that went away, not beside the code
 * that replaced it.
 */
function threadsOn(pr: PullRequest, path: string, patch: string | null) {
  const here = pr.threads.filter((thread) => thread.path === path && !thread.resolved);
  const placed = here.filter(
    (thread) => patch !== null && thread.line !== null && isLineInDiff(patch, thread.side, thread.line),
  );
  return {
    adrift: here.filter((thread) => !placed.includes(thread)),
    annotations: placed.flatMap((thread) =>
      thread.line === null
        ? []
        : [
            {
              side: thread.side === 'left' ? ('deletions' as const) : ('additions' as const),
              lineNumber: thread.line,
              metadata: thread,
            },
          ],
    ),
  };
}

/**
 * Every file of a change, in one scroll.
 *
 * Shared by the Files tab (a whole PR) and the Commits tab (one commit),
 * because they are the same surface asked two questions. What differs is only
 * which files are handed in and what the cache key is; everything below —
 * folding, the header, the threads, the files with nothing to draw — is the
 * same work either way, and a second copy of it would drift within a week.
 */
function DiffList({
  pr,
  files,
  cacheKey,
  busy,
  wrapHand,
  onHandThread,
  viewerRef,
  pending,
}: {
  readonly pr: PullRequest;
  readonly files: readonly ChangedFile[];
  readonly cacheKey: string;
  readonly busy: boolean;
  readonly wrapHand: WrapHand;
  readonly onHandThread: (thread: ReviewThread) => void;
  readonly viewerRef?: RefObject<CodeViewHandle<ReviewThread> | null>;
  /** The fetch has not answered yet, so nothing here is classifiable. */
  readonly pending: boolean;
}): ReactElement {
  /*
   * Which files the user has folded or unfolded, and NOTHING about the rest.
   *
   * A map of decisions rather than a set of folded paths, because the default is
   * not "open": anything over `FOLD_OVER` lines starts folded, and a set cannot
   * tell "they folded it" from "it was born folded" — so unfolding a big file
   * would last until the next render and then snap shut.
   */
  const [decided, setDecided] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isFolded = (file: ChangedFile): boolean =>
    decided.get(file.path) ?? file.added + file.removed > FOLD_OVER;
  const toggle = (path: string, next: boolean): void =>
    setDecided((was) => new Map(was).set(path, next));

  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  /*
   * One item per file that HAS a diff, in the order it was listed.
   *
   * `processFile` rather than `parsePatchFiles`: we already hold one patch per
   * file, so re-joining them into one document only to have the library split it
   * again would put a parser between us and a mapping we already have.
   */
  const items = useMemo(
    () =>
      files.flatMap((file) => {
        const patch = unifiedPatch(file);
        if (patch === null) return [];
        const fileDiff = processFile(patch, { cacheKey: `${cacheKey}:${file.path}`, isGitDiff: true });
        if (fileDiff === undefined) return [];
        const folded = decided.get(file.path) ?? file.added + file.removed > FOLD_OVER;
        return [
          {
            id: file.path,
            type: 'diff' as const,
            fileDiff,
            annotations: threadsOn(pr, file.path, patch).annotations,
            collapsed: folded,
            /*
             * The version, WITHOUT which folding does nothing. The viewer keeps
             * its own record per item id and short-circuits on
             * `version === nextItem.version` — and `undefined === undefined`, so
             * a new array with a flipped `collapsed` read as the same item and
             * was dropped. React owns the header, so the chevron turned and the
             * body did not.
             */
            version: pr.updatedAt * 2 + (folded ? 1 : 0),
          },
        ];
      }),
    [cacheKey, files, decided, pr],
  );

  const adrift = useMemo(
    () => files.flatMap((file) => threadsOn(pr, file.path, unifiedPatch(file)).adrift),
    [files, pr],
  );
  const undiffable = pending ? [] : files.filter((file) => unifiedPatch(file) === null);

  const note = (thread: ReviewThread, adriftMark: boolean): ReactElement => (
    <div key={thread.id} className="sh-pr-diff__note" data-adrift={adriftMark ? 'true' : undefined}>
      <span className="sh-pr-card__mark" data-state="waiting" aria-hidden="true" />
      <span className="sh-pr-diff__note-text">
        <span className="sh-pr-card__login">@{thread.author}</span> · {thread.body}
      </span>
      {adriftMark ? <span className="sh-pr-diff__adrift">not on this diff</span> : null}
      {wrapHand(
        `thread:${thread.id}`,
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHandThread(thread)}>
          Hand to agent
        </Button>,
      )}
    </div>
  );

  return (
    <div className="sh-pr-diff">
      <DiffSprite />
      <CodeView<ReviewThread>
        {...(viewerRef === undefined ? {} : { ref: viewerRef })}
        className="sh-pr-diff__view"
        items={items}
        options={{
          /*
           * One theme for both modes, registered from this app's own tokens —
           * see `diff-theme.ts`. It replaced `github-dark-default`, whose
           * `#0d1117` background is GitHub's navy and read as a blue panel
           * against a pane of true neutrals.
           */
          theme: SHEPHERD_DIFF_THEME,
          unsafeCSS: SHEPHERD_DIFF_CSS,
          /*
           * Unified, and wrapped — two halves of the same decision, which is
           * that this diff has to end where the pane does. The library defaults
           * to `split` at `overflow: scroll`, which halves an already-narrow
           * column and then puts the rest of every line behind a 6px scrollbar
           * that is transparent until hover.
           */
          diffStyle: 'unified',
          overflow: 'wrap',
          /*
           * What the virtualiser RESERVES, which has to match what we draw. It
           * sizes the scroll before a file is built, from these numbers rather
           * than from the DOM — so a value too large leaves a band of nothing
           * above every file. The defaults describe the package's own chrome, a
           * 44px header and 20px lines, against our 29 and 18.
           */
          itemMetrics: {
            diffHeaderHeight: DIFF_HEAD_HEIGHT,
            lineHeight: DIFF_LINE_HEIGHT,
            spacing: 4,
            paddingTop: 0,
            paddingBottom: 4,
          },
          layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        }}
        disableWorkerPool
        renderCodeViewHeader={() =>
          adrift.length === 0 ? null : <>{adrift.map((thread) => note(thread, true))}</>
        }
        renderCodeViewFooter={() =>
          pending ? (
            <p className="sh-pr-panel__none">Fetching the diffs…</p>
          ) : undiffable.length === 0 ? null : (
            <>
              {undiffable.map((file) => {
                const moved = file.status === 'renamed' && file.previousPath !== undefined;
                return (
                  /*
                   * A move is drawn as a MOVE — `old → new` — rather than
                   * described in a sentence. The one fact about a renamed file
                   * is where it went, and two paths with an arrow between them
                   * say it in the shape of the thing. The sentence stays as the
                   * row's title, so a screen reader still gets a sentence.
                   */
                  <div key={file.path} className="sh-pr-diff__quiet" title={noDiffReason(file)}>
                    <ChangeMark file={file} />
                    {moved ? (
                      <>
                        <span className="sh-pr-diff__path">{file.previousPath}</span>
                        <span className="sh-pr-diff__arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="sh-pr-diff__path">{file.path}</span>
                      </>
                    ) : (
                      <>
                        <span className="sh-pr-diff__path">{file.path}</span>
                        <span className="sh-pr-diff__reason">{noDiffReason(file)}</span>
                      </>
                    )}
                  </div>
                );
              })}
            </>
          )
        }
        renderCustomHeader={(item) => {
          const file = byPath.get(item.id);
          if (file === undefined) return null;
          const folded = isFolded(file);
          return (
            <button
              type="button"
              className="sh-pr-diff__head sh-ui-focusable"
              aria-expanded={!folded}
              onClick={() => toggle(file.path, !folded)}
            >
              <Icon icon={namedGlyph(folded ? 'chevron-right' : 'chevron')} size="sm" />
              <ChangeMark file={file} />
              <span className="sh-pr-diff__path">{file.path}</span>
              <span className="sh-pr-diff__count" data-tone="added">
                +{file.added}
              </span>
              <span className="sh-pr-diff__count" data-tone="removed">
                −{file.removed}
              </span>
            </button>
          );
        }}
        renderAnnotation={(annotation) => note(annotation.metadata, false)}
      />
    </div>
  );
}

/**
 * Has the diff fetch answered yet?
 *
 * A file that changed lines and has no patch is UNKNOWN, not undiffable. For the
 * first moment after a tab opens every file is patchless, and saying so listed
 * all of them as "nothing to show" a beat before the patches arrived — a wrong
 * answer drawn confidently and then corrected, which is what the flash was.
 */
function stillFetching(files: readonly ChangedFile[]): boolean {
  return !files.some((file) => file.patch !== undefined) && files.some((file) => file.added + file.removed > 0);
}

export function Files({ pr, busy, wrapHand, onHandThread, onNeedDiff }: PanelProps): ReactElement {
  const files = pr.files ?? [];
  /*
   * Asked for on mount, and again only if the PR changes under us.
   *
   * **The callback is held in a ref and is NOT a dependency**, and that is the
   * bug this comment exists for. Depending on it makes the effect re-run on
   * every render for any parent that passes an inline arrow — and the fetch it
   * fires causes a re-render, so it re-runs forever. Measured: the test that
   * asserts this ask timed out at five seconds.
   */
  const key = `${pr.repo}#${pr.number}@${pr.updatedAt}`;
  const need = useRef(onNeedDiff);
  need.current = onNeedDiff;
  useEffect(() => {
    need.current();
  }, [key]);

  const paths = useMemo(() => files.map((file) => file.path), [files]);
  /*
   * Pierre's tree, not a list of buttons. `compact` is the package's own density
   * preset, and asking for it is the supported way: that value is written INLINE
   * on the host from this option, so a `--trees-item-height` in our stylesheet
   * is silently outranked.
   */
  const tree = useFileTree({ paths, density: 'compact' });
  const selected = useFileTreeSelection(tree.model);
  const at = selected[0];
  const viewer = useRef<CodeViewHandle<ReviewThread> | null>(null);

  /*
   * The tree JUMPS rather than selects.
   *
   * Every file is on screen now, in one scroll, so clicking a path is a request
   * to be taken to it — not a request to be shown it instead of the others.
   */
  useEffect(() => {
    if (at === undefined) return;
    viewer.current?.scrollTo({ type: 'item', id: at, align: 'start' });
  }, [at]);

  if (files.length === 0) return <p className="sh-pr-panel__none">No files on this pull request.</p>;

  return (
    <div className="sh-pr-panel sh-pr-panel--list">
      <FileTree className="sh-pr-tree" model={tree.model} />
      <DiffList
        pr={pr}
        files={files}
        cacheKey={key}
        busy={busy}
        wrapHand={wrapHand}
        onHandThread={onHandThread}
        viewerRef={viewer}
        pending={stillFetching(files)}
      />
    </div>
  );
}
