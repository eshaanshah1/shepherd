// One Mac attaching to another Mac's pty.
//
// The control channel proved a UI can be a client of a core anywhere; this is the
// other half — the DATA path — and the claim is that it needed no session code at
// all. Everything after the handshake here is R1's protocol, byte for byte, spoken
// to the same `SessionServer` the local renderer talks to. If this file had had to
// invent a frame, the "the phone is just another client for the same pty" design
// would be false.

import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  SessionHost,
  SessionServer,
  encodeByteFrame,
  encodeJsonFrame,
  type Frame,
} from '@shepherd/core';
import { createLogger, systemClock, type KV, type Schema } from '@shepherd/sdk';
import { loopbackEndpoint } from './endpoint.ts';
import { loadOrMintIdentity, type Identity, type Minter } from './identity.ts';
import { splitFrame } from './memberhandshake.ts';
import { memberSessionSocket, type MemberSocket } from './membersession.ts';
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

/** Mac B: a real `SessionHost` behind a real membership gate, over real TLS. */
async function macB() {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-membersession-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  const identity: Identity = minted.value;

  const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
  const host = new SessionHost();
  const sessions = new SessionServer({ host, log });
  const net: NetStore = kvNetStore(memoryKV());
  net.putMembership(
    foundNet({ netName: 'Home', memberId: 'mac-b', memberName: 'Mac B', certPin: identity.pin, now: 0 }),
  );

  const server = new RemoteServer({
    endpoint: loopbackEndpoint({ identity }),
    identity,
    net,
    sessions,
    approve: async () => false,
    log: log.child('session'),
    newCode: () => '',
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
  if (membership === undefined) throw new Error('no net');
  return { identity, host, sessions, membership, port: started.value.port };
}

/**
 * A second member of the same net, as a real join leaves it: its own key pair and
 * a credential over that key. Relabelling somebody else's membership does not
 * work and should not — identity comes from the signed credential, never from
 * what a connection calls itself.
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

/** Read frames off an admitted socket — this is the session protocol and nothing else. */
function reader(socket: MemberSocket) {
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  socket.onData((bytes) => void frames.push(...decoder.feed(bytes).frames));
  socket.onError(() => undefined);
  socket.onClose(() => undefined);
  return {
    frames,
    of: (kind: number) => frames.filter((frame) => frame.kind === kind),
    answer: (seq: number) => frames.find((f) => (f.json as { seq?: number } | undefined)?.seq === seq),
    output: () =>
      frames
        .filter((frame) => frame.kind === RESPONSE.data)
        .map((frame) => new TextDecoder().decode(frame.bytes))
        .join(''),
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('a member’s session socket', () => {
  it('is admitted by its membership and then speaks the session protocol', async () => {
    const b = await macB();
    const socket = await memberSessionSocket({
      membership: memberOf(b.membership, 'mac-a', 'Mac A'),
      host: '127.0.0.1',
      port: b.port,
      deviceId: 'mac-a',
      deviceName: 'Mac A',
      now: () => Date.now(),
    });
    cleanups.push(() => socket.destroy());
    const a = reader(socket);

    socket.write(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    socket.write(
      encodeJsonFrame(REQUEST.create, {
        seq: 2,
        spec: { cwd: '/tmp', command: '/bin/sh', args: [] },
      }),
    );
    await waitFor(() => a.answer(2) !== undefined, 'the session');
    const id = (a.answer(2)?.json as { value: { id: string } }).value.id;

    socket.write(encodeJsonFrame(REQUEST.attach, { seq: 3, sessionId: id }));
    socket.write(encodeByteFrame(REQUEST.write, id, new TextEncoder().encode('echo mac-a-was-here\n')));
    await waitFor(() => a.output().includes('mac-a-was-here'), 'the pty’s output');

    // The pty is B's, and it is the one B's own renderer would be handed.
    expect(b.host.list().map((info) => info.id)).toContain(id);
  });

  it('reports the member’s own reason when it refuses', async () => {
    const b = await macB();
    const stranger = foundNet({
      netName: 'Another net',
      memberId: 'mac-c',
      memberName: 'Mac C',
      certPin: '',
      now: 0,
    });
    await expect(
      memberSessionSocket({
        membership: stranger,
        host: '127.0.0.1',
        port: b.port,
        deviceId: 'mac-c',
        deviceName: 'Mac C',
        now: () => Date.now(),
        handshakeMs: 4000,
      }),
    ).rejects.toThrow();
    // Refused at the door: nothing reached a pty.
    expect(b.host.list()).toHaveLength(0);
  });

  it('does not wedge on a member that accepts a connection and says nothing', async () => {
    // A machine that is asleep, or awake on another network with a stale roster
    // address, is exactly this: a TCP connection that goes nowhere.
    const { createServer } = await import('node:net');
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    cleanups.push(() => silent.close());

    const b = await macB();
    await expect(
      memberSessionSocket({
        membership: memberOf(b.membership, 'mac-a'),
        host: '127.0.0.1',
        port,
        deviceId: 'mac-a',
        deviceName: 'Mac A',
        now: () => Date.now(),
        handshakeMs: 250,
      }),
    ).rejects.toThrow(/did not answer|could not reach|closed/);
  });
});

/**
 * The handover, and the reason it is a function rather than a `FrameDecoder`.
 *
 * `accepted` and the first session frame can arrive in one TCP segment. A decoder
 * fed that chunk keeps the leftovers inside itself, so the session frame would be
 * stranded in a reader that is about to be replaced — a lost snapshot or a lost
 * keystroke, visible only under the timing that packs two frames into one read.
 */
describe('splitFrame', () => {
  const first = encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION });
  const second = encodeByteFrame(RESPONSE.data, 'sess-1', new TextEncoder().encode('behind it'));

  it('returns one frame and the bytes behind it', () => {
    const both = new Uint8Array(first.length + second.length);
    both.set(first, 0);
    both.set(second, first.length);

    const split = splitFrame(both);
    if (split.kind !== 'frame') throw new Error(`expected a frame, got ${split.kind}`);
    expect(split.frame.kind).toBe(REQUEST.hello);
    expect([...split.rest]).toEqual([...second]);

    // And the remainder is itself a whole frame, unharmed by the split.
    const next = splitFrame(split.rest);
    if (next.kind !== 'frame') throw new Error(`expected a second frame, got ${next.kind}`);
    expect(new TextDecoder().decode(next.frame.bytes)).toBe('behind it');
    expect(next.rest).toHaveLength(0);
  });

  it('says incomplete at every boundary inside a frame, and never guesses', () => {
    for (let cut = 0; cut < first.length; cut += 1) {
      expect(splitFrame(first.subarray(0, cut)).kind).toBe('incomplete');
    }
    expect(splitFrame(first).kind).toBe('frame');
  });

  it('reports an unusable frame rather than throwing', () => {
    // A length claiming more than the cap: refused before anything is allocated.
    const bogus = new Uint8Array(9);
    new DataView(bogus.buffer).setUint32(0, 0xffffffff, true);
    expect(splitFrame(bogus).kind).toBe('error');
  });
});
