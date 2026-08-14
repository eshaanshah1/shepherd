import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react';
import { Button, Icon, KeyCap, namedGlyph } from '@shepherd/ui';
import { agoText } from './review-data.ts';
import { Markdown } from './markdown.tsx';
import type { WrapHand } from './pr-detail.tsx';
import { isLineInDiff, unifiedPatch, type CheckRun, type PullRequest, type ReviewThread } from '../src/model/index.ts';

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
}

// ------------------------------------------------------------- conversation

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
          <article className="sh-pr-card">
            <header className="sh-pr-card__who">
              <span className="sh-pr-card__login">{pr.commits[0]?.author ?? 'someone'}</span>
              <span>opened this{agoText(pr.openedAt, now) === null ? '' : ` · ${agoText(pr.openedAt, now)} ago`}</span>
            </header>
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

        {pr.threads.map((thread) => (
          <article key={thread.id} className="sh-pr-card" data-resolved={thread.resolved ? 'true' : undefined}>
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
                <Button variant="ghost" size="sm" onClick={() => window.open(pr.url, '_blank')}>
                  Reply ↗
                </Button>
              </div>
            )}
          </article>
        ))}

        {pr.threads.length === 0 && pr.body === '' ? (
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

// ----------------------------------------------------------------- commits

export function Commits({ pr, now }: PanelProps): ReactElement {
  if (pr.commits.length === 0) {
    return <p className="sh-pr-panel__none">No commits on this branch yet.</p>;
  }
  return (
    <div className="sh-pr-panel">
      {pr.commits.map((commit) => (
        <div key={commit.sha} className="sh-pr-commit">
          {/* Seven characters, which is what git itself abbreviates to and what
              a person types when they want one. */}
          <span className="sh-pr-commit__sha">{commit.sha.slice(0, 7)}</span>
          <span className="sh-pr-commit__subject">{commit.subject}</span>
          <span className="sh-pr-commit__who">{commit.author}</span>
          <span className="sh-pr-commit__when">{agoText(commit.at, now) ?? ''}</span>
        </div>
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
              {check.state === 'passed' ? <Icon icon={namedGlyph('check')} size="sm" /> : null}
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

const durationText = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

// ------------------------------------------------------------------- files

export function Files({ pr, busy, wrapHand, onHandThread, onNeedDiff }: PanelProps): ReactElement {
  const files = pr.files ?? [];
  /*
   * Asked for on mount, and again only if the PR changes under us.
   *
   * The command is idempotent — it keys its own cache on the PR's `updatedAt`
   * and answers `cached` for a repeat — so this effect can be as simple as
   * "tell them we are here". Guarding on `patch === undefined` here instead
   * would re-ask forever for a PR whose files GitHub genuinely withheld.
   *
   * **The callback is held in a ref and is NOT a dependency**, and that is the
   * bug this comment exists for. Depending on it makes the effect re-run on
   * every render for any parent that passes an inline arrow — and the fetch it
   * fires causes a re-render, so it re-runs forever. Measured: the test that
   * asserts this ask timed out at five seconds.
   *
   * A ref rather than "memoize it at the call site", because that would make
   * correctness here a rule the caller has to remember, and this panel has three
   * callers already.
   */
  const key = `${pr.repo}#${pr.number}@${pr.updatedAt}`;
  const need = useRef(onNeedDiff);
  need.current = onNeedDiff;
  useEffect(() => {
    need.current();
  }, [key]);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  /*
   * Pierre's tree, not a list of buttons.
   *
   * A file list looks like the easiest thing on this surface and is not: nesting,
   * collapse state, keyboard traversal, selection, long-path elision and
   * virtualisation are each a week, and every one of them is a solved problem
   * somebody ships. `useFileTree` takes the paths and owns all of it.
   *
   * It renders through preact into a shadow root, which is worth knowing rather
   * than worrying about: no second React reaches the page, and our tokens reach
   * IT because custom properties inherit through the boundary. What does not
   * work is styling it with a descendant selector from our sheet.
   */
  const tree = useFileTree({ paths });
  // The purpose-built hook rather than a selector over the model: selection is
  // the one thing this view reads, and `useFileTreeSelection` is exactly it.
  const selected = useFileTreeSelection(tree.model);
  const at = selected[0];
  const shown = files.find((file) => file.path === at) ?? files[0];

  if (shown === undefined) return <p className="sh-pr-panel__none">No files on this pull request.</p>;

  /*
   * GitHub sends HUNKS, and a diff renderer wants a patch — see `unifiedPatch`.
   * The header is synthesised here rather than in the reader because it is a
   * fact about the RENDERER's input, not about what GitHub said.
   */
  const patch = unifiedPatch(shown);

  /*
   * The review threads on THIS file, split by whether the diff can actually show
   * them.
   *
   * **A thread naming a file is not the same as a thread the diff can show.**
   * Its line may have moved out of the change since it was written, or sit in a
   * hunk nobody asked for. Pinning it anyway puts the remark against whatever
   * code now occupies that line number — a comment about a function attached to
   * an import, with nothing saying so. Dropping it loses the conversation.
   *
   * So both are drawn: inside a hunk it becomes an annotation on its line, and
   * outside one it is listed above the diff as `not on this diff`. That is v1's
   * recorded workbench behaviour arriving here for the same reason.
   *
   * The SIDE is read rather than assumed, for the same class of reason: a
   * comment on a removed line belongs beside the code that went away, not
   * beside the code that replaced it.
   */
  const here = pr.threads.filter((thread) => thread.path === shown.path && !thread.resolved);
  const placed = here.filter(
    (thread) => patch !== null && thread.line !== null && isLineInDiff(patch, thread.side, thread.line),
  );
  const adrift = here.filter((thread) => !placed.includes(thread));
  const annotations = placed.flatMap((thread) =>
    thread.line === null
      ? []
      : [
          {
            side: thread.side === 'left' ? ('deletions' as const) : ('additions' as const),
            lineNumber: thread.line,
            metadata: thread,
          },
        ],
  );

  return (
    <div className="sh-pr-panel sh-pr-panel--list">
      <FileTree className="sh-pr-tree" model={tree.model} />

      <div className="sh-pr-diff">
        {/*
          The threads this diff cannot place, at its head rather than nowhere.
          An unresolved comment you cannot see is one you will not address.
        */}
        {adrift.map((thread) => (
          <div key={thread.id} className="sh-pr-diff__note" data-adrift="true">
            <span className="sh-pr-card__mark" data-state="waiting" aria-hidden="true" />
            <span className="sh-pr-diff__note-text">
              <span className="sh-pr-card__login">@{thread.author}</span> · {thread.body}
            </span>
            <span className="sh-pr-diff__adrift">not on this diff</span>
            {wrapHand(
              `thread:${thread.id}`,
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHandThread(thread)}>
                Hand to agent
              </Button>,
            )}
          </div>
        ))}
        {patch === null ? (
          <p className="sh-pr-panel__none">The diff for this file has not been fetched.</p>
        ) : (
          <PatchDiff
            className="sh-pr-diff__view"
            patch={patch}
            /*
             * Both themes named, not one.
             *
             * `ThemesType` takes a dark and a light and switches on the viewer's
             * own mode — which is what this app does everywhere else (ADR 0040's
             * light mode), so pinning one here would be the single place in the
             * product that stayed dark when you switched.
             */
            options={{ theme: { dark: 'github-dark-default', light: 'github-light-default' } }}
            lineAnnotations={annotations}
            /*
             * No worker pool. The pool is what makes a thousand-file diff
             * viewport-smooth, and it wants a `WorkerPoolContextProvider` plus a
             * worker the renderer's build has to emit. One file at a time in a
             * pane is not that problem, and a worker for it would be a build
             * change for no measured gain.
             */
            disableWorkerPool
            renderAnnotation={(annotation) => (
              <div className="sh-pr-diff__note">
                <span className="sh-pr-card__mark" data-state="waiting" aria-hidden="true" />
                <span className="sh-pr-diff__note-text">
                  <span className="sh-pr-card__login">@{annotation.metadata.author}</span> · {annotation.metadata.body}
                </span>
                {wrapHand(
                  `thread:${annotation.metadata.id}`,
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => onHandThread(annotation.metadata)}>
                    Hand to agent
                  </Button>,
                )}
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
