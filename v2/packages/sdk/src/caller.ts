import { s, type Schema } from './schema.ts';
import type { ExtensionID, SessionID } from './ids.ts';

/**
 * WHO is asking. Every command invocation and every event carries one, and
 * authorization runs against it **in the dispatcher**, before any handler.
 *
 * v1 authorized only on the read side, so a device that could see a workspace
 * could also mutate it; and it had three separate routing implementations, none
 * of which agreed on what a caller was. One union, checked once, is the fix.
 *
 * The four kinds are not decoration:
 *   - `user`      — a keystroke, a menu item, a palette entry. Fully trusted.
 *   - `extension` — checked against that extension's granted permissions.
 *   - `device`    — a paired phone or Mac; checked against its entitlements.
 *   - `agent`     — a Claude session invoking commands about its OWN work.
 *                   Scoping an agent to its task is then one predicate here
 *                   rather than N checks spread through N handlers.
 */
export type Caller =
  | { readonly kind: 'user' }
  | { readonly kind: 'extension'; readonly id: ExtensionID }
  | { readonly kind: 'device'; readonly deviceId: string }
  | { readonly kind: 'agent'; readonly sessionId: SessionID };

export type CallerKind = Caller['kind'];

/** The caller for anything the human did directly. */
export const USER: Caller = { kind: 'user' };

/** For a log line or an error message: short, stable, and greppable. */
export function callerLabel(caller: Caller): string {
  switch (caller.kind) {
    case 'user':
      return 'user';
    case 'extension':
      return `extension:${caller.id}`;
    case 'device':
      return `device:${caller.deviceId}`;
    case 'agent':
      return `agent:${caller.sessionId}`;
  }
}

/**
 * A caller arriving over the control socket is untrusted input, so it is parsed
 * like any other argument. Note what is NOT here: `user`. A socket client cannot
 * claim to be the human at the keyboard — that kind is minted in-process only,
 * which is the difference between an attributed caller and a self-declared one.
 */
export const externalCallerSchema: Schema<Exclude<Caller, { kind: 'user' }>> = s.union(
  s.object({ kind: s.literal('extension'), id: s.string() }),
  s.object({ kind: s.literal('device'), deviceId: s.string() }),
  s.object({ kind: s.literal('agent'), sessionId: s.string() }),
) as Schema<Exclude<Caller, { kind: 'user' }>>;
