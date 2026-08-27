import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { Button, Empty, Icon, KeyCap, SectionLabel, namedGlyph } from '@shepherd/ui';
import { blockedBy, landOrder, prKey, type CheckRun, type PullRequest, type ReviewThread } from '../src/model/index.ts';
import { agoText, readFiles, readReview, type ReviewData } from './review-data.ts';
import { ClosedPrRow, PrRow } from './pr-row.tsx';
import { PrDetail, type PrActions, type WrapHand } from './pr-detail.tsx';
import { HandMenu, HAND_COPY, HAND_MORE, HAND_NEW_AGENT, type AgentChoice } from './hand-menu.tsx';
import { WorkingChanges } from './working-changes.tsx';

/**
 * The review tab — every pull request this task has, and then one of them in
 * full.
 *
 * ── the shape, and the one idea in it ────────────────────────────────────────
 *
 * A HOME PAGE and a DETAIL page, with `‹ PRs` in the pane head as the way back.
 * The home page's rows carry enough to decide whether to go in, so the detail is
 * a choice rather than the only way to know anything.
 *
 * **One PR skips the list entirely.** No crumb, no `1 of 1`, no page to click
 * past — the tab IS the PR. That is the common case and it pays nothing for the
 * rare one; a second PR appearing is what grows the crumb.
 *
 * ── what it does not do ──────────────────────────────────────────────────────
 *
 * It does not keep a copy of anything. The service half holds the PRs and syncs
 * them; this asks, draws, and asks again — so a pane and the rail's glyph cannot
 * disagree, and closing the tab loses nothing.
 *
 * It does not raise attention, notify, or badge. A failing check is a condition,
 * not an event.
 */

/**
 * How often the pane re-asks.
 *
 * Not a poll of GitHub — the service half decides that, and it syncs faster
 * while this pane is open. This is a poll of what the service half already
 * knows, which is a message-port round-trip and nothing more. It exists because
 * a view has no way to be pushed to, and because the head's `synced 12s ago`
 * has to tick even when nothing changed.
 */
const REFRESH_MS = 3_000;

