/**
 * A git remote URL → the repository GitHub knows it as.
 *
 * Pure, and its own file, because it is the one place a *string somebody else
 * wrote* becomes two identifiers this extension then queries an API with. Every
 * form below was found on a real machine, and the parser is deliberately strict
 * about the one thing that matters — the host — because a permissive one turns a
 * GitLab remote into a GitHub API call that 404s, which reads as "the PR is
 * gone" rather than as "this is not GitHub".
 *
 * The forms:
 *
 *   https://github.com/owner/repo.git
 *   https://user@github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   git://github.com/owner/repo.git
 *   github.com:owner/repo            (a `Host` alias in ~/.ssh/config resolves it)
 *
 * GitHub Enterprise is out of scope and says so: an enterprise host is a
 * different API base URL, and guessing one from a remote is how you send a
 * token to the wrong server.
 */

export interface RepoSlug {
  readonly owner: string;
  readonly repo: string;
}

/** `owner/repo`, which is how a PR row names it and how the API path reads. */
export const slugText = (slug: RepoSlug): string => `${slug.owner}/${slug.repo}`;

const HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * `null` for anything that is not a github.com remote — including a remote that
 * IS one and is malformed. A caller cannot act on the difference (there is no PR
 * to find either way), and a second return shape would be a distinction it would
 * have to handle in order to ignore.
 */
export function parseRemote(url: string): RepoSlug | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;

  // The scp-like form, which is not a URL and so cannot go through `URL`:
  // `git@github.com:owner/repo.git`. Matched first because `URL` accepts it as a
  // relative path against a base and yields nonsense rather than throwing.
  const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp !== null && !trimmed.includes('://')) {
    const [, , host = '', path = ''] = scp;
    return HOSTS.has(host.toLowerCase()) ? parsePath(path) : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsePath(parsed.pathname);
}

/**
 * `/owner/repo.git` → the pair.
 *
 * Deeper paths are refused rather than truncated to their first two segments: a
 * remote with three is not a repository this can address, and answering with the
 * first two would be a confident wrong answer where `null` is a correct one.
 */
function parsePath(path: string): RepoSlug | null {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length !== 2) return null;
  const [owner = '', last = ''] = parts;
  const repo = last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}
