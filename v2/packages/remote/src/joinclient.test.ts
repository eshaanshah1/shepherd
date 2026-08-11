// A Mac joining somebody else's net, over a real socket against the real server.
//
// This is the half that did not exist: the Mac could HOST a join and could not BE
// the joiner, so "any device pairs with any device" was true for a phone and not
// for a second Mac. The phone's client proves the protocol works; it does not
// prove this code does.

import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionHost, SessionServer } from '@shepherd/core';
import { createLogger, systemClock } from '@shepherd/sdk';
import { loopbackEndpoint } from './endpoint.ts';
import { loadOrMintIdentity, type Identity, type Minter } from './identity.ts';
import { joinNet } from './joinclient.ts';
import { verifyChain } from './net.ts';
import { verifySignature } from './netcrypto.ts';
import { foundNet, kvNetStore, type NetStore } from './netstore.ts';
import { encodeJoinURI } from './payload.ts';
import { RemoteServer } from './server.ts';
import type { KV, Schema } from '@shepherd/sdk';

const run = promisify(execFile);
const openssl: Minter = async (args) => {
  try {
    await run('/usr/bin/openssl', [...args]);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function memoryNet(certPin: string): NetStore {
  const values = new Map<string, unknown>();
  const kv: KV = {
    get: <T,>(key: string, schema: Schema<T>) => {
      if (!values.has(key)) return undefined;
      const parsed = schema.parse(JSON.parse(JSON.stringify(values.get(key))));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  };
  const store = kvNetStore(kv);
  store.putMembership(
    foundNet({ netName: 'Home', memberId: 'mac-mini', memberName: 'Mac mini', certPin, now: 0 }),
  );
  return store;
}

/** The founding Mac, serving its net for real. */
async function founder(options: { approve?: boolean } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-join-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  const identity: Identity = minted.value;

  const host = new SessionHost();
  const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
  const sessions = new SessionServer({ host, log });
  const net = memoryNet(identity.pin);

  const server = new RemoteServer({
    endpoint: loopbackEndpoint({ identity }),
    identity,
    net,
    sessions,
    approve: async () => options.approve ?? true,
    log: log.child('session'),
    newCode: () => '424242',
    now: () => Date.now(),
  });
  const started = await server.start();
  if (!started.ok) throw new Error(started.error);
  cleanups.push(() => {
    server.stop();
    sessions.dispose();
    host.dispose();
  });

  const membership = net.active();
  if (membership === undefined) throw new Error('the founder is in no net');
  const code = server.showCode();
  return {
    server,
    net,
    identity,
    membership,
    port: started.value.port,
    uri: encodeJoinURI({
      host: '127.0.0.1',
      port: started.value.port,
      pin: identity.pin,
      code,
      netId: membership.netId,
      netName: membership.netName,
      rootPublicKey: membership.rootPublicKey,
      protocolVersion: 4,
    }),
  };
}

describe('joining another Mac’s net', () => {
  it('comes back with a membership that checks out against the net root', async () => {
    const home = await founder();

    const joined = await joinNet({
      uri: home.uri,
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: 'the-macbooks-own-cert',
      now: () => Date.now(),
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.value.netId).toBe(home.membership.netId);
    expect(joined.value.netName).toBe('Home');
    expect(
      verifyChain({
        chain: joined.value.chain,
        netId: joined.value.netId,
        rootPublicKey: joined.value.rootPublicKey,
        tombstoned: new Set(),
        verify: verifySignature,
      }).ok,
    ).toBe(true);

    // The membership describes the key this Mac actually holds, or it could
    // never be proven to anybody.
    expect(joined.value.chain[0]?.publicKey).toBe(joined.value.memberKey.publicKey);
    // …and it carries the certificate pin it will serve on, so the OTHER Macs
    // can bind this member's credential to the certificate it presents.
    expect(joined.value.chain[0]?.certPin).toBe('the-macbooks-own-cert');

    // Nobody holds a root private key — not even the founder, which destroyed
    // it the instant it signed its own credential. A joiner certainly does not.
    expect(JSON.stringify(joined.value)).not.toContain('rootPrivateKey');
    expect(JSON.stringify(home.membership)).not.toContain('rootPrivateKey');

    // The founder now knows it as a member.
    expect(home.net.roster(home.membership.netId).map((e) => e.memberId)).toContain('macbook');
  });

  /**
   * The payoff, end to end: a member admitted by ONE Mac is admitted by a
   * SECOND that never saw it, with no code and nobody asked.
   */
  it('lets the new member into a third Mac that never saw it', async () => {
    const home = await founder();
    const joined = await joinNet({
      uri: home.uri,
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
    });
    if (!joined.ok) throw new Error(joined.error);

    // A third Mac holding the same net — as it would after joining.
    const third = await founder();
    third.net.putMembership({ ...home.membership, memberId: 'mac-studio' });
    third.net.setActiveNet(home.membership.netId);

    const back = await joinNet({
      uri: encodeJoinURI({
        host: '127.0.0.1',
        port: third.port,
        pin: third.identity.pin,
        netId: home.membership.netId,
        netName: home.membership.netName,
        rootPublicKey: home.membership.rootPublicKey,
        protocolVersion: 4,
      }),
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
      membership: joined.value,
    });

    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // Same membership back — it was already a member, so nothing was reissued.
    expect(back.value.chain).toEqual(joined.value.chain);
  });

  it('reports a refusal rather than hanging when the code is wrong', async () => {
    const home = await founder();
    const joined = await joinNet({
      uri: home.uri.replace('code=424242', 'code=000000'),
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
    });
    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.error).toContain('code');
  });

  it('reports a refusal when the human at the other Mac says no', async () => {
    const home = await founder({ approve: false });
    const joined = await joinNet({
      uri: home.uri,
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
    });
    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.error).toContain('declined');
  });

  /**
   * A link is a fact about a net, not a certificate of good character. If the
   * Mac that answers cannot prove it belongs to the net named in the link, the
   * join is refused — this is the direction the old model had no answer for.
   */
  it('refuses a Mac that cannot prove it belongs to the net in the link', async () => {
    const home = await founder();
    const stranger = await founder();
    const joined = await joinNet({
      // The address and pin of a DIFFERENT Mac, under the home net's identity.
      uri: encodeJoinURI({
        host: '127.0.0.1',
        port: stranger.port,
        pin: stranger.identity.pin,
        code: '424242',
        netId: home.membership.netId,
        netName: home.membership.netName,
        rootPublicKey: home.membership.rootPublicKey,
        protocolVersion: 4,
      }),
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
    });
    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.error).toMatch(/net|prove/);
  });

  it('says so plainly when nothing is listening', async () => {
    const joined = await joinNet({
      uri: encodeJoinURI({
        host: '127.0.0.1',
        port: 1,
        pin: 'ab'.repeat(32),
        netId: 'cd'.repeat(32),
        netName: 'Nowhere',
        rootPublicKey: 'ef'.repeat(44),
        protocolVersion: 4,
      }),
      deviceId: 'macbook',
      deviceName: 'MacBook',
      certPin: '',
      now: () => Date.now(),
      timeoutMs: 1500,
    });
    expect(joined.ok).toBe(false);
  });
});
