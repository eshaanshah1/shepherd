import { callerLabel, type Caller, type ExtensionID, type Permission, type SessionID } from '@shepherd/sdk';

/**
 * Who may invoke what — the one authorization seam.
 *
 * v1 authorized on the **read** side only: a device that could see a workspace
 * could also mutate it, because the three routing paths (`controlRoute`,
 * `applyRemoteCommand`, `ShortcutActions`) each decided for themselves what a
 * caller was allowed to do, and none of them checked writes. This function is
 * the whole replacement, and it runs in the dispatcher before any handler.
 *
 * Deliberately pure and deliberately taking `grants` as a **value**: that is
 * what lets it exist and be fully tested four phases before a `PermissionStore`
 * does, and it means an authorization decision can be replayed from a log line.
 */

export interface GrantSet {
  /** Loaded extensions → what the user granted at install. */
  readonly extensions: ReadonlyMap<ExtensionID, readonly Permission[]>;
  /** Paired devices → their entitlements. */
  readonly devices: ReadonlyMap<string, readonly Permission[]>;
  /** Live agent sessions → what that session may drive. */
  readonly agents: ReadonlyMap<SessionID, readonly Permission[]>;
}

export function emptyGrants(): GrantSet {
  return { extensions: new Map(), devices: new Map(), agents: new Map() };
}

export type Verdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOW: Verdict = { allowed: true };
const deny = (reason: string): Verdict => ({ allowed: false, reason });

/**
 * `required === undefined` means the command declares no permission — any
 * *known* principal may invoke it. Membership is still checked: reaching a unix
 * socket is not an identity, and an extension that is not loaded, a device that
 * is not paired, and a session id that is not live are all claims rather than
 * facts. Disbelieving them here is cheaper than every handler wondering.
 */
export function authorize(caller: Caller, required: Permission | undefined, grants: GrantSet): Verdict {
  if (caller.kind === 'user') return ALLOW;
  // The kernel has no principal to check against — it IS the thing checking, and a
  // `kernel` caller cannot arrive over a transport (`externalCallerSchema` has no
  // such variant). This is an absence of a subject, not a privilege level.
  if (caller.kind === 'kernel') return ALLOW;

  const held = lookup(caller, grants);
  if (held === undefined) {
    return deny(`${callerLabel(caller)} is unknown (not registered as a live principal)`);
  }
  if (required === undefined) return ALLOW;
  if (held.includes(required)) return ALLOW;
  return deny(`${callerLabel(caller)} lacks permission "${required}"`);
}

function lookup(caller: Caller, grants: GrantSet): readonly Permission[] | undefined {
  switch (caller.kind) {
    case 'user':
    case 'kernel':
      return undefined; // both handled above; neither has a permission list
    case 'extension':
      return grants.extensions.get(caller.id);
    case 'device':
      return grants.devices.get(caller.deviceId);
    case 'agent':
      return grants.agents.get(caller.sessionId);
  }
}
