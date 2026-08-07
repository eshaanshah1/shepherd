import {
  extensionId,
  isPermission,
  PERMISSIONS,
  s,
  type ExtensionID,
  type ExtensionSource,
  type KV,
  type Logger,
  type Manifest,
  type Permission,
} from '@shepherd/sdk';
import { emptyGrants, type GrantSet } from '../commands/authorize.ts';

/**
 * Who was granted what — **review at install, grant once** (§7b).
 *
 * There is no prompt state machine here and no first-use interrupt, and that is
 * the decision rather than an omission: a capability an extension declares is
 * reviewed when it is installed, a capability an *update* adds re-prompts, and
 * one asking for the same or fewer does not. `permissionDiff` is the whole of
 * that rule, pure, so the thing that decides whether a user is interrupted can be
 * read in one screen.
 *
 * Everything else is a store over the SDK's `KV`, which brings its own
 * discipline: a stored grant that no longer validates reads as **absent** and
 * logs, never throws. A permission blob written by an older build must not be
 * able to stop the app from starting.
 */

export interface PermissionDiff {
  readonly added: Permission[];
  readonly removed: Permission[];
  /**
   * True **iff something was added**. Removing a permission is not a review
   * event: nothing new can happen to the user because of it, and a prompt that
   * fires when an extension asks for *less* is how people learn to click through
   * prompts without reading them.
   */
  readonly needsReview: boolean;
}

export function permissionDiff(
  granted: readonly Permission[],
  requested: readonly Permission[],
): PermissionDiff {
  const held = new Set(granted);
  const wanted = new Set(requested);
  const added = [...wanted].filter((permission) => !held.has(permission));
  const removed = [...held].filter((permission) => !wanted.has(permission));
  return { added, removed, needsReview: added.length > 0 };
}

/** What `review` decided, and why the caller may or may not have to ask. */
export interface ReviewOutcome {
  /** The extension now holds everything it declared. */
  readonly granted: boolean;
  readonly needsReview: boolean;
  readonly added: Permission[];
  readonly removed: Permission[];
}

/**
 * The stored shape. Read with this schema at the call site rather than trusted:
 * the row was written by some earlier version of this code.
 */
const grantSchema = s.array(s.enumOf(PERMISSIONS));

export class PermissionStore {
  readonly #kv: KV;
  readonly #log;

  constructor(kv: KV, logger: Logger) {
    this.#kv = kv;
    this.#log = logger.child('extension');
  }

  granted(id: ExtensionID): readonly Permission[] {
    const stored = this.#kv.get(id, grantSchema);
    if (stored !== undefined) return stored;
    // The KV logs *what* failed to validate; this line says what it cost, which is
    // the question anybody debugging "the extension lost its permissions" asks.
    // Without it, a corrupt row and a never-granted extension are the same silence.
    if (this.#kv.keys().includes(id)) {
      this.#log.warn(`stored grant for ${id} did not validate — treating it as ungranted`);
    }
    return [];
  }

  grant(id: ExtensionID, permissions: readonly Permission[]): void {
    const known = permissions.filter((permission) => {
      if (isPermission(permission)) return true;
      // Reachable from a transport, where the `Permission` type is a claim. An
      // unknown string written here would fail its own read schema later and take
      // the whole grant with it.
      this.#log.warn(`refusing to grant unknown permission ${JSON.stringify(permission)} to ${id}`);
      return false;
    });
    const canonical = canonicalize(known);
    this.#kv.set(id, canonical);
    this.#log.info(`granted ${id}: ${canonical.length === 0 ? '(nothing)' : canonical.join(', ')}`);
  }

  revoke(id: ExtensionID): void {
    this.#kv.delete(id);
    this.#log.info(`revoked every permission for ${id}`);
  }

  isGranted(id: ExtensionID, permission: Permission): boolean {
    return this.granted(id).includes(permission);
  }

  /** The declared permissions this extension does not hold — an activation gate's error text. */
  missing(manifest: Manifest): readonly Permission[] {
    const held = new Set(this.granted(extensionId(manifest.id)));
    return manifest.permissions.filter((permission) => !held.has(permission));
  }

  /**
   * The shape `authorize` consumes.
   *
   * `devices` and `agents` are empty because neither principal exists yet —
   * devices arrive with the remote layer, agents with the agent layer. An empty
   * map is the honest statement of that: `authorize` reads an absent principal as
   * *unknown*, which denies, so nothing is accidentally permitted by the gap.
   */
  grantSet(): GrantSet {
    const extensions = new Map<ExtensionID, readonly Permission[]>();
    for (const key of this.#kv.keys()) {
      const id = extensionId(key);
      const stored = this.#kv.get(key, grantSchema);
      // A corrupt row is skipped, not fatal: one unreadable grant must not cost
      // every other extension its permissions. `granted` has already logged it.
      if (stored === undefined) {
        this.#log.warn(`stored grant for ${key} did not validate — omitted from the grant set`);
        continue;
      }
      extensions.set(id, stored);
    }
    return { ...emptyGrants(), extensions };
  }

  /**
   * Install-time review — **the one place `source` decides a grant**.
   *
   * A built-in is pre-granted everything it declares (§7: built-ins ship inside
   * the app, are required to consume proposed APIs, and are the proving ground —
   * the user already trusts the app, and a prompt they cannot decline without
   * breaking the product teaches nothing). A `user` extension starts ungranted and
   * its first review is a real review.
   *
   * Pre-granting is an install-time decision, **not** a bypass: `isGranted` and
   * `grantSet` have no idea what a source is, so a revoked built-in is denied like
   * anyone else. It is re-granted by its next `review` (i.e. the next launch),
   * because a built-in that stayed denied would leave the app partly broken with
   * no permission UI in M1 to put it back.
   */
  review(manifest: Manifest, source: ExtensionSource): ReviewOutcome {
    const id = extensionId(manifest.id);
    const diff = permissionDiff(this.granted(id), manifest.permissions);

    if (source === 'builtin') {
      this.grant(id, manifest.permissions);
      this.#log.info(`${id} is builtin — pre-granted at install`);
      return { granted: true, needsReview: false, added: diff.added, removed: diff.removed };
    }

    if (diff.needsReview) {
      // The old, narrower grant is left exactly as it was. Writing the requested
      // set here would make the re-prompt cosmetic — the capability would already
      // be held by the time anybody was asked.
      this.#log.info(
        `${id} needs review: adds ${diff.added.join(', ')} (still holding ${this.granted(id).join(', ') || 'nothing'})`,
      );
      return { granted: false, needsReview: true, added: diff.added, removed: diff.removed };
    }

    // Same or fewer: carried without a prompt, and **narrowed** to what the
    // manifest now declares. Keeping a permission the extension no longer asks for
    // would leave a capability nothing declares and nothing shows.
    this.grant(id, manifest.permissions);
    return { granted: true, needsReview: false, added: diff.added, removed: diff.removed };
  }
}

/**
 * One representation per set: deduped, in the order `PERMISSIONS` declares.
 * Two orderings of the same grant would make every later comparison
 * order-dependent, and a comparison is what decides whether a user is prompted.
 */
function canonicalize(permissions: readonly Permission[]): Permission[] {
  const held = new Set(permissions);
  return PERMISSIONS.filter((permission) => held.has(permission));
}
