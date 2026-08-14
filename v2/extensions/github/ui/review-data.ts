import type { CheckRun, CheckState, Commit, PrState, PullRequest, Reviewer, ReviewThread } from '../src/model/index.ts';

/**
 * What the review pane is handed, and the reader that refuses to trust it.
 *
 * The same discipline `tasks`' `card-data.ts` states one extension over: this
 * shape is written by the service half, crosses an IPC port as `unknown`, and is
 * read here. `ok` says a call succeeded, never that a value has a shape — and
 * this renders in a pane, so a throw inside React's render takes the window.
 *
 * The defaults are all "say less", never "make something up": an unreadable
 * check list draws no checks, an unreadable diff draws no numbers. A pane that
 * omits a fact is honest; one that invents a zero is not.
 */

export interface ReviewData {
  /** Live PRs, in the order they have to land. */
  readonly open: readonly PullRequest[];
  /** Merged and closed, newest first. */
  readonly closed: readonly PullRequest[];
  /** Epoch ms of the last successful sync, or `null` if there has not been one. */
  readonly syncedAt: number | null;
  readonly error?: string;
  readonly signedIn: boolean;
  /** What the task is called — the meta column's last block. */
  readonly taskTitle: string;
  /**
   * The agent in this branch's worktree, if one is live.
   *
   * The one thing on the conversation view that GitHub could not draw, and the
   * reason the review tab is in this app rather than a browser tab: it answers
   * "who do I hand this to" before you press the button.
   */
  readonly agent?: { readonly title: string; readonly state: string };
}

export function readReview(value: unknown): ReviewData | null {
  if (!isRecord(value)) return null;
  const prs = readList(value['prs']);
  const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  const pick = (keys: unknown): readonly PullRequest[] =>
    (Array.isArray(keys) ? keys : []).flatMap((key) => {
      const found = typeof key === 'string' ? byKey.get(key) : undefined;
      return found === undefined ? [] : [found];
    });

  return {
    open: pick(value['open']),
    closed: pick(value['closed']),
    syncedAt: int(value['syncedAt']) ?? null,
    ...(str(value['error']) === undefined ? {} : { error: str(value['error']) as string }),
    signedIn: value['signedIn'] === true,
    taskTitle: str(value['taskTitle']) ?? '',
    ...readAgent(value['agent']),
  };
}

/** The branch's agent, or nothing — both are ordinary. */
function readAgent(value: unknown): { agent?: { title: string; state: string } } {
  if (!isRecord(value)) return {};
  const title = str(value['title']);
  if (title === undefined) return {};
  return { agent: { title, state: str(value['state']) ?? 'idle' } };
}

function readList(value: unknown): readonly PullRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PullRequest[] => {
    const pr = readPr(entry);
    return pr === null ? [] : [pr];
  });
}

const STATES: readonly PrState[] = ['draft', 'open', 'merged', 'closed'];
const CHECK_STATES: readonly CheckState[] = ['passed', 'failed', 'running', 'skipped'];

export function readPr(value: unknown): PullRequest | null {
  if (!isRecord(value)) return null;
  const repo = str(value['repo']);
  const number = int(value['number']);
  const state = STATES.find((candidate) => candidate === value['state']);
  // The three with no honest default. A PR with no repo or number cannot be
  // addressed by any verb on the surface, and one with no state would have to be
  // drawn as something — which is the guess this file exists to refuse.
  if (repo === undefined || number === undefined || state === undefined) return null;

  return {
    repo,
    number,
    state,
    repoKey: str(value['repoKey']) ?? repo,
    title: str(value['title']) ?? `#${number}`,
    body: str(value['body']) ?? '',
    baseRef: str(value['baseRef']) ?? '',
    headRef: str(value['headRef']) ?? '',
    url: str(value['url']) ?? '',
    added: int(value['added']) ?? 0,
    removed: int(value['removed']) ?? 0,
    changedFiles: int(value['changedFiles']) ?? 0,
    checks: readChecks(value['checks']),
    approvals: strings(value['approvals']),
    changesRequested: strings(value['changesRequested']),
    threads: readThreads(value['threads']),
    files: Array.isArray(value['files'])
      ? value['files'].flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const path = str(entry['path']);
          if (path === undefined) return [];
          const patch = str(entry['patch']);
          return [
            {
              path,
              added: int(entry['added']) ?? 0,
              removed: int(entry['removed']) ?? 0,
              ...(patch === undefined ? {} : { patch }),
            },
          ];
        })
      : [],
    commits: readCommits(value['commits']),
    reviewers: readReviewers(value['reviewers']),
    openedAt: int(value['openedAt']) ?? 0,
    updatedAt: int(value['updatedAt']) ?? 0,
    mergeState: readMergeState(value['mergeState']),
    dependsOn: strings(value['dependsOn']),
  };
}

