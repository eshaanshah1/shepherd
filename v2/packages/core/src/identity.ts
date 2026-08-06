import { paneId, sessionId, type PaneID, type SessionID } from '@shepherd/sdk';

/**
 * Id minting for the two things the kernel keys registries by.
 *
 * The generator is a parameter, not a module-level import, for the same reason
 * `Clock` is injected: a test that needs to know what id it is about should not
 * have to guess one. Callers pass nothing.
 */
export type RandomId = () => string;

const defaultRandomId: RandomId = () => globalThis.crypto.randomUUID();

export function newSessionId(random: RandomId = defaultRandomId): SessionID {
  return sessionId(random());
}

export function newPaneId(random: RandomId = defaultRandomId): PaneID {
  return paneId(random());
}
