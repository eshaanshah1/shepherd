/**
 * What an extension may do, declared in its manifest and reviewed once at
 * install (decided 2026-08-07: **review-at-install, grant once**; a capability
 * added by an update re-prompts, and there are no first-use interrupts).
 *
 * The set is coarse on purpose. A permission a user cannot reason about at
 * install time is a permission they will grant without reading, so these name
 * consequences ("can run arbitrary programs") rather than API surfaces.
 */
export const PERMISSIONS = [
  /** Create/read/write terminal sessions, incl. injecting input. */
  'sessions',
  /** Run arbitrary programs, including git. The heaviest grant here. */
  'process.exec',
  /** Namespaced key/value storage. */
  'storage',
  /** Keychain-backed secrets belonging to this extension. */
  'secrets',
  /** Contribute views, tree data, status items. */
  'views',
  /** Mutate the layout: open, split, focus, close. */
  'layout',
  /** Set attention levels, which reach the badge and notifications. */
  'attention',
  /** Reach the network. Relevant to panels and to anything polling an API. */
  'network',
  /**
   * Ask a model something — the headless-agent seam `agents-core` exports
   * (`complete`/`stream` over `claude -p --output-format stream-json`).
   *
   * Its own grant rather than a corollary of `process.exec`, because it spends
   * the user's model budget and its consequences are not the ones "can run
   * programs" prepares somebody for. Listed here in M1, ahead of its M2
   * implementation, so the manifest vocabulary is stable before extensions
   * start declaring against it.
   */
  'agents',
  /**
   * Write a setting in this extension's own namespace.
   *
   * READING needs no grant: an extension is handed its own effective values at
   * activation, and a permission over "may I know my own configuration" would be
   * a permission over nothing. Writing is a grant because a setting is a user's
   * decision, and an extension that can rewrite one silently can undo one.
   */
  'settings',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * A built-in ships inside the app and is trusted with everything; a `user`
 * extension was installed from somewhere and is not. The distinction is also
 * the API-stability gate: built-ins are *required* to consume proposed APIs
 * (that is the proving ground), while a user extension may only touch them in a
 * dev build.
 */
export type ExtensionSource = 'builtin' | 'user';
