import type { ProcessAPI } from '@shepherd/sdk';
import { parseRemote, type RepoSlug } from './model/remote.ts';

/**
 * Which GitHub repository a checkout on this disk belongs to — asked once per
 * directory and remembered.
 *
 * Memoized because it is the one input to a sync that genuinely does not change:
 * a repo's `origin` is set at clone and edited about once a career, while the
 * PRs on it change every minute. Without the cache this is a subprocess per repo
 * per poll, forever, for an answer that was the same the first time.
 *
 * `null` is cached too, and that is the more important half. A repo with no
 * remote, or one on GitLab, is the case that would otherwise pay for a `git`
 * spawn on every tick to be told the same "no" — and it is a case every
 * multi-repo user has (a scratch repo, a vendored checkout).
 *
 * `origin` and nothing else. A user with three remotes has a favourite and it is
 * not this code's business to guess which; `origin` is the one git itself
 * defaults to everywhere.
 */
export class Remotes {
  readonly #process: ProcessAPI;
  readonly #known = new Map<string, RepoSlug | null>();
  /** In-flight lookups, so ten tasks in one repo make one subprocess. */
  readonly #asking = new Map<string, Promise<RepoSlug | null>>();

  constructor(process: ProcessAPI) {
    this.#process = process;
  }

  async of(repoPath: string): Promise<RepoSlug | null> {
    const known = this.#known.get(repoPath);
    if (known !== undefined) return known;
    const asking = this.#asking.get(repoPath);
    if (asking !== undefined) return asking;

    const lookup = this.#read(repoPath).then((slug) => {
      this.#known.set(repoPath, slug);
      this.#asking.delete(repoPath);
      return slug;
    });
    this.#asking.set(repoPath, lookup);
    return lookup;
  }

  /** Ask again — what `github.sync` does, for a remote added since launch. */
  forget(): void {
    this.#known.clear();
  }

  async #read(repoPath: string): Promise<RepoSlug | null> {
    const result = await this.#process.gitRead(['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      // Two seconds is generous for a config read. It is here at all because a
      // repo on a stalled network mount would otherwise hold the sync open.
      timeoutMs: 2_000,
    });
    // A repo with no `origin` exits non-zero, which is an answer rather than a
    // failure — and the same answer as a remote pointing somewhere else.
    return result.ok ? parseRemote(result.stdout) : null;
  }
}
