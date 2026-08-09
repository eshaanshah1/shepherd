import { err, ok, type Result } from '@shepherd/sdk';
import type { Endpoint } from './endpoint.ts';
import { loopbackEndpoint, wifiEndpoint } from './endpoint.ts';
import type { Identity } from './identity.ts';

/**
 * Which transports this build can serve over, by NAME.
 *
 * The alternative — a boolean, or an `if` per transport at each of the two call
 * sites — is what this replaces, and it was wrong for a reason worth stating:
 * `Endpoint` exists precisely so that a transport is a thing you add rather than
 * a branch you extend. A registry keeps that promise. Adding `remote-tailscale`
 * is `register('tailscale', …)`; it touches neither the app nor the daemon.
 *
 * **Why this is not an extension point yet.** Extensions run out of process
 * (ADR 0033), and a transport has to hand the session server a live TLS socket —
 * which cannot cross that boundary without proxying every byte of every pty
 * through the extension host. So a transport is registered in-process for now,
 * and ADR 0031's rule applies: the extension point waits for a consumer that
 * cannot be served this way. The name-keyed shape is chosen so that when one
 * arrives, what changes is WHO calls `register`, not what a caller passes.
 */

export type EndpointFactory = (options: { identity: Identity; port?: number }) => Endpoint;

const transports = new Map<string, EndpointFactory>([
  /**
   * The default, and it stays the default.
   *
   * A loopback listener needs nobody's permission and reaches a phone over USB
   * (`adb reverse`). Everything else puts a listener on a network shared with
   * other people's machines, which must be a decision rather than a default.
   */
  ['loopback', (options) => loopbackEndpoint(options)],
  ['wifi', (options) => wifiEndpoint(options)],
]);

export function registerTransport(name: string, factory: EndpointFactory): void {
  transports.set(name, factory);
}

export function transportNames(): string[] {
  return [...transports.keys()];
}

/**
 * Resolve a name to a factory.
 *
 * An unknown name is a REFUSAL, not a silent fall back to loopback: somebody
 * asked to be reachable a particular way, and quietly serving a different way
 * means believing you are on the network when you are not.
 */
export function resolveTransport(name: string): Result<EndpointFactory, string> {
  const factory = transports.get(name);
  if (factory === undefined) {
    return err(`no remote transport named '${name}' — this build has ${transportNames().join(', ')}`);
  }
  return ok(factory);
}
