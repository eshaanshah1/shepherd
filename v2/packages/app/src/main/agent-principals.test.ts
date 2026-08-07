import { describe, expect, it } from 'vitest';
import { sessionId } from '@shepherd/sdk';
import { AGENT_PERMISSIONS, agentPrincipals } from './agent-principals.ts';

/**
 * D9b. Before this, `grants.agents` was never populated by anything, and
 * `authorize` denies a caller absent from grants — *"is unknown (not registered
 * as a live principal)"* — even for a command carrying no permission. So every
 * `caller.kind === 'agent'` invocation of every command was denied, and §5.3's
 * "`tasks.spawn`, callable by an agent" had no principal to authorize.
 */

const ids = (...names: string[]) => names.map((name) => sessionId(name));

describe('agentPrincipals', () => {
  it('registers every live session as a principal', () => {
    const grants = agentPrincipals(ids('s1', 's2'));
    expect([...grants.keys()]).toEqual(ids('s1', 's2'));
  });

  it('grants NO permissions — membership, not privilege', () => {
    // The `agent` caller kind exists for SCOPING (core-design §4.3), not for
    // rights. Least privilege here means an agent reaches commands that carry no
    // permission — the task verbs, scoped to its own task inside their handler —
    // and is denied every permission-gated one until somebody decides otherwise
    // deliberately.
    expect(agentPrincipals(ids('s1')).get(sessionId('s1'))).toEqual([]);
    expect(AGENT_PERMISSIONS).toEqual([]);
  });

  it('is empty when nothing is running', () => {
    expect(agentPrincipals([]).size).toBe(0);
  });

  it('forgets a session that has exited, with no revoke path to remember', () => {
    // The point of deriving from the live inventory rather than keeping a second
    // registry: there is no "unregister" anybody can forget to call, and no way
    // for the two to drift. A dead session is absent because it is absent.
    const before = agentPrincipals(ids('s1', 's2'));
    const after = agentPrincipals(ids('s1'));
    expect(before.has(sessionId('s2'))).toBe(true);
    expect(after.has(sessionId('s2'))).toBe(false);
  });
});
