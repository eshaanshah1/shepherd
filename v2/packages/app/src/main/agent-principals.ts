import type { Permission, SessionID } from '@shepherd/sdk';

/**
 * Who counts as a live agent caller — D9b.
 *
 * `authorize` denies any caller absent from `grants`, including for a command
 * that declares no permission ("membership still required"). Nothing ever
 * populated `grants.agents`, so before this every `caller.kind === 'agent'`
 * invocation of every command was denied, and §5.3's `tasks.spawn` "callable
 * with `caller.kind === 'agent'`" had no principal to authorize. That is a
 * kernel gap, not a `tasks` detail, which is why it lands in P1.
 *
 * **A live agent principal IS a live session.** Derived from the pty host's own
 * inventory rather than kept in a second registry: there is no mint/revoke pair
 * for anybody to forget half of, and no way for the two to disagree. A session
 * that exited is absent because it is absent. `CommandRegistry` reads `grants`
 * per invocation, deliberately, so this is re-derived at the moment it is used.
 *
 * **The claim itself is trusted the way the local CLI's is.** A caller on the
 * control socket says which session it is; nothing verifies that, and reaching
 * the socket is the trust boundary (`ingress.ts`). Recorded as the model rather
 * than built around — verification would be a different milestone's decision.
 */

/**
 * What an agent principal holds: nothing.
 *
 * The `agent` caller kind exists so a task's orchestrator can be **scoped to its
 * own task** (core-design §4.3), not so it can do more. Membership alone reaches
 * every command that declares no permission — which is where the task verbs live,
 * with the task-membership predicate in their own handler, since the kernel
 * cannot know which session belongs to which task.
 *
 * The alternative on offer was the local CLI's grant, which is **every**
 * permission (`ingress.ts`'s `LOCAL_DEVICE_PERMISSIONS = PERMISSIONS`). Handing
 * that to an agent would make the scoping decorative: it could reach layout,
 * attention and sessions directly and never go through a scoped verb at all.
 */
export const AGENT_PERMISSIONS: readonly Permission[] = [];

export function agentPrincipals(
  liveSessions: readonly SessionID[],
): ReadonlyMap<SessionID, readonly Permission[]> {
  return new Map(liveSessions.map((id) => [id, AGENT_PERMISSIONS]));
}