export function ReviewPane({ state, focused, invoke }: ExtensionPaneProps): ReactElement {
  const taskId = readTaskId(state);
  const [data, setData] = useState<ReviewData | null>(null);
  /** Which PR is open, as `owner/repo#n`, or `null` for the home page. */
  const [openPr, setOpenPr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * A hand-off waiting on "which agent" — the candidates, and the prompt's own
   * arguments so the answer can be replayed verbatim.
   *
   * The ARGS are kept rather than rebuilt: between asking and answering, a sync
   * can land and change which check is first, and re-deriving them would hand
   * over a different thing from the one the question was about.
   */
  const [choosing, setChoosing] = useState<{
    /** Which button asked, so the menu opens under THAT one. */
    at: string;
    args: Record<string, unknown>;
    choices: readonly AgentChoice[];
  } | null>(null);
  /**
   * Which button is being pressed right now.
   *
   * A ref rather than state, because it is read inside the call it belongs to
   * and never drawn: making it state would repaint every button on the way to
   * finding out whether a menu is needed at all.
   */
  const asking = useRef<string>('footer');
  /** Ticks so `synced 12s ago` counts up without a re-read. */
  const [now, setNow] = useState(() => Date.now());

  const ask = useCallback(async () => {
    if (taskId === null) return;
    const answer = await invoke('github.prs', { task: taskId });
    // `ok` says the call succeeded, never that the value has a shape.
    const next = answer.ok ? readReview(answer.value) : null;
    /*
     * Kept BY VALUE, so a re-read that changed nothing changes nothing.
     *
     * Every three seconds this handed down a fresh object graph, and everything
     * downstream keyed off identity — the diff viewer's item list, the file
     * tree's paths, the effects holding them — rebuilt against data that was
     * byte-for-byte what it already had. On a diff that is a visible flicker
     * twice a second.
     */
    setData((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [invoke, taskId]);

  useEffect(() => {
    void ask();
    const timer = setInterval(() => {
      setNow(Date.now());
      void ask();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [ask]);

  const all = useMemo(() => [...(data?.open ?? []), ...(data?.closed ?? [])], [data]);
  const selected = all.find((pr) => prKey(pr) === openPr);

  /**
   * The whole tab is one PR — 7c.
   *
   * "One live PR and nothing finished" rather than "one PR": a task with a
   * merged PR and a new one open has a history worth seeing, and collapsing to
   * the live one would hide it.
   */
  const only = data !== null && data.open.length === 1 && data.closed.length === 0 ? data.open[0] : undefined;
  const showing = selected ?? only;

  const run = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      setBusy(true);
      setProblem(null);
      const answer = await invoke(command, args);
      setBusy(false);
      /*
       * A verb that failed must say so. This is the pane's only error surface,
       * and it exists because every one of these verbs can fail for a reason
       * only the far side knows — a merge somebody else won, a token that
       * expired between the draw and the click.
       */
      if (!answer.ok) {
        setProblem(plainly(answer.error.message));
        return;
      }
      /*
       * "Which agent?" comes back as a SUCCESS carrying a question, not as a
       * failure — nothing went wrong, and a red line for a question would be the
       * app apologising for asking.
       */
      const choices = readChoices(answer.value);
      if (choices !== null) {
        setChoosing({ at: asking.current, args, choices });
        return;
      }
      if (isRefusal(answer.value)) setProblem(plainly(refusalReason(answer.value)));
      else void ask();
    },
    [invoke, ask],
  );

  /**
   * Fetch a PR's patches — a BACKGROUND ask, not a verb.
   *
   * Deliberately not through `run`: that one sets `busy`, which disables every
   * control on the surface, and this is triggered by opening a tab rather than
   * by pressing anything. A pane whose buttons greyed out because you looked at
   * the diff would be reporting somebody else's work as your own.
   *
   * A failure is silent here too — the Files tab already says "the diff for this
   * file has not been fetched", which is both the symptom and the whole of what
   * a reader can do about it.
   */
  const needDiff = useCallback(
    async (key: string) => {
      if (taskId === null) return;
      const answer = await invoke('github.diff', { task: taskId, pr: key });
      if (answer.ok) void ask();
    },
    [invoke, taskId, ask],
  );

  /**
   * One commit's files, answered to the caller rather than folded into the PR.
   *
   * A commit is immutable, so the command holds its answer forever and a second
   * open is free. `null` on any failure: the Commits tab draws an empty diff,
   * which is the same shape as a commit that touched nothing and is the most a
   * reader can act on either way.
   */
  const needCommit = useCallback(
    async (sha: string, key: string) => {
      if (taskId === null) return null;
      const answer = await invoke('github.commitDiff', { task: taskId, pr: key, sha });
      if (!answer.ok) return null;
      const value = answer.value;
      if (typeof value !== 'object' || value === null) return null;
      return readFiles((value as { files?: unknown }).files);
    },
    [invoke, taskId],
  );

  const actionsFor = (pr: PullRequest): PrActions => ({
    onHandCheck: (check: CheckRun) => {
      asking.current = 'check';
      void run('github.handToAgent', { task: taskId, pr: prKey(pr), check: check.name });
    },
    onHandThread: (thread: ReviewThread) => {
      asking.current = `thread:${thread.id}`;
      void run('github.handToAgent', { task: taskId, pr: prKey(pr), thread: thread.id });
    },
    /*
     * The brief's own hand-off, and it may name a check.
     *
     * `asking.current` is the ANCHOR the menu hangs off, and this used to say
     * `footer` while the button that named a check said `check` — so the brief's
     * menu tried to anchor to the Checks panel's button, which on the old tabbed
     * surface was not even mounted. One button, one key.
     */
    onHandReview: (check?: string) => {
      asking.current = 'brief';
      void run('github.handToAgent', {
        task: taskId,
        pr: prKey(pr),
        ...(check === undefined ? {} : { check }),
      });
    },
    onMerge: () => void run('github.merge', { task: taskId, pr: prKey(pr) }),
    onOpenExternal: (url: string) => void run('github.open', { url }),
  });

  /**
   * Every `Hand to agent` button, with the menu hanging off the one that asked.
   *
   * ALWAYS wrapped, and open only for the matching key. The alternative — wrap
   * on demand — swaps the trigger element at the moment the menu opens, and
   * Radix anchors to the trigger it was given: the menu would appear a frame
   * late and in the wrong place. A closed menu renders nothing.
   */
  const wrapHand: WrapHand = (at, button) => (
    <HandMenu
      key={at}
      choices={choosing?.at === at ? choosing.choices : []}
      open={choosing?.at === at}
      onOpenChange={(next) => {
        // Closing is the only direction this reports: the menu OPENS because a
        // hand-off came back asking, never because the trigger was clicked.
        if (!next) setChoosing(null);
      }}
      onSelect={(id) => {
        const pending = choosing;
        setChoosing(null);
        if (pending === null) return;
        if (id === HAND_NEW_AGENT) {
          // The one destination that is not an agent: spawn, which is what
          // `handToAgent` does with nobody to hand to. `session: ''` names no
          // live session, so the command falls through to exactly that.
          void run('github.handToAgent', { ...pending.args, session: '' });
          return;
        }
        if (id === HAND_COPY) {
          void navigator.clipboard?.writeText(promptTextOf(pending.choices, pending.args));
          return;
        }
        if (id === HAND_MORE) {
          // The escalation the menu declares and this build does not implement:
          // said out loud rather than silently doing nothing.
          setProblem('More than four agents — the full picker is not built yet.');
          return;
        }
        // The same args, plus the answer. Replayed verbatim — see `choosing`.
        void run('github.handToAgent', { ...pending.args, session: id });
      }}
    >
      {button}
    </HandMenu>
  );

  useKeys({ focused, showing, only, all: data?.open ?? [], openPr, setOpenPr, actionsFor });

  if (taskId === null) {
    // A pane restored with a state this build cannot read. Says so rather than
    // drawing an empty rectangle — and says the one thing that fixes it.
    return <p className="sh-review__nothing">This review tab has lost track of which task it is for. Close it.</p>;
  }

  return (
    <div className="sh-review">
      <Head
        data={data}
        now={now}
        showing={showing}
        crumb={selected !== undefined}
        position={positionOf(selected, data)}
        onBack={() => setOpenPr(null)}
        onSync={() => void run('github.sync', {})}
        busy={busy}
      />

      {problem === null ? null : (
        <p className="sh-review__problem" role="status">
          {problem}
        </p>
      )}

      {data === null ? null : showing !== undefined ? (
        <PrDetail
          pr={showing}
          actions={actionsFor(showing)}
          busy={busy}
          wrapHand={wrapHand}
          now={now}
          onNeedDiff={() => void needDiff(prKey(showing))}
          onNeedCommit={(sha) => needCommit(sha, prKey(showing))}
          {...(data.agent === undefined ? {} : { agent: data.agent })}
          task={{
            title: data.taskTitle,
            // Its SIBLINGS, not itself — "2 more PRs" has to mean more.
            others: [...data.open, ...data.closed]
              .filter((other) => prKey(other) !== prKey(showing))
              .map((other) => `#${other.number}`),
          }}
        />
      ) : (
        <Home
          data={data}
          taskId={taskId}
          invoke={invoke}
          onOpen={setOpenPr}
          busy={busy}
          onLand={() => void run('github.land', { task: taskId })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- the head

/**
 * The pane's own head, which is also the crumb.
 *
 * `‹ PRs › shepherd/sdk #44 … Esc · 1 of 3` — the ONE new navigation idea in
 * this surface, and it is one word plus a position. The position is there so
 * `⌘⇧]` can walk the set without going back up, which is the gesture that makes
 * a stack of three PRs feel like one thing.
 */
function Head({
  data,
  now,
  showing,
  crumb,
  position,
  onBack,
  onSync,
  busy,
}: {
  readonly data: ReviewData | null;
  readonly now: number;
  readonly showing: PullRequest | undefined;
  readonly crumb: boolean;
  readonly position: string | null;
  readonly onBack: () => void;
  readonly onSync: () => void;
  readonly busy: boolean;
}): ReactElement {
  const ago = agoText(data?.syncedAt ?? null, now);
  return (
    <div className="sh-review__head">
      {crumb ? (
        <button type="button" className="sh-review__back" onClick={onBack}>
          <Icon icon={namedGlyph('chevron-left')} size="sm" />
          PRs
        </button>
      ) : null}
      {showing === undefined ? (
        <>
          <span className="sh-review__name">PRs</span>
          <span className="sh-review__sep">·</span>
          <span className="sh-review__count">{countText(data)}</span>
        </>
      ) : (
        <>
          {crumb ? <span className="sh-review__sep">›</span> : null}
          <span className="sh-review__name">{showing.repo}</span>
          <span className="sh-review__count">#{showing.number}</span>
        </>
      )}
      <span className="sh-review__spacer" />
      {position === null ? null : <span className="sh-review__position">Esc · {position}</span>}
      {/*
        The sync line, and it is a BUTTON. `gh · synced 12s ago` invites the
        question "and if I don't want to wait", so the thing that answers it is
        the thing that says it — rather than a second control beside a label.
      */}
      <button type="button" className="sh-review__synced" onClick={onSync} disabled={busy} title="Sync now">
        {data?.signedIn === false ? 'gh · not signed in' : ago === null ? 'gh · syncing' : `gh · synced ${ago} ago`}
      </button>
    </div>
  );
}

/** §2 gives exactly four identity marks, so a fifth repo starts again at one. */
const markFor = (pr: PullRequest, order: readonly string[]): string =>
  `repo${(Math.max(0, order.indexOf(pr.repo)) % 4) + 1}`;

const countText = (data: ReviewData | null): string => {
  if (data === null) return '';
  const repos = new Set(data.open.map((pr) => pr.repo)).size;
  const n = data.open.length;
  if (n === 0) return 'none open';
  return repos > 1 ? `${n} across ${repos} repos` : `${n} open`;
};

const positionOf = (selected: PullRequest | undefined, data: ReviewData | null): string | null => {
  if (selected === undefined || data === null) return null;
  const order = [...data.open, ...data.closed];
  const index = order.findIndex((pr) => prKey(pr) === prKey(selected));
  return index === -1 || order.length < 2 ? null : `${index + 1} of ${order.length}`;
};

// ------------------------------------------------------------------- the list

function Home({
  data,
  taskId,
  invoke,
  onOpen,
  busy,
  onLand,
}: {
  readonly data: ReviewData;
  readonly taskId: string;
  readonly invoke: ExtensionPaneProps['invoke'];
  readonly onOpen: (key: string) => void;
  readonly busy: boolean;
  readonly onLand: () => void;
}): ReactElement {
  const ordered = landOrder(data.open);
  const blocker = blockedBy(data.open);
  /*
   * Which repo gets which identity colour, decided once for the whole list.
   *
   * In LAND order rather than alphabetically, so the colours read top-down on
   * first sight — and the same repo keeps its colour on every row of the list,
   * which is the only thing the mark is for.
   */
  const repoOrder = [...new Set(ordered.map((pr) => pr.repo))];

  if (data.open.length === 0 && data.closed.length === 0) {
    /*
     * No pull request is not an empty page — it is the state BEFORE one, and
     * what you want to see there is what you have changed.
     *
     * This used to be an `Empty` reading "They appear here as soon as one is
     * opened", which was true and useless: it was also unreachable, because the
     * rail drew no icon for a task with no PR. Both halves changed together.
     */
    return <WorkingChanges task={taskId} signedIn={data.signedIn} invoke={invoke} />;
  }

  return (
    <div className="sh-review__body">
      <div className="sh-review__scroll">
        {ordered.length === 0 ? null : (
          <>
            <SectionLabel count={String(ordered.length)}>Open</SectionLabel>
            {ordered.map((pr) => (
              <PrRow
                key={prKey(pr)}
                pr={pr}
                all={data.open}
                mark={markFor(pr, repoOrder)}
                selected={false}
                onOpen={() => onOpen(prKey(pr))}
              />
            ))}
          </>
        )}
        {data.closed.length === 0 ? null : (
          <>
            <SectionLabel count={String(data.closed.length)}>
              {data.closed.every((pr) => pr.state === 'merged') ? 'Merged' : 'Closed'}
            </SectionLabel>
            {data.closed.map((pr) => (
              <ClosedPrRow key={prKey(pr)} pr={pr} onOpen={() => onOpen(prKey(pr))} />
            ))}
          </>
        )}
      </div>

      {/*
        The one TASK-level verb, and it names its own sequence rather than
        claiming a single merge — `sdk #44 → v2 #301 → v2 #305`, which is what
        makes one press of an irreversible button legible before you press it.

        Disabled while anything is blocking, so it is only ever offered when the
        WHOLE sequence can go. `github.land` re-checks each PR anyway (the pane's
        answer is up to twenty seconds old) and stops at the first refusal,
        naming what did land.
      */}
      {ordered.length < 2 ? null : (
        <div className="sh-review__foot">
          <Button variant="primary" size="sm" disabled={busy || blocker !== null} onClick={onLand}>
            Land task
            <KeyCap>L</KeyCap>
          </Button>
          <span className="sh-review__order">
            {ordered.map((pr) => `${pr.repoKey} #${pr.number}`).join(' → ')} · order from base refs and Depends-on
          </span>
          <span className="sh-review__spacer" />
          {blocker === null ? null : (
            <span className="sh-review__blocked" data-tone="negative">
              blocked · {blocker.repoKey} #{blocker.number}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- the keys

/**
 * The pane's keys, bound only while it is focused.
 *
 * That guard is the whole reason `focused` is a prop (ADR 0044): a background
 * review tab that still answered `Esc` and `H` would fight the pane you are
 * looking at, and the user would have no way to tell which one acted.
 *
 * Capture phase, like every other key this app binds: a terminal usually has
 * focus and xterm handles keydown on the way down.
 */
function useKeys({
  focused,
  showing,
  only,
  all,
  openPr,
  setOpenPr,
  actionsFor,
}: {
  readonly focused: boolean;
  readonly showing: PullRequest | undefined;
  readonly only: PullRequest | undefined;
  readonly all: readonly PullRequest[];
  readonly openPr: string | null;
  readonly setOpenPr: (key: string | null) => void;
  readonly actionsFor: (pr: PullRequest) => PrActions;
}): void {
  const latest = useRef({ showing, only, all, openPr, actionsFor });
  latest.current = { showing, only, all, openPr, actionsFor };

  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const { showing, only, all, openPr, actionsFor } = latest.current;

      // ⌘⇧] / ⌘⇧[ walk the set without going back up — the reason the head says
      // `1 of 3`.
      if (event.metaKey && event.shiftKey && (event.key === ']' || event.key === '[')) {
        if (all.length < 2 || showing === undefined) return;
        event.preventDefault();
        const index = all.findIndex((pr) => prKey(pr) === prKey(showing));
        const next = all[(index + (event.key === ']' ? 1 : all.length - 1)) % all.length];
        if (next !== undefined) setOpenPr(prKey(next));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Esc goes back to the list — and does nothing at all when there is no
      // list to go back to, so a one-PR tab does not swallow the key.
      if (event.key === 'Escape' && openPr !== null) {
        event.preventDefault();
        setOpenPr(null);
        return;
      }
      const pr = showing ?? only;
      if (pr === undefined) return;
      const actions = actionsFor(pr);
      /*
       * H is the BRIEF's key, and it presses the brief's own button.
       *
       * It used to call `onHandCheck` for the first failing check, which put
       * three different claims on one key: the brief drew an `H`, so did every
       * check row, and so did every thread — and only one of them was ever
       * true. Worse, `onHandCheck` anchors the destination menu to `check`, and
       * that button is mounted only while its row is expanded, so H on a
       * collapsed row set `choosing` with nothing to hang it off and the
       * hand-off silently did nothing.
       *
       * The check still travels — `onHandReview` names it — so the prompt is
       * the same one. What changes is that the key and the button it is drawn
       * on are now the same gesture.
       */
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        actions.onHandReview(pr.checks.find((check) => check.state === 'failed')?.name);
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        actions.onMerge();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focused, setOpenPr]);
}

// ------------------------------------------------------------------- reading

/** The pane's own state, which crossed a port and is `unknown` (ADR 0044). */
function readTaskId(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const task = (state as Record<string, unknown>)['task'];
  return typeof task === 'string' && task !== '' ? task : null;
}

/**
 * `Copy as prompt`, which the pane cannot build.
 *
 * The prompt is composed in the service half (`model/prompt.ts`) and never sent
 * here — the pane asks for a hand-off and gets back a question, not a draft. So
 * what this copies is what the pane HAS: which thread or check was being handed
 * over. Honest and useful for pasting into a chat; not the same bytes an agent
 * would have received, and it does not claim to be.
 */
function promptTextOf(_choices: readonly AgentChoice[], args: Record<string, unknown>): string {
  const pr = typeof args['pr'] === 'string' ? args['pr'] : 'this pull request';
  const about =
    typeof args['check'] === 'string'
      ? `the failing \`${args['check']}\` check`
      : typeof args['thread'] === 'string'
        ? 'the review comment'
        : 'the unresolved review comments';
  return `Address ${about} on ${pr}.`;
}

/**
 * A `{ choose: [...] }` answer — the question `handToAgent` asks back.
 *
 * Read rather than cast, like everything else that crossed the port: a row with
 * no session cannot be picked and a row with no title cannot be read, so both
 * are required and anything else is dropped.
 */
function readChoices(value: unknown): readonly AgentChoice[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)['choose'];
  if (!Array.isArray(raw)) return null;
  const marks = ['working', 'waiting', 'resting', 'failed'] as const;
  const choices = raw.flatMap((entry): AgentChoice[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const session = typeof row['session'] === 'string' ? row['session'] : undefined;
    const title = typeof row['title'] === 'string' && row['title'] !== '' ? row['title'] : undefined;
    if (session === undefined || title === undefined) return [];
    return [
      {
        session,
        title,
        cwd: typeof row['cwd'] === 'string' ? row['cwd'] : '',
        ...(typeof row['repo'] === 'string' ? { repo: row['repo'] } : {}),
        role: row['role'] === 'orchestrator' ? 'orchestrator' : 'workstream',
        // A mark this build does not know is a hollow ring — the mark that
        // claims nothing — rather than an invented state.
        mark: marks.find((candidate) => candidate === row['mark']) ?? 'resting',
        // And an unreadable `means` says the safer of the two: a row promising
        // "sends now" that then queued would be the one lie this list can tell.
        means: row['means'] === 'queues' ? 'queues' : 'sends now',
      },
    ];
  });
  // An empty list is not a question. Falling through to the ordinary path means
  // a malformed answer reads as "it did something", which is what it did.
  return choices.length === 0 ? null : choices;
}

/**
 * A failure message with the plumbing taken off the front.
 *
 * The dispatcher formats every failure as `"<command>" failed: <message>`, and a
 * verb that reports another verb's failure carries that string inside its own —
 * so a hand-off that could not spawn arrived on screen as:
 *
 *   "tasks.spawn" failed: handler-failed: "tasks.spawn" failed: task … has no repo "sdk"
 *
 * Three layers of who-was-called in front of the one clause a person can act on.
 * Stripped HERE rather than at the source because there is no source to fix: the
 * message is the registry's formatting, correct for a log and wrong for a line
 * of prose, and this is the only surface that shows one to a human.
 *
 * It peels repeatedly, so a failure nested three deep reads as well as one nested
 * once, and it stops at the first thing that is not a prefix — a message with a
 * colon in its own text keeps it.
 */
export function plainly(message: string): string {
  const prefix = /^(?:"[^"]+" failed: |[a-z-]+: )/;
  let text = message;
  // Bounded rather than `while (true)`: a pathological string must not spin, and
  // nothing in this app nests deeper than the three above.
  for (let peel = 0; peel < 6 && prefix.test(text); peel += 1) text = text.replace(prefix, '');
  return text;
}

/** A command that answered `{ ok: false, reason }` rather than throwing. */
const isRefusal = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as Record<string, unknown>)['ok'] === false;

const refusalReason = (value: unknown): string => {
  const reason = (value as Record<string, unknown>)['reason'];
  return typeof reason === 'string' ? reason : 'that did not work';
};
