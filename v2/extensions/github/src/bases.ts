import { slugText, type RepoSlug } from './model/remote.ts';

/**
 * Which branch a repo opens pull requests against — asked once per repo and
 * remembered.
 *
 * The same trade `Remotes` makes one file over, and for a stronger reason. A
 * repo's default branch is set at creation and changed about as often as its
 * remote, but learning it is a NETWORK round trip rather than a subprocess, and
 * the caller is `prReadiness` — which runs on every draw of the changes pane.
 *
 * **Measured, before this existed:** that pane redrew 90 times a minute, so it
 * spent 90 REST requests a minute discovering the same four letters. GitHub
 * allows 5000 an hour. One pane, on one task, was over the ceiling on its own.
 *
 * `null` is cached too, and it is the half that matters again: a repo the token
 * cannot see, or one that has gone, answers `null` and would otherwise pay for a
 * failed round trip on every redraw to be told the same no.
 *
 * **`undefined` is the third answer, and it is not cached.** It means the
 * question was never put — there is no client, because nobody is signed in. That
 * is not a fact about the repo, and storing it as one would leave the pane
 * saying "cannot tell which branch to open against" after a `gh auth login`
 * until somebody thought to press sync. Uncached, the answer is simply asked
 * again on the next draw, which is what it did before this cache existed.
 *
 * Keyed by `owner/repo` rather than by the slug object — two lookups for one
 * repo arrive as two different objects, and an identity-keyed map would cache
 * neither of them usefully.
 */
export class Bases {
  readonly #ask: (slug: RepoSlug) => Promise<string | null | undefined>;
  readonly #known = new Map<string, string | null>();
  /** In-flight lookups, so ten panes on one repo make one request. */
  readonly #asking = new Map<string, Promise<string | null>>();

  constructor(ask: (slug: RepoSlug) => Promise<string | null | undefined>) {
    this.#ask = ask;
  }

  async of(slug: RepoSlug): Promise<string | null> {
    const key = slugText(slug);
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    const asking = this.#asking.get(key);
    if (asking !== undefined) return asking;

    const lookup = this.#ask(slug).then((base) => {
      this.#asking.delete(key);
      if (base === undefined) return null;
      this.#known.set(key, base);
      return base;
    });
    this.#asking.set(key, lookup);
    return lookup;
  }

  /** Ask again — what `github.sync` does, and what a signed-out client needs. */
  forget(): void {
    this.#known.clear();
  }
}
