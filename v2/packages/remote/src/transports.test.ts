import { describe, expect, it } from 'vitest';
import { localAddress } from './endpoint.ts';
import { registerTransport, resolveTransport, transportNames } from './transports.ts';

describe('the transport registry', () => {
  it('ships loopback and wifi, and loopback is what a caller gets by default', () => {
    expect(transportNames()).toContain('loopback');
    expect(transportNames()).toContain('wifi');
  });

  /**
   * The point of the registry: a transport is REGISTERED, not branched on. This
   * replaced a boolean that each of the two call sites had to know about, which
   * put the `if` one layer up from the interface built to remove it.
   */
  it('takes a transport it has never heard of', () => {
    const marker = {} as never;
    registerTransport('tailscale-for-this-test', () => marker);
    const resolved = resolveTransport('tailscale-for-this-test');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value({ identity: {} as never })).toBe(marker);
  });

  /**
   * Refuses rather than falling back to loopback. Somebody asked to be reachable
   * a particular way; serving a different way means believing you are on the
   * network when you are not — and the app and the daemon must agree, or a phone
   * gets a task list it can reach and a terminal it cannot.
   */
  it('refuses a name it does not know, and says what it does know', () => {
    const resolved = resolveTransport('carrier-pigeon');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('loopback');
  });
});

describe('localAddress', () => {
  it('prefers a physical interface over a bridge, and skips what a phone cannot reach', () => {
    const address = localAddress({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      // Docker and VPN bridges are up on plenty of machines and answer to
      // nobody's phone.
      bridge100: [{ address: '10.9.9.1', family: 'IPv4', internal: false } as never],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as never],
    });
    expect(address).toBe('192.168.1.42');
  });

  it('ignores a link-local address, which dials nothing', () => {
    expect(
      localAddress({
        en0: [{ address: '169.254.10.1', family: 'IPv4', internal: false } as never],
      }),
    ).toBeUndefined();
  });
});