/** Newest first, and a commit with no sha cannot be addressed by anything. */
function readCommits(value: unknown): readonly Commit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Commit[] => {
    if (!isRecord(entry)) return [];
    const sha = str(entry['sha']);
    if (sha === undefined) return [];
    return [
      {
        sha,
        subject: str(entry['subject']) ?? '',
        author: str(entry['author']) ?? 'someone',
        at: int(entry['at']) ?? 0,
      },
    ];
  });
}

const VERDICTS: readonly Reviewer['verdict'][] = ['approved', 'changes', 'commented'];

/** A reviewer with an unreadable verdict is one who commented — the weakest claim. */
function readReviewers(value: unknown): readonly Reviewer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Reviewer[] => {
    if (!isRecord(entry)) return [];
    const login = str(entry['login']);
    if (login === undefined) return [];
    return [
      {
        login,
        verdict: VERDICTS.find((candidate) => candidate === entry['verdict']) ?? 'commented',
        comments: int(entry['comments']) ?? 0,
      },
    ];
  });
}

function readChecks(value: unknown): readonly CheckRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CheckRun[] => {
    if (!isRecord(entry)) return [];
    const name = str(entry['name']);
    const state = CHECK_STATES.find((candidate) => candidate === entry['state']);
    // A check with no name is a row with nothing to read, and one with no state
    // would have to be drawn as some state.
    if (name === undefined || state === undefined) return [];
    const durationMs = int(entry['durationMs']);
    const summary = str(entry['summary']);
    const log = str(entry['log']);
    const url = str(entry['url']);
    return [
      {
        name,
        state,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(summary === undefined ? {} : { summary }),
        ...(log === undefined ? {} : { log }),
        ...(url === undefined ? {} : { url }),
      },
    ];
  });
}

function readThreads(value: unknown): readonly ReviewThread[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReviewThread[] => {
    if (!isRecord(entry)) return [];
    const id = str(entry['id']);
    if (id === undefined) return [];
    return [
      {
        id,
        author: str(entry['author']) ?? 'someone',
        path: str(entry['path']) ?? '',
        line: int(entry['line']) ?? null,
        side: entry['side'] === 'left' ? 'left' : 'right',
        resolved: entry['resolved'] === true,
        body: str(entry['body']) ?? '',
        ...(entry['resolvedByYou'] === true ? { resolvedByYou: true as const } : {}),
      },
    ];
  });
}

const MERGE_STATES: readonly PullRequest['mergeState'][] = ['clean', 'blocked', 'dirty', 'behind', 'unknown'];

/** Anything unrecognised is `unknown`, which `canMerge` reads pessimistically. */
const readMergeState = (value: unknown): PullRequest['mergeState'] =>
  MERGE_STATES.find((candidate) => candidate === value) ?? 'unknown';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * `12s` / `4m` / `2h` — how long ago the last sync was.
 *
 * Takes `now` rather than reading a clock, for the reason everything in
 * `model/` does. Deliberately coarse past a minute: the pane head is saying "this
 * is roughly current", and a seconds-precise stamp on a two-hour-old answer is a
 * precision nobody asked for about a number that is already the wrong one.
 */
export function agoText(syncedAt: number | null, now: number): string | null {
  if (syncedAt === null) return null;
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
