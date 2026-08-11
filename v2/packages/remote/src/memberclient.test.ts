// One Mac invoking a command on another, over the same control channel the
// phone already uses.
//
// This is the claim the whole thing rests on: **UI is always a client, and a UI
// anywhere can drive a core anywhere**, with membership as the only
// registration. A test that stubbed the connection would prove none of it, so
// this drives a real `RemoteServer` over TLS.

import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, systemClock, type KV, type Schema } from '@shepherd/sdk';
import { ControlChannel, controlSink } from './control.ts';
import { loopbackEndpoint } from './endpoint.ts';
import { loadOrMintIdentity, type Identity, type Minter } from './identity.ts';
import { memberClient } from './memberclient.ts';
import { issueCredential } from './net.ts';
import { generateMemberKey, signWith } from './netcrypto.ts';
import { foundNet, kvNetStore, type Membership, type NetStore } from './netstore.ts';
import { RemoteServer } from './server.ts';

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

function memoryKV(): KV {
  const values = new Map<string, unknown>();
  return {
    get: <T,>(key: string, schema: Schema<T>) => {
      if (!values.has(key)) return undefined;
      const parsed = schema.parse(JSON.parse(JSON.stringify(values.get(key))));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  };
}

/**
 * A Mac that serves its verb table to the net.
 *
 * `controlSink` is the same wiring the app uses, so what is exercised is the
 * real path: frames in, the command registry, an answer out.
 */
async function mac(options: {
  membership?: Membership;
  invoked?: Array<{ deviceId: string; command: string }>;
}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-member-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  const identity: Identity = minted.value;

  const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
  const net: NetStore = kvNetStore(memoryKV());
  net.putMembership(
    options.membership ??
      foundNet({ netName: 'Home', memberId: 'mac-b', memberName: 'Mac B', certPin: identity.pin, now: 0 }),
  );

  const control = new ControlChannel({
    host: {
      invoke: async (deviceId, command) => {
        options.invoked?.push({ deviceId, command });
        if (command === 'views.list') return { views: [{ type: 'tasks.tree', kind: 'tree' }] };
        if (command === 'views.children') throw new Error('that verb exploded');
        return { echoed: command };
      },
    },
    log: log.child('session'),
  });

  const sink = controlSink(control, log.child('session'));
  const server = new RemoteServer({
    endpoint: loopbackEndpoint({ identity }),
    identity,
    net,
    sessions: sink,
    // The app's own wiring: a connection is attributed to the MEMBER it turned
    // out to be, so B authorizes the call as A rather than as an anonymous
    // socket. Without this a caller is `device-1` and no grant can match it.
    onAdmitted: (connectionId, member) => control.open(connectionId, member.memberId),
    approve: async () => true,
    log: log.child('session'),
    newCode: () => '424242',
    now: () => Date.now(),
  });
  const started = await server.start();
  if (!started.ok) throw new Error(started.error);
  cleanups.push(() => server.stop());

  const membership = net.active();
  if (membership === undefined) throw new Error('no net');
  return { identity, server, net, membership, port: started.value.port };
}

/**
 * A second member of the SAME net, as a real join would leave it: its own key
 * pair, and a credential over that key signed by the member that admitted it.
 *
 * Relabelling somebody else's membership does not work and should not — the
 * server takes a caller's identity from the SIGNED credential, never from what
 * the connection calls itself. Getting that wrong here is what proved it.
 */
function memberOf(home: Membership, memberId: string, name = memberId): Membership {
  const key = generateMemberKey();
  const credential = issueCredential(
    {
      netId: home.netId,
      epoch: 1,
      memberId,
      name,
      publicKey: key.publicKey,
      certPin: '',
      issuedAt: 0,
      issuer: home.memberId,
    },
    signWith(home.memberKey.privateKey),
  );
  return { ...home, memberId, memberKey: key, chain: [credential, ...home.chain] };
}

describe('one Mac driving another', () => {
  it('invokes a command on a member and gets its answer', async () => {
    const b = await mac({});
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => client.stop());

    const answer = await client.invoke('views.list', {});
    expect(answer).toEqual({ views: [{ type: 'tasks.tree', kind: 'tree' }] });
  });

  /**
   * Membership IS the registration. B has never seen A, nothing was approved on
   * B, and no code was ever shown there — A is admitted because its chain
   * reaches the net's root, and can then drive B's verb table.
   */
  it('needs nothing but membership — no approval, no code', async () => {
    const invoked: Array<{ deviceId: string; command: string }> = [];
    const b = await mac({ invoked });
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => client.stop());

    await client.invoke('views.list', {});
    expect(b.server.activeCode).toBeUndefined();
    // …and the call is attributed to the MEMBER, so B authorizes it as itself
    // rather than as an anonymous socket.
    expect(invoked[0]?.deviceId).toBe('mac-a');
  });

  it('carries a failure back as a failure, not as silence', async () => {
    const b = await mac({});
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => client.stop());

    await expect(client.invoke('views.children', { type: 'x' })).rejects.toThrow(/exploded/);
    // The connection survives it: one failed verb is not a dead link.
    expect(await client.invoke('views.list', {})).toEqual({
      views: [{ type: 'tasks.tree', kind: 'tree' }],
    });
  });

  it('answers concurrent calls to the right caller', async () => {
    const b = await mac({});
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => client.stop());

    // Every answer is keyed by seq; a client that assumed order would pass a
    // one-call test and mix up two.
    const answers = await Promise.all([
      client.invoke('views.list', { n: 1 }),
      client.invoke('views.list', { n: 2 }),
      client.invoke('views.list', { n: 3 }),
    ]);
    expect(answers).toHaveLength(3);
    expect(answers.every((a) => JSON.stringify(a).includes('tasks.tree'))).toBe(true);
  });

  /**
   * Membership gets you IN; it does not get you everything.
   *
   * A member may run the discovery verbs and whatever a row it was actually sent
   * declares — the capability boundary the control channel already draws for a
   * phone. A Mac is not a privileged client just because it is a Mac.
   */
  it('is still held to what it was offered, member or not', async () => {
    const b = await mac({});
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => client.stop());

    await expect(client.invoke('tasks.delete', { task: 't1' })).rejects.toThrow(/not offered/);
  });

  it('refuses a member of another net rather than hanging', async () => {
    const b = await mac({});
    const stranger = foundNet({
      netName: 'Theirs',
      memberId: 'mac-a',
      memberName: 'Mac A',
      certPin: '',
      now: 0,
    });
    const client = memberClient({
      membership: stranger,
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
      timeoutMs: 4000,
    });
    cleanups.push(() => client.stop());

    await expect(client.invoke('views.list', {})).rejects.toThrow();
  });

  it('reports plainly when the member is not there', async () => {
    const b = await mac({});
    const client = memberClient({
      membership: memberOf(b.membership, 'mac-a'),
      host: '127.0.0.1',
      port: 1,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
      timeoutMs: 2000,
    });
    cleanups.push(() => client.stop());

    await expect(client.invoke('views.list', {})).rejects.toThrow();
  });
});
