import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { getIconForType, processFile, SVGSpriteSheet } from '@pierre/diffs';
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react';
import { Button, Icon, SectionLabel, namedGlyph } from '@shepherd/ui';
import { agoText } from './review-data.ts';
import { Markdown } from './markdown.tsx';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_SIZING, SHEPHERD_DIFF_THEME } from './diff-theme.ts';
import type { WrapHand } from './pr-detail.tsx';
import {
  authorTint,
  avatarIsReal,
  firstFailure,
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


/**
 * A section that cannot grow without bound.
 *
 * In a single scroll, one verbose section pushes everything under it past the
 * fold — and the sections here are exactly the ones whose length nobody
 * controls: an agent's description runs to a hundred lines, a bot's audit
 * report to forty. Left alone, where Files sits depends on how talkative the
 * agent was that day, and the order stops being a table of contents you can
 * learn.
 *
 * So each one is capped at a share of the pane and grows in place when asked.
 * The button appears ONLY when there is something behind it — measured, because
 * a control that reveals nothing is worse than no control.
 */
export function Clamp({ children }: { readonly children: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = box.current;
    if (node === null) return;
    const measure = (): void => setOver(node.scrollHeight > node.clientHeight + 4);
    measure();
    // A body re-flows when the pane resizes and when its images and fences lay
    // out, so one measurement on mount is one measurement too few.
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [children]);

  return (
    <div className="sh-pr-clamp" data-open={open ? 'true' : undefined} data-over={over ? 'true' : undefined}>
      <div className="sh-pr-clamp__box" ref={box}>
        {children}
      </div>
      {over || open ? (
        <button type="button" className="sh-pr-clamp__more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The description, as the document's opening prose.
 *
 * No card and no byline: the brief above already says who opened it and when,
 * and this is the thing that sentence is about. Boxed, it read as the first of
 * several equal things.
 *
 * It carries a `SectionLabel` like every other section, and that is not
 * decoration: without one the body began immediately under the brief's buttons,
 * so the first paragraph read as a caption on them.
 */
export function Description({ pr }: { readonly pr: PullRequest }): ReactElement | null {
  if (pr.body === '') return null;
  return (
    <section className="sh-pr-sec">
      <SectionLabel>Description</SectionLabel>
      <Clamp>
    <div className="sh-pr-body">
      {/*
        Markdown, because an AGENT writes this field. It used to split on blank
        lines and emit paragraphs, on the argument that a body is usually two
        sentences. That is a human's PR. The bodies this app exists to show are
        headings, fenced commands and lists.
      */}
      <Markdown text={pr.body} />
    </div>
      </Clamp>
    </section>
  );
}

/**
 * What was said — the PR's own comments and its diff threads, in one timeline.
 *
 * The meta column that used to sit beside this is gone: reviewers, the agent and
 * the task were three labelled blocks holding one line each, and they are one
 * dim line in the brief now. A second column for eleven words is a column that
 * exists to be a column.
 */
export function Talk({ pr, now, busy, wrapHand, onHandThread }: PanelProps): ReactElement {
  const entries = timelineOf(pr);
  if (entries.length === 0) {
    return <p className="sh-pr-none">Nothing has been said about this yet.</p>;
  }
  return (
    <div className="sh-pr-talk">
      {entries.map((entry) =>
        entry.kind === 'comment' ? (
          <article key={entry.comment.id} className="sh-pr-said">
            <AuthorMark login={entry.comment.author} avatar={entry.comment.avatar} />
            <div className="sh-pr-said__body">
              <header className="sh-pr-said__who">
                <span className="sh-pr-said__login">{entry.comment.author}</span>
                <span className="sh-pr-said__when">{agoText(entry.comment.at, now) ?? ''}</span>
              </header>
              <Clamp>
                <Markdown text={entry.comment.body} />
              </Clamp>
            </div>
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
    </div>
  );
}

/**
 * Who said it — their picture when they have one, `authorTint`'s square when they
 * do not.
 *
 * The square is always painted and the picture lies over it, so the two ways
 * this can fail — no network, no uploaded avatar — both land on the square, and
 * neither flashes an image on the way there. `avatarIsReal` reads the loaded
 * WIDTH to tell those apart, for the reason `AVATAR_PX` gives: GitHub answers
 * for an account with no picture by drawing one, and what it draws is a pale
 * block tile that would say nothing about who wrote the comment.
 *
 * The image is `aria-hidden` with an empty `alt` because the login is the next
 * element, and a face with a name on it would be read out twice.
 */
function AuthorMark({
  login,
  avatar,
}: {
  readonly login: string;
  readonly avatar: string | undefined;
}): ReactElement {
  const [face, setFace] = useState(false);
  return (
    <span className="sh-pr-said__mark" style={{ background: authorTint(login) }} aria-hidden="true">
      {avatar === undefined ? null : (
        <img
          className="sh-pr-said__face"
          src={avatar}
          alt=""
          data-face={face ? 'true' : undefined}
          onLoad={(event) => setFace(avatarIsReal(event.currentTarget.naturalWidth))}
          onError={() => setFace(false)}
        />
      )}
    </span>
  );
}

/**
 * One thread of the diff, drawn as what was SAID.
 *
 * It was a bordered card sitting next to comments that were not, which made two
 * remarks about the same pull request look like two kinds of object. They are
 * one kind: somebody said something. The only thing a thread has that a comment
 * does not is a place, so the place goes in the byline and the box goes away —
 * `Chip`'s reasoning again, that a bordered box beside a 13px row is louder than
 * the row.
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
    <article className="sh-pr-said" data-resolved={thread.resolved ? 'true' : undefined}>
      {thread.resolved ? (
        <span className="sh-pr-said__mark" aria-hidden="true">
          <Icon icon={namedGlyph('check')} size="sm" />
        </span>
      ) : (
        <AuthorMark login={thread.author} avatar={thread.avatar} />
      )}
      <div className="sh-pr-said__body">
        <header className="sh-pr-said__who">
          <span className="sh-pr-said__login">{thread.author}</span>
          <span className="sh-pr-said__where">
            {thread.path}
            {thread.line === null ? '' : `:${thread.line}`}
          </span>
        </header>
        {/* A review comment is markdown too, and an agent's is code more often than not. */}
        <Markdown text={thread.body} />
        {thread.resolved ? null : (
          <div className="sh-pr-said__verbs">
            {wrapHand(
              `thread:${thread.id}`,
              /* No `H`: the key is the brief's and cannot address a thread. A
                 legend on a control the key does not press is a promise the
                 keyboard does not keep. */
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHandThread(thread)}>
                Hand to agent
              </Button>,
            )}
            {/*
              Reply goes OUT. Writing a comment needs an editor, a draft, a
              submit and a failure state, and none of that is what this pane is
              for — the pane exists to get a comment to an agent.
            */}
            <Button variant="ghost" size="sm" onClick={() => window.open(url, '_blank')}>
              Reply ↗
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

// ----------------------------------------------------------------- commits

/**
 * The commits, as rows — newest first, the way a log is read.
 *
 * Opening one no longer replaces this list in place: a commit's diff takes the
 * PANE, like a file's, because it is the same kind of object and wants the same
 * room. The list is what the document carries.
 */
export function Commits({
  pr,
  now,
  onOpen,
}: PanelProps & { readonly onOpen: (sha: string) => void }): ReactElement {
  return (
    <div className="sh-pr-lines">
      {pr.commits.map((commit) => (
        <button key={commit.sha} type="button" className="sh-pr-line" onClick={() => onOpen(commit.sha)}>
          <span className="sh-pr-line__sha">{commit.sha.slice(0, 7)}</span>
          <span className="sh-pr-line__name">{commit.subject}</span>
          <span className="sh-pr-line__count" data-tone="added">+{commit.added}</span>
          <span className="sh-pr-line__count" data-tone="removed">−{commit.removed}</span>
          <span className="sh-pr-line__meta">
            {commit.author}
            {agoText(commit.at, now) === null ? '' : ` · ${agoText(commit.at, now) as string}`}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * One commit's diff, on the whole pane.
 *
 * `files` is `undefined` while the fetch is out and `[]` for a commit that
 * genuinely touched nothing — two states a single empty array cannot hold.
 */
export function CommitDiff({ pr, sha, onNeedCommit, busy, wrapHand, onHandThread }: PanelProps & { readonly sha: string }): ReactElement {
  const [files, setFiles] = useState<readonly ChangedFile[] | undefined>(undefined);

  /*
   * The callback lives in a ref and is NOT a dependency — the same trap
   * `FilesDiff` records below.
   *
   * The pane re-reads every few seconds, so the parent hands down a fresh arrow
   * on every tick. Depending on it re-ran this effect each time, and the
   * `setFiles(undefined)` at the top of it dropped the whole diff back to
   * `Fetching this commit's files…` twice a second — the flicker.
   */
  const need = useRef(onNeedCommit);
  need.current = onNeedCommit;
  const viewer = useRef<CodeViewHandle<ReviewThread> | null>(null);

  useEffect(() => {
    let live = true;
    setFiles(undefined);
    void (async () => {
      const answer = await need.current?.(sha);
      // The component may have moved on while this was in flight, and writing
      // then would show one commit's diff under another's heading.
      if (live) setFiles(answer ?? []);
    })();
    return () => {
      live = false;
    };
  }, [sha]);

  if (files === undefined) return <p className="sh-pr-none">Fetching this commit’s files…</p>;
  if (files.length === 0) return <p className="sh-pr-none">This commit changed no files.</p>;

  return (
    <div className="sh-pr-panel sh-pr-panel--list">
      <DiffList
        pr={pr}
        files={files}
        cacheKey={sha}
        busy={busy}
        wrapHand={wrapHand}
        onHandThread={onHandThread}
        viewerRef={viewer}
        pending={false}
      />
    </div>
  );
}

// ------------------------------------------------------------------ checks

/**
 * The checks, as rows that open.
 *
 * It was a two-column log viewer — names on the left, the selected check's
 * output on the right — and that shape is still defensible (it moves you
 * nowhere, so it is not a second rail). It is simply too much furniture for the
 * common case: two checks, one line of output each. A row that discloses its own
 * log costs nothing when nothing is wrong and still puts the failing lines on
 * screen, which is the thing an ADE has over the website.
 *
 * A check with nothing to say does not open at all — a disclosure that reveals
 * "GitHub has no output for this check" is a control that lies about having
 * something behind it.
 */
export function Checks({ pr, busy, wrapHand, onHandCheck, onOpenExternal }: PanelProps): ReactElement {
  const [open, setOpen] = useState<string | null>(() => firstFailure(pr)?.name ?? null);

  return (
    <div className="sh-pr-lines">
      {pr.checks.map((check) => {
        const said = check.log ?? check.summary ?? '';
        const at = open === check.name && said !== '';
        return (
          <div key={check.name} className="sh-pr-check" data-state={check.state}>
            <button
              type="button"
              className="sh-pr-line"
              disabled={said === ''}
              aria-expanded={said === '' ? undefined : at}
              onClick={() => setOpen(at ? null : check.name)}
            >
              <span className="sh-pr-line__mark" aria-hidden="true">
                <CheckMark state={check.state} />
              </span>
              <span className="sh-pr-line__name">{check.name}</span>
              <span className="sh-pr-line__meta">{whatHappened(check)}</span>
              <span className="sh-ui-sr-only">{check.state}</span>
            </button>
            {at ? (
              <div className="sh-pr-check__said">
                <pre className="sh-pr-log">{said}</pre>
                {/*
                  Only a FAILED check has anything to hand over, and the greyed
                  control that used to sit here for the other four said so in
                  the one way a reader cannot act on.
                */}
                <div className="sh-pr-check__verbs">
                  {check.state !== 'failed'
                    ? null
                    : wrapHand(
                        'check',
                        /* No `H` here either. The key hands over the FIRST
                           failing check by name, so on a PR with two of them a
                           legend on both rows would be wrong on one. */
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onHandCheck(check)}>
                          Hand to agent
                        </Button>,
                      )}
                  {check.url === undefined ? null : (
                    <Button variant="ghost" size="sm" onClick={() => onOpenExternal(check.url as string)}>
                      Full log ↗
                    </Button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The row's right-hand words — what happened, not how long it took.
 *
 * A duration is the interesting number for a check that RAN. For the two states
 * this pane exists to make visible it is no number at all: a queued check has
 * not started and a blocked one is waiting on a person, and both drew an empty
 * cell where the answer should be.
 */
function whatHappened(check: CheckRun): string {
  if (check.state === 'queued') return 'has not reported';
  if (check.state === 'blocked') return 'waiting on a person';
  if (check.state === 'skipped') return 'skipped';
  const took = durationText(check.durationMs);
  if (check.state === 'failed') return took === '' ? 'failed' : `failed · ${took}`;
  return took;
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
    <DiffNote
      key={thread.id}
      thread={thread}
      adrift={adriftMark}
      busy={busy}
      wrapHand={wrapHand}
      onHandThread={onHandThread}
    />
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
          // What the virtualiser reserves, kept beside the stylesheet it has to
          // match — `diff-theme.ts` says what happens when they drift.
          ...SHEPHERD_DIFF_SIZING,
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
/**
 * A review comment, where it was written — beside the line it is about.
 *
 * It drew `thread.body` as TEXT on ONE LINE, mono, ellipsised. Every part of
 * that was wrong for what a review comment is:
 *
 *   - it is markdown, and a reviewer writes it as markdown, so `**[Low] …**`
 *     and a fenced snippet arrived as their own source;
 *   - it is prose, so a mono face is the wrong voice and the wrong measure;
 *   - and it is as long as it needs to be. `white-space: nowrap` with an
 *     ellipsis meant the pane showed you that a comment EXISTED and then
 *     refused to show you the comment. The one thing this surface is for.
 *
 * Exported so it can be tested on its own: `CodeView` calls it back through
 * `renderAnnotation` and there is no DOM in jsdom to reach it through.
 */
export function DiffNote({
  thread,
  adrift,
  busy,
  wrapHand,
  onHandThread,
}: {
  readonly thread: ReviewThread;
  readonly adrift: boolean;
  readonly busy: boolean;
  readonly wrapHand: WrapHand;
  readonly onHandThread: (thread: ReviewThread) => void;
}): ReactElement {
  return (
    <div className="sh-pr-diff__note" data-adrift={adrift ? 'true' : undefined}>
      <header className="sh-pr-diff__note-who">
        <span className="sh-pr-card__mark" data-state="waiting" aria-hidden="true" />
        <span className="sh-pr-card__login">{thread.author}</span>
        {adrift ? <span className="sh-pr-diff__adrift">not on this diff</span> : null}
        <span className="sh-pr-diff__note-spacer" />
        {wrapHand(
          `thread:${thread.id}`,
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHandThread(thread)}>
            Hand to agent
          </Button>,
        )}
      </header>
      <div className="sh-pr-diff__note-body">
        <Markdown text={thread.body} />
      </div>
    </div>
  );
}

function stillFetching(files: readonly ChangedFile[]): boolean {
  return !files.some((file) => file.patch !== undefined) && files.some((file) => file.added + file.removed > 0);
}

/**
 * The paths, as rows — what the document carries.
 *
 * The diff itself is a place you GO: `DiffList` renders every file's patch in
 * one continuous scroll beside a tree, which is the largest object on this
 * surface by an order of magnitude and wants the whole pane. Listing the paths
 * here and opening that on demand is the same trade the Commits section makes.
 */
export function FilesList({ pr, onOpen }: PanelProps & { readonly onOpen: () => void }): ReactElement {
  const files = pr.files ?? [];
  if (files.length === 0) {
    return (
      <button type="button" className="sh-pr-line sh-pr-line--wide" onClick={onOpen}>
        <span className="sh-pr-line__name">Open the diff</span>
        <span className="sh-pr-line__meta">{pr.changedFiles} files</span>
      </button>
    );
  }
  return (
    <div className="sh-pr-lines">
      {files.map((file) => (
        <button key={file.path} type="button" className="sh-pr-line" onClick={onOpen}>
          <span className="sh-pr-line__name">{file.path}</span>
          <span className="sh-pr-line__count" data-tone="added">+{file.added}</span>
          <span className="sh-pr-line__count" data-tone="removed">−{file.removed}</span>
        </button>
      ))}
    </div>
  );
}

export function FilesDiff({ pr, busy, wrapHand, onHandThread, onNeedDiff }: PanelProps): ReactElement {
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
