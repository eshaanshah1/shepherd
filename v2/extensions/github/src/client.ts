import { Octokit } from '@octokit/rest';
import type { ChangedFile, PullRequest } from './model/pr.ts';
import type { RepoSlug } from './model/remote.ts';
import { slugText } from './model/remote.ts';
import {
  PR_QUERY,
  PR_QUERY_LIMITS,
  PR_QUERY_MEDIA_TYPE,
  readPullRequests,
  type PrQueryResponse,
} from './query.ts';

/**
 * The only file that talks to GitHub, and it is deliberately thin.
 *
 * Everything interesting is either in `query.ts` (which shape means what) or in
 * `model/` (which PR is worst, what the row says). What is left here is a
 * client, a deadline and three verbs — which is also what makes the rest of the
 * extension testable without a network.
 *
 * **It is an interface first and an Octokit second.** `index.ts` depends on
 * `GitHubClient`, so the sync loop and every command can be driven by a fake in
 * a test; `octokitClient` is the one implementation that needs a token.
 */

export interface GitHubClient {
  /** Whose account this is. Used to label a thread resolved through it. */
  viewer(): Promise<string | null>;
  /** Every PR whose head is `branch`, in that repo — open, draft, merged, closed. */
  pullRequests(slug: RepoSlug, branch: string, repoKey: string): Promise<readonly PullRequest[]>;
  merge(slug: RepoSlug, number: number): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /**
   * The changed files WITH their patches — a second request, made once, when
   * somebody opens the Files tab.
   *
   * REST rather than GraphQL, and that is not a preference: GraphQL's
   * `PullRequestChangedFile` has no patch field at all. The diff is only
   * reachable through `pulls.listFiles`, so this is the one call in the
   * extension that leaves the single-round-trip design — deliberately, because
   * a patch is the largest thing about a PR by an order of magnitude and
   * fetching one per PR per poll would make the sync loop the most expensive
   * thing in the app.
   */
  files(slug: RepoSlug, number: number): Promise<readonly ChangedFile[]>;
}

/**
 * Long enough for a slow morning, short enough that a hung request does not hold
 * a sync open forever. The loop below runs on a timer, so a request that
 * outlived its interval would start overlapping itself.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** GitHub's own page size, and the most files worth drawing in a pane. */
export const FILE_PAGE = 100;

export function octokitClient(token: string): GitHubClient {
  const octokit = new Octokit({
    auth: token,
    userAgent: 'shepherd',
    request: { timeout: REQUEST_TIMEOUT_MS },
  });

  return {
    async viewer() {
      const { data } = await octokit.rest.users.getAuthenticated();
      return data.login;
    },

    async pullRequests(slug, branch, repoKey) {
      const response = await octokit.graphql<PrQueryResponse>(PR_QUERY, {
        owner: slug.owner,
        name: slug.repo,
        head: branch,
        ...PR_QUERY_LIMITS,
        mediaType: { previews: [], format: '' },
        headers: { accept: PR_QUERY_MEDIA_TYPE },
      });
      return readPullRequests(response, { repo: slugText(slug), repoKey });
    },

    async files(slug, number) {
      /*
       * One page, and the cap is deliberate rather than a TODO.
       *
       * GitHub allows 300 files per PR and 100 per page. A change with more
       * than a hundred files is one nobody reads file-by-file in a pane, and
       * three requests to draw a list somebody will scroll past is three
       * requests spent on the least likely case. `log` says what was dropped —
       * a silent truncation reads as "that is all of them".
       */
      const { data } = await octokit.rest.pulls.listFiles({
        owner: slug.owner,
        repo: slug.repo,
        pull_number: number,
        per_page: FILE_PAGE,
      });
      return data.map((file) => ({
        path: file.filename,
        added: file.additions,
        removed: file.deletions,
        /*
         * ABSENT rather than empty for a file GitHub withheld: it omits `patch`
         * for anything binary or over about a megabyte, and an empty string
         * would draw as a file with no changes rather than as one whose diff is
         * not available.
         */
        ...(file.patch === undefined || file.patch === '' ? {} : { patch: file.patch }),
      }));
    },

    async merge(slug, number) {
      try {
        await octokit.rest.pulls.merge({ owner: slug.owner, repo: slug.repo, pull_number: number });
        return { ok: true };
      } catch (error: unknown) {
        /*
         * A merge that GitHub refuses is an ordinary answer, not a crash: the
         * branch moved under you, a required check went red between the click
         * and the call, somebody else merged it first. The message is GitHub's
         * own, because it is the one that says which of those happened.
         */
        return { ok: false, reason: message(error) };
      }
    },
  };
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Is this a credential problem, rather than a network one?
 *
 * Worth telling apart because the two want opposite responses: a 401 means stop
 * polling and say "not signed in", where a timeout means try again in a minute.
 * A loop that treated an expired token as a blip would ask a server to reject it
 * every sixty seconds for the life of the app.
 */
export function isAuthFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}
