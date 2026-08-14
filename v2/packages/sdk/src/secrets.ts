/**
 * Secrets an extension needs, DECLARED — so the user can see what is being asked
 * for before anything asks for it.
 *
 * The shape of the problem: an extension needs a credential it cannot ask for
 * itself. Its service half runs in a utility process with no DOM, so it has no
 * surface to prompt on; and a prompt at first use would be a dialog appearing
 * because a background sync woke up, which is the interruption pattern the
 * whole permission model exists to avoid (review-at-install, grant once).
 *
 * So a secret is declared in the manifest the same way a settings page is, for
 * the same reason and with the same consequence: **the Secrets screen lists what
 * every installed extension wants with none of them activated.** You see the ask
 * and decide, rather than being asked.
 *
 * ── what a declaration is NOT ────────────────────────────────────────────────
 *
 * It is not a grant. Declaring `token` says "this extension has a use for a
 * GitHub token"; reading it still needs the `secrets` permission, checked by the
 * one authorizer in the dispatcher. Two gates, and they answer different
 * questions — *what* is wanted, and *whether this extension may hold one at all*.
 *
 * And it is not storage. A declared secret with no value is the ordinary state:
 * most people will never fill most of them in, and an extension is expected to
 * work out what to do with nothing (see `github`, which asks `gh` first).
 */

export interface SecretSpec {
  /**
   * The leaf name, within the declaring extension's own namespace — `token`,
   * not `github.token`.
   *
   * A leaf for the reason a setting key is namespaced by the host rather than by
   * the extension: an extension that wrote its own prefix could write somebody
   * else's, and the host is the only party in a position to refuse.
   */
  readonly key: string;
  /** What it is, in the user's words. `GitHub token`, not `GITHUB_TOKEN`. */
  readonly title: string;
  /**
   * What it is for, and — the part that matters — **how to get one**. A secrets
   * screen that names a credential without saying where it comes from is a form
   * you cannot fill in.
   */
  readonly description?: string;
  /**
   * Where to go and make one. Shown as a link beside the field.
   *
   * `https:` only, checked by the host: this is a string from a manifest and it
   * becomes something a user clicks.
   */
  readonly link?: string;
}

/**
 * Where a secret's value lives — `<extension id>/<key>`.
 *
 * The id in full rather than `namespaceOf`'s last segment, which is what
 * settings uses. Settings keys are read across extensions on purpose (everyone
 * may read `shepherd.*`) and so they share a flat space with short names;
 * secrets are read by exactly one extension each, and a collision between
 * `acme.github` and `shepherd.github` would be two extensions sharing a
 * credential neither declared.
 */
export const secretPath = (extensionId: string, key: string): string => `${extensionId}/${key}`;

/** Is this a leaf name the host will accept? */
export function secretKeyIssue(key: string): string | undefined {
  if (key === '') return 'a secret key must not be empty';
  // A `/` would let a declaration escape its own namespace, which is the one
  // thing `secretPath` is for. The rest of the shape is ordinary hygiene.
  if (!/^[a-zA-Z][\w-]*$/.test(key)) {
    return `a secret key must start with a letter and hold only letters, digits, "_" and "-", got ${JSON.stringify(key)}`;
  }
  return undefined;
}

/** Is this a link the host will draw? */
export function secretLinkIssue(link: string): string | undefined {
  // `https:` only. A manifest is a string somebody else wrote, and this one
  // becomes a URL a user clicks — `file:` and `javascript:` are the reason this
  // is a check rather than a convention.
  return link.startsWith('https://') ? undefined : `a secret link must be https, got ${JSON.stringify(link)}`;
}
