import type { CheckRun, CheckState, PullRequest, PrState, ReviewThread } from './model/pr.ts';

/**
 * One GraphQL round-trip per repo, and everything a review tab draws comes out
 * of it.
 *
 * The REST alternative is five calls per PR — the PR, its checks, its reviews,
 * its review threads, its files — and a task with three PRs across two repos
 * would then be sixteen requests per poll. GraphQL is the difference between a
 * feature you can leave on and one you turn off.
 *
 * **Everything is asked for by HEAD BRANCH**, which is the join a task already
 * provides: a worktree is on exactly one branch, which git is asked for. So
 * "which PRs belong to this task" is a lookup rather than a guess, and it stays
 * correct when a PR is renamed, retitled, or opened by somebody else.
 *
 * The mapping below is separated from the request for the reason the whole
 * `model/` directory is separated from this file: the shapes GitHub returns have
 * edge cases (a deleted author, a check with no conclusion, a thread on a line
 * that no longer exists) and those are worth testing without a network.
 */

export const PR_QUERY = `
query($owner: String!, $name: String!, $head: String!, $prs: Int!, $checks: Int!, $files: Int!, $commits: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, first: $prs, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        bodyText
        body
        state
        isDraft
        baseRefName
        headRefName
        # The head COMMIT, which is what tells this task's merged PR from one
        # that merged on a branch of the same name before this task existed.
        # See model/ownership.ts.
        headRefOid
        additions
        deletions
        changedFiles
        createdAt
        updatedAt
        mergeable
        mergeStateStatus
        reviews(last: 50) {
          nodes { state author { login } }
        }
        commits(first: $commits) {
          totalCount
          nodes {
            commit {
              oid
              messageHeadline
              committedDate
              author { user { login } name }
            }
          }
        }
        reviewThreads(first: 50) {
          nodes {
            id
            isResolved
            resolvedBy { login }
            diffSide
            path
            line
            comments(first: 1) { nodes { body author { login } } }
          }
        }
        files(first: $files) {
          nodes { path additions deletions }
        }
        statusOn: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: $checks) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      startedAt
                      completedAt
                      detailsUrl
                      summary: title
                      # The check's own output, which is what the Checks tab
                      # shows instead of sending you to a browser. Capped by
                      # GitHub at 64KB and usually a few lines.
                      text
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                      description
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * `mergeStateStatus` is behind a preview media type. Requested rather than
 * skipped because it is the field that decides whether Merge is offered at all,
 * and the fallback when a server does not send it is `unknown` — which
 * `canMerge` reads pessimistically, so the failure mode is a missing button
 * rather than one that errors.
 */
export const PR_QUERY_MEDIA_TYPE = 'application/vnd.github.merge-info-preview+json';

/** Bounds, so one enormous PR cannot make a poll expensive. */
export const PR_QUERY_LIMITS = { prs: 20, checks: 50, files: 100, commits: 50 } as const;

// ------------------------------------------------------------ what comes back

/**
 * The response, typed rather than validated field by field.
 *
 * This is the one place in the extension where a cast is the right call, and the
 * reason is that the shape is not somebody else's contribution — it is the
 * answer to a query written eighty lines up, from a server with a published
 * schema. What IS guarded below is every field GitHub can legitimately answer
 * `null` for: a deleted account has no `author`, a thread on a line that has
 * gone has no `line`, a repo with no CI has no `statusCheckRollup`.
 */
export interface PrQueryResponse {
  readonly repository: {
    readonly pullRequests: { readonly nodes: readonly RawPullRequest[] | null } | null;
  } | null;
}

interface RawAuthor {
  readonly login: string;
}

interface RawPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string | null;
  readonly bodyText: string | null;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  /** Non-null in the schema, but optional here so a fixture need not carry it. */
  readonly headRefOid?: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergeStateStatus?: string | null;
  readonly reviews: { readonly nodes: readonly RawReview[] | null } | null;
  readonly reviewThreads: { readonly nodes: readonly RawThread[] | null } | null;
  readonly files: { readonly nodes: readonly RawFile[] | null } | null;
  /** The PR's commits, oldest first — what the Commits tab lists. */
  readonly commits: {
    readonly totalCount: number;
    readonly nodes: readonly RawPrCommit[] | null;
  } | null;
  /** The LAST commit only, aliased, because that is where the checks hang. */
  readonly statusOn: { readonly nodes: readonly RawCommit[] | null } | null;
}

interface RawPrCommit {
  readonly commit: {
    readonly oid: string;
    readonly messageHeadline: string;
    readonly committedDate: string;
    readonly author: { readonly user: RawAuthor | null; readonly name: string | null } | null;
  } | null;
}

interface RawReview {
  readonly state: string;
  readonly author: RawAuthor | null;
}

interface RawThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly resolvedBy: RawAuthor | null;
  readonly diffSide: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly comments: { readonly nodes: readonly RawComment[] | null } | null;
}

interface RawComment {
  readonly body: string;
  readonly author: RawAuthor | null;
}

interface RawFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

interface RawCommit {
  readonly commit: {
    readonly statusCheckRollup: {
      readonly contexts: { readonly nodes: readonly RawContext[] | null } | null;
    } | null;
  } | null;
}

type RawContext =
  | {
      readonly __typename: 'CheckRun';
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly detailsUrl: string | null;
      readonly summary: string | null;
      readonly text: string | null;
    }
  | {
      readonly __typename: 'StatusContext';
      readonly context: string;
      readonly state: string;
      readonly targetUrl: string | null;
      readonly description: string | null;
    }
  | { readonly __typename: string };

// ------------------------------------------------------------------ the map

export interface RepoIdentity {
  /** `owner/repo`, as GitHub knows it. */
  readonly repo: string;
  /** The TASK's name for the checkout — the worktree's basename. */
  readonly repoKey: string;
  /** Whose login is "you", so a thread you resolved can be labelled as yours. */
  readonly viewer?: string;
}

export function readPullRequests(response: PrQueryResponse, identity: RepoIdentity): readonly PullRequest[] {
  return (response.repository?.pullRequests?.nodes ?? []).flatMap((node) =>
    node === null ? [] : [readPullRequest(node, identity)],
  );
}

function readPullRequest(raw: RawPullRequest, identity: RepoIdentity): PullRequest {
  const reviews = raw.reviews?.nodes ?? [];
  return {
    repo: identity.repo,
    repoKey: identity.repoKey,
    number: raw.number,
    title: raw.title,
    // `bodyText` is the rendered markdown with the markup taken out, which is
    // what a paragraph wants; `body` is the source and is still read for its
    // `Depends-on:` trailers, where the raw line is the thing.
    body: raw.bodyText ?? '',
    state: readState(raw),
    baseRef: raw.baseRefName,
    headRef: raw.headRefName,
    headOid: raw.headRefOid ?? '',
    url: raw.url,
    added: raw.additions,
    removed: raw.deletions,
    changedFiles: raw.changedFiles,
    checks: readChecks(raw),
    approvals: latestByAuthor(reviews, 'APPROVED'),
    changesRequested: latestByAuthor(reviews, 'CHANGES_REQUESTED'),
    threads: readThreads(raw, identity),
    files: (raw.files?.nodes ?? []).map((file) => ({
      path: file.path,
      added: file.additions,
      removed: file.deletions,
    })),
    commits: readCommits(raw),
    reviewers: readReviewers(reviews, raw),
    openedAt: Date.parse(raw.createdAt),
    updatedAt: Date.parse(raw.updatedAt),
    mergeState: readMergeState(raw.mergeStateStatus),
    dependsOn: readDependsOn(raw.body ?? ''),
  };
}

/**
 * `isDraft` beats `state`, because GitHub reports a draft as `OPEN` and the two
 * mean different things everywhere this is read — see `PrState`.
 */
function readState(raw: RawPullRequest): PrState {
  if (raw.state === 'MERGED') return 'merged';
  if (raw.state === 'CLOSED') return 'closed';
  return raw.isDraft ? 'draft' : 'open';
}

/**
 * Two vocabularies, reduced to one.
 *
 * A `CheckRun` has a `status` (queued/in_progress/completed) AND a `conclusion`
 * (success/failure/neutral/…), and only the pair says what happened: a completed
 * run with no conclusion has not reported one, and an in-progress run's
 * conclusion is null and means nothing. A `StatusContext` is the older commit
 * status API with a single `state`, which repos with third-party CI still use.
 */
function readChecks(raw: RawPullRequest): readonly CheckRun[] {
  const contexts = raw.statusOn?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return contexts.flatMap((context): CheckRun[] => {
    if (context.__typename === 'CheckRun') {
      const run = context as Extract<RawContext, { __typename: 'CheckRun' }>;
      return [
        {
          name: run.name,
          state: checkRunState(run.status, run.conclusion),
          ...duration(run.startedAt, run.completedAt),
          ...(run.summary === null || run.summary === '' ? {} : { summary: run.summary }),
          ...(run.text === null || run.text === '' ? {} : { log: run.text }),
          ...(run.detailsUrl === null ? {} : { url: run.detailsUrl }),
        },
      ];
    }
    if (context.__typename === 'StatusContext') {
      const status = context as Extract<RawContext, { __typename: 'StatusContext' }>;
      return [
        {
          name: status.context,
          state: statusContextState(status.state),
          ...(status.description === null || status.description === ''
            ? {}
            : { summary: status.description }),
          ...(status.targetUrl === null ? {} : { url: status.targetUrl }),
        },
      ];
    }
    // A context kind this build does not know. Dropped rather than guessed at:
    // an unknown check counted as passing would make a green meter a lie, and
    // counted as failing would make every repo look broken after an API change.
    return [];
  });
}

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== 'COMPLETED') return 'running';
  switch (conclusion) {
    case 'SUCCESS':
      return 'passed';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failed';
    case 'SKIPPED':
    case 'NEUTRAL':
    case 'CANCELLED':
    case 'ACTION_REQUIRED':
    case 'STALE':
      // Not `failed`, and this is the judgement call in the file. A cancelled or
      // stale run is a run that did not happen, and colouring the task red for
      // one would make a cancelled workflow indistinguishable from a broken
      // build. `ACTION_REQUIRED` is the arguable one and goes here because the
      // action it requires is on GitHub, not in the code.
      return 'skipped';
    default:
      return 'skipped';
  }
}

const statusContextState = (state: string): CheckState =>
  state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : state === 'PENDING' ? 'running' : 'skipped';

function duration(startedAt: string | null, completedAt: string | null): { durationMs?: number } {
  if (startedAt === null || completedAt === null) return {};
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? { durationMs: ms } : {};
}

/**
 * One review per author, the LATEST — which is what "approved" has to mean.
 *
 * A reviewer who asks for changes and then approves has two reviews in the list,
 * and counting both would draw a PR as simultaneously approved and blocked. The
 * query asks for them in order, so the last mention of an author wins.
 *
 * `COMMENTED` and `DISMISSED` are deliberately not states this returns: a
 * comment is not a verdict, and a dismissed review has been explicitly
 * withdrawn. Both simply leave the author out of both lists.
 */
function latestByAuthor(reviews: readonly RawReview[], want: 'APPROVED' | 'CHANGES_REQUESTED'): readonly string[] {
  const verdicts = new Map<string, string>();
  for (const review of reviews) {
    const login = review.author?.login;
    if (login === undefined) continue;
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') continue;
    verdicts.set(login, review.state);
  }
  return [...verdicts].filter(([, state]) => state === want).map(([login]) => login);
}

function readThreads(raw: RawPullRequest, identity: RepoIdentity): readonly ReviewThread[] {
  return (raw.reviewThreads?.nodes ?? []).flatMap((thread): ReviewThread[] => {
    const first = thread.comments?.nodes?.[0];
    // A thread with no comments is not a thread anybody wrote. It happens when
    // every comment in it has been deleted.
    if (first === undefined) return [];
    /*
     * `resolvedBy` is the viewer's account, which is also the account an agent
     * acts through — so this cannot distinguish "you clicked resolve" from "your
     * agent did". The label it feeds says `resolved by the agent`, which is the
     * more useful of the two readings and is a guess either way; `ReviewThread`
     * records that.
     */
    const yours =
      thread.isResolved && identity.viewer !== undefined && thread.resolvedBy?.login === identity.viewer;
    return [
      {
        id: thread.id,
        author: first.author?.login ?? 'someone',
        path: thread.path ?? '',
        line: thread.line,
        // `RIGHT` is GitHub's own default and the overwhelming case: a comment
        // is nearly always about the code that arrived.
        side: thread.diffSide === 'LEFT' ? 'left' : 'right',
        resolved: thread.isResolved,
        body: first.body,
        ...(yours ? { resolvedByYou: true } : {}),
      },
    ];
  });
}

/**
 * The commits, NEWEST FIRST — the reverse of what GitHub sends.
 *
 * A list of commits is read the way a log is: the last thing that happened at
 * the top. GitHub returns them in application order, which is the order they
 * will land in and the wrong one for looking at.
 *
 * The author falls back from the GitHub account to the git name, because a
 * commit made by a machine (an agent's, most of the time here) often has no
 * linked user at all — and `someone` for every commit of a PR an agent wrote is
 * a column of nothing.
 */
function readCommits(raw: RawPullRequest): readonly PullRequest['commits'][number][] {
  const nodes = raw.commits?.nodes ?? [];
  return [...nodes]
    .flatMap((node) => {
      const commit = node.commit;
      if (commit === null || commit === undefined) return [];
      return [
        {
          sha: commit.oid,
          subject: commit.messageHeadline,
          author: commit.author?.user?.login ?? commit.author?.name ?? 'someone',
          at: Date.parse(commit.committedDate),
        },
      ];
    })
    .reverse();
}

/**
 * Everyone who looked, and what they left — the meta column's first block.
 *
 * A reviewer with no verdict is still a reviewer if they left a thread: the
 * question that block answers is "who has been through this", and somebody who
 * commented six times without approving has been through it more than somebody
 * who clicked approve.
 */
function readReviewers(reviews: readonly RawReview[], raw: RawPullRequest): PullRequest['reviewers'] {
  const threads = raw.reviewThreads?.nodes ?? [];
  const comments = new Map<string, number>();
  for (const thread of threads) {
    const login = thread.comments?.nodes?.[0]?.author?.login;
    if (login !== undefined) comments.set(login, (comments.get(login) ?? 0) + 1);
  }

  const verdicts = new Map<string, 'approved' | 'changes'>();
  for (const review of reviews) {
    const login = review.author?.login;
    if (login === undefined) continue;
    if (review.state === 'APPROVED') verdicts.set(login, 'approved');
    else if (review.state === 'CHANGES_REQUESTED') verdicts.set(login, 'changes');
  }

  const logins = new Set([...verdicts.keys(), ...comments.keys()]);
  return [...logins].map((login) => ({
    login,
    verdict: verdicts.get(login) ?? 'commented',
    comments: comments.get(login) ?? 0,
  }));
}

const MERGE_STATES = ['clean', 'blocked', 'dirty', 'behind', 'unknown'] as const;

/**
 * Anything unrecognised — including the field being absent, which is what a
 * server without the preview media type answers — is `unknown`, and `canMerge`
 * reads that pessimistically. A missing Merge button is a much better failure
 * than one that errors.
 */
function readMergeState(status: string | null | undefined): PullRequest['mergeState'] {
  const lower = status?.toLowerCase() ?? '';
  return MERGE_STATES.find((candidate) => candidate === lower) ?? 'unknown';
}

/**
 * `Depends-on: owner/repo#123` in the body, which is a convention and is treated
 * as one: it orders a list and never gates a merge (`landOrder` says why).
 *
 * Case-insensitive on the key because people write it three ways, and tolerant
 * of a full URL because that is what pasting a PR link produces.
 */
const DEPENDS_ON = /^\s*depends[-\s]?on:\s*(.+)$/gim;
const REFERENCE = /(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\/pull\/|#)(\d+)/g;

export function readDependsOn(body: string): readonly string[] {
  const found = new Set<string>();
  for (const line of body.matchAll(DEPENDS_ON)) {
    const rest = line[1] ?? '';
    for (const reference of rest.matchAll(REFERENCE)) {
      found.add(`${reference[1]}#${reference[2]}`);
    }
  }
  return [...found];
}
