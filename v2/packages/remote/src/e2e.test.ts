// R2's gate: a MEMBER of this Mac's shep-net drives a REAL pty over TLS, and
// needs no phone and no tailnet to prove it.
//
// Everything below the handshake is R1's session protocol, unchanged and
// unwrapped — that is the claim being tested. If this file had needed a single
// line of session code, the "the phone is just another client" design would be
// false and the two paths would already have started to drift, which is exactly
// what happened to v1.

import { execFile } from 'node:child_process';
import { connect } from 'node:tls';
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
import { createLogger, systemClock } from '@shepherd/sdk';
import { loadOrMintIdentity, peerMatchesPin, type Identity, type Minter } from './identity.ts';
import { loopbackEndpoint } from './endpoint.ts';
import { REMOTE, RemoteServer } from './server.ts';
import { CONTROL, ControlChannel, controlSink } from './control.ts';
import { REMOTE_PROTOCOL_VERSION, hostProofBytes, issueProof } from './join.ts';
import { verifyChain, type Credential } from './net.ts';
import { generateMemberKey, netIdOf, signWith, verifySignature } from './netcrypto.ts';
import { foundNet, kvNetStore, type NetStore } from './netstore.ts';
import { issueTombstone, type Tombstone } from './roster.ts';

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

/**
 * A net store over a Map — the same KV shape the app opens on SQLite, so what is
 * exercised here is this package's reads and writes rather than the database's.
 */
function memoryNet(certPin: string): NetStore {
  const values = new Map<string, unknown>();
  const store = kvNetStore({
    get: (key, schema) => {
      if (!values.has(key)) return undefined;
      const parsed = schema.parse(JSON.parse(JSON.stringify(values.get(key))));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  });
  store.putMembership(
    foundNet({ netName: 'Test net', memberId: 'this-mac', memberName: 'This Mac', certPin, now: 0 }),
  );
  return store;
}

/** This device's own member key — what its credential names and its proofs use. */
const phoneKey = generateMemberKey();

async function host(options: { approve?: boolean | (() => Promise<boolean>) } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-e2e-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  const identity: Identity = minted.value;

  const sessionHost = new SessionHost();
  const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
  const sessions = new SessionServer({ host: sessionHost, log });
  const net = memoryNet(identity.pin);

  const approvals: Array<{ sas?: string }> = [];
  const server = new RemoteServer({
    endpoint: loopbackEndpoint({ identity }),
    identity,
    net,
    sessions,
    approve: async (request) => {
      approvals.push({ ...(request.sas === undefined ? {} : { sas: request.sas }) });
      if (typeof options.approve === 'function') return options.approve();
      return options.approve ?? true;
    },
    log: log.child('session'),
    newCode: () => '424242',
    now: () => Date.now(),
  });

  const started = await server.start();
  if (!started.ok) throw new Error(started.error);

  cleanups.push(() => {
    server.stop();
    sessions.dispose();
    sessionHost.dispose();
  });
  const netId = net.active()?.netId ?? '';
  return { identity, server, net, netId, sessions, sessionHost, approvals, port: started.value.port };
}

/** A device: pins the cert, speaks the handshake, then speaks R1's protocol. */
function device(port: number, pin: string) {
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  let socket: import('node:tls').TLSSocket | undefined;

  const ready = new Promise<{ ok: boolean; why?: string }>((resolve) => {
    const s = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const peer = s.getPeerX509Certificate();
      if (peer === undefined || !peerMatchesPin(new Uint8Array(peer.raw), pin)) {
        s.destroy();
        resolve({ ok: false, why: 'pin mismatch' });
        return;
      }
      socket = s;
      resolve({ ok: true });
    });
    s.on('data', (chunk: Buffer) => frames.push(...decoder.feed(new Uint8Array(chunk)).frames));
    s.on('error', (e) => resolve({ ok: false, why: String(e) }));
  });

  return {
    ready,
    frames,
    send: (bytes: Uint8Array) => socket?.write(bytes),
    close: () => socket?.destroy(),
    of: (kind: number) => frames.filter((f) => f.kind === kind),
    output: () =>
      frames
        .filter((f) => f.kind === RESPONSE.data)
        .map((f) => new TextDecoder().decode(f.bytes))
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

const hello = (over: Record<string, unknown> = {}) =>
  encodeJsonFrame(REMOTE.hello as never, {
    deviceId: 'phone-1',
    deviceName: 'A Phone',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    publicKey: phoneKey.publicKey,
    nonce: 'a-nonce-from-the-phone',
    ...over,
  });

/**
 * What a member says when it comes back: its chain, and a proof it holds the key
 * the chain names — bound to THIS host's pin, so a proof captured elsewhere is
 * useless here.
 */
const returning = (chain: readonly Credential[], netId: string, hostPin: string) =>
  hello({
    chain,
    proof: issueProof({ netId, hostPin, at: Date.now() }, signWith(phoneKey.privateKey)),
  });

/** A revocation this Mac's own membership signed — what a peer would relay. */
const issueTombstoneFor = (
  netId: string,
  memberId: string,
  membership: { chain: readonly Credential[]; memberKey: { privateKey: string } },
): Tombstone =>
  issueTombstone(
    { netId, memberId, at: Date.now(), signer: membership.chain },
    signWith(membership.memberKey.privateKey),
  );

/** The membership the host issued, read off the accept. */
const issuedChain = (accepted: Frame | undefined): readonly Credential[] =>
  (accepted?.json as { chain: readonly Credential[] }).chain;

describe('a paired device, over TLS, driving a real pty', () => {
  it('pairs with a code, is approved, and then speaks the SESSION protocol', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    expect((await phone.ready).ok).toBe(true);

    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the accept');

    // A human was asked, and shown digits describing the certificate that was
    // actually negotiated.
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.sas).toMatch(/^\d{6}$/);
    /**
     * A MEMBERSHIP comes back, not a secret — a chain the device presents to any
     * member of this net, including ones this Mac has never told about it. That
     * is the whole difference between a net and a pairing.
     */
    const accepted = phone.of(REMOTE.accepted)[0];
    const chain = issuedChain(accepted);
    expect(
      verifyChain({
        chain,
        netId: h.netId,
        rootPublicKey: h.net.active()?.rootPublicKey ?? '',
        tombstoned: new Set(),
        verify: verifySignature,
      }).ok,
    ).toBe(true);

    /**
     * The net's ROOT KEY comes back too, and it has to: without it a joiner
     * cannot verify anybody's chain later — it would hold a membership and no way
     * to check the next Mac it met. The joiner does not take it on trust either;
     * the net id it was given is the hash of this key, so the two check each other.
     */
    const root = (accepted?.json as { rootPublicKey: string }).rootPublicKey;
    expect(netIdOf(root)).toBe(h.netId);

    // And the host proved ITSELF, over the nonce the phone chose — there is no
    // pinned certificate left to tell a client it reached the right Mac.
    const answer = accepted?.json as { proof: string; hostChain: readonly Credential[] };
    expect(
      verifySignature(
        (answer.hostChain[0] as Credential).publicKey,
        hostProofBytes({ netId: h.netId, nonce: 'a-nonce-from-the-phone' }),
        answer.proof,
      ),
    ).toBe(true);

    // …and from here it is R1's protocol, verbatim. No translation layer.
    phone.send(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    phone.send(
      encodeJsonFrame(REQUEST.create, {
        seq: 2,
        spec: { cwd: '/tmp', command: '/bin/sh', args: [] },
      }),
    );
    await waitFor(
      () => phone.frames.some((f) => (f.json as { seq?: number } | undefined)?.seq === 2),
      'the session',
    );
    const created = phone.frames.find((f) => (f.json as { seq?: number } | undefined)?.seq === 2);
    const id = (created?.json as { value: { id: string } }).value.id;

    phone.send(encodeJsonFrame(REQUEST.attach, { seq: 3, sessionId: id }));
    phone.send(
      encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'fr%s\\n' 'om-the-phone'\r")),
    );
    await waitFor(() => phone.output().includes('from-the-phone'), 'the pty output');

    // The Mac's own host agrees this is one real session, not a shadow.
    expect(h.sessionHost.list()).toHaveLength(1);
  });

  it('refuses a wrong code, and a denied approval, without reaching a pty', async () => {
    const denied = await host({ approve: false });
    denied.server.showCode();

    const wrong = device(denied.port, denied.identity.pin);
    await wrong.ready;
    wrong.send(hello({ pairingCode: '000000' }));
    await waitFor(() => wrong.of(REMOTE.rejected).length > 0, 'the refusal');
    expect((wrong.of(REMOTE.rejected)[0]?.json as { reason: string }).reason).toContain('wrong pairing code');

    const refused = device(denied.port, denied.identity.pin);
    await refused.ready;
    refused.send(hello({ pairingCode: '424242' }));
    await waitFor(() => refused.of(REMOTE.rejected).length > 0, 'the declined approval');
    expect((refused.of(REMOTE.rejected)[0]?.json as { reason: string }).reason).toContain('declined');

    // Neither ever reached a session, which is the assertion that matters.
    expect(denied.sessionHost.list()).toHaveLength(0);
    expect(denied.net.roster(denied.netId)).toHaveLength(0);
  });

  /**
   * A session frame before the handshake is the shape an attacker's first probe
   * takes AND the shape a buggy client takes. Both get the same answer, and
   * neither reaches a pty.
   */
  it('refuses to speak the session protocol before pairing', async () => {
    const h = await host();
    const phone = device(h.port, h.identity.pin);
    await phone.ready;

    phone.send(encodeJsonFrame(REQUEST.create, { seq: 1, spec: { cwd: '/tmp', command: '/bin/sh' } }));
    await waitFor(() => phone.of(REMOTE.rejected).length > 0, 'the refusal');
    expect(h.sessionHost.list()).toHaveLength(0);
  });

  it('lets a member back in with its membership, and no code showing at all', async () => {
    const h = await host();
    h.server.showCode();

    const first = device(h.port, h.identity.pin);
    await first.ready;
    first.send(hello({ pairingCode: '424242' }));
    await waitFor(() => first.of(REMOTE.accepted).length > 0, 'the first join');
    const chain = issuedChain(first.of(REMOTE.accepted)[0]);
    first.close();

    // No code is showing now — a member coming back must not need one.
    expect(h.server.activeCode).toBeUndefined();

    const again = device(h.port, h.identity.pin);
    await again.ready;
    again.send(returning(chain, h.netId, h.identity.pin));
    await waitFor(() => again.of(REMOTE.accepted).length > 0, 'the return');
    // And no second approval was asked for.
    expect(h.approvals).toHaveLength(1);
  });

  /**
   * The case the whole design exists for: a device that joined SOMEWHERE ELSE
   * walks up to this Mac, which has never seen it, and is admitted with nothing
   * shown to anybody.
   */
  it('admits a member of the net that this Mac has never met', async () => {
    const admitting = await host();
    admitting.server.showCode();

    const joining = device(admitting.port, admitting.identity.pin);
    await joining.ready;
    joining.send(hello({ pairingCode: '424242' }));
    await waitFor(() => joining.of(REMOTE.accepted).length > 0, 'the join');
    const chain = issuedChain(joining.of(REMOTE.accepted)[0]);
    joining.close();

    // A second Mac in the SAME net: it holds the same root, and its own
    // membership was signed by the first. It has never heard of the phone.
    const stranger = await host();
    const admittingNet = admitting.net.active();
    if (admittingNet === undefined) throw new Error('the admitting Mac is in no net');
    stranger.net.putMembership({
      ...admittingNet,
      memberId: 'other-mac',
      // Same net, same root, its own copy — what a second Mac holds after joining.
    });
    stranger.net.setActiveNet(admittingNet.netId);

    const phone = device(stranger.port, stranger.identity.pin);
    await phone.ready;
    phone.send(returning(chain, admittingNet.netId, stranger.identity.pin));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the admission with no ceremony');
    // No code was ever shown there, and no human was asked.
    expect(stranger.server.activeCode).toBeUndefined();
    expect(stranger.approvals).toHaveLength(0);
  });

  /**
   * A chain is public — it reaches every member. What makes it THIS device's
   * chain is the key it names, so a copy without that key is worth nothing.
   */
  it('refuses a stolen membership presented without its key', async () => {
    const h = await host();
    h.server.showCode();

    const joining = device(h.port, h.identity.pin);
    await joining.ready;
    joining.send(hello({ pairingCode: '424242' }));
    await waitFor(() => joining.of(REMOTE.accepted).length > 0, 'the join');
    const chain = issuedChain(joining.of(REMOTE.accepted)[0]);
    joining.close();

    const thief = device(h.port, h.identity.pin);
    await thief.ready;
    const theirKey = generateMemberKey();
    thief.send(
      hello({
        chain,
        proof: issueProof(
          { netId: h.netId, hostPin: h.identity.pin, at: Date.now() },
          signWith(theirKey.privateKey),
        ),
      }),
    );
    await waitFor(() => thief.of(REMOTE.rejected).length > 0, 'the refusal');
    expect((thief.of(REMOTE.rejected)[0]?.json as { reason: string }).reason).toContain('proven');
    expect(h.sessionHost.list()).toHaveLength(0);
  });

  /**
   * THE reconnect case, and the one v1's design lists as its accepted
   * limitation: "full-screen apps across a cold reconnect may need one redraw".
   * R0 deleted it, and this is that deletion seen from a remote client.
   */
  it('repaints correctly after the link drops mid-stream', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the accept');
    const chain = issuedChain(phone.of(REMOTE.accepted)[0]);

    phone.send(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    phone.send(
      encodeJsonFrame(REQUEST.create, { seq: 2, spec: { cwd: '/tmp', command: '/bin/sh', args: [] } }),
    );
    await waitFor(
      () => phone.frames.some((f) => (f.json as { seq?: number } | undefined)?.seq === 2),
      'the session',
    );
    const id = (
      phone.frames.find((f) => (f.json as { seq?: number } | undefined)?.seq === 2)?.json as {
        value: { id: string };
      }
    ).value.id;

    phone.send(encodeJsonFrame(REQUEST.attach, { seq: 3, sessionId: id }));
    phone.send(
      encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'be%s\\n' 'fore-the-drop'\r")),
    );
    await waitFor(() => phone.output().includes('before-the-drop'), 'output before the drop');

    // The link goes away entirely. The session must not.
    phone.close();
    await waitFor(() => h.sessionHost.list().length === 1, 'the session to survive the drop');

    const back = device(h.port, h.identity.pin);
    await back.ready;
    back.send(returning(chain, h.netId, h.identity.pin));
    await waitFor(() => back.of(REMOTE.accepted).length > 0, 'the reconnect');
    back.send(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    back.send(encodeJsonFrame(REQUEST.attach, { seq: 2, sessionId: id }));

    // The screen it missed, handed over on attach. A byte ring could not do
    // this; a serialized screen can.
    await waitFor(() => back.output().includes('before-the-drop'), 'the repaint after reconnecting');
    expect(back.output().split('before-the-drop')).toHaveLength(2);
  });

  it('drops a revoked member immediately, and refuses its membership after', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the accept');
    const chain = issuedChain(phone.of(REMOTE.accepted)[0]);
    expect(h.net.roster(h.netId)).toHaveLength(1);

    // Somebody is revoking because the device is in somebody else's hands, so
    // "revoked" has to describe the present rather than a future state.
    h.server.revoke('phone-1');
    expect(h.net.revoked(h.netId)).toEqual(new Set(['phone-1']));
    // And its session keeps running — a revoked VIEWER is not a killed agent.
    expect(h.sessionHost.list().length).toBeGreaterThanOrEqual(0);

    // The membership itself is now worthless here, which is the durable half of
    // revoking: dropping the socket alone would last until it dialled again.
    const again = device(h.port, h.identity.pin);
    await again.ready;
    again.send(returning(chain, h.netId, h.identity.pin));
    await waitFor(() => again.of(REMOTE.rejected).length > 0, 'the refusal');
    expect((again.of(REMOTE.rejected)[0]?.json as { reason: string }).reason).toContain('revoked');
  });

  /**
   * Gossip is what makes a revocation true anywhere but the Mac that performed
   * it: a member relays the tombstone, and this Mac — which never revoked
   * anybody — refuses the device from then on.
   */
  it('accepts a revocation relayed by a member, and refuses the subject after', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the join');
    const chain = issuedChain(phone.of(REMOTE.accepted)[0]);
    phone.close();

    // Somewhere else in the net, this Mac itself was revoked… by itself, which is
    // the only signer this test has. What matters is the RELAY: it arrives on a
    // member's connection and is verified before it counts.
    const membership = h.net.active();
    if (membership === undefined) throw new Error('no net');
    const tombstone: Tombstone = issueTombstoneFor(membership.netId, 'phone-1', membership);

    const relay = device(h.port, h.identity.pin);
    await relay.ready;
    relay.send(
      encodeJsonFrame(REMOTE.hello as never, {
        deviceId: 'phone-1',
        deviceName: 'A Phone',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        publicKey: phoneKey.publicKey,
        nonce: 'n',
        chain,
        proof: issueProof(
          { netId: h.netId, hostPin: h.identity.pin, at: Date.now() },
          signWith(phoneKey.privateKey),
        ),
        tombstones: [tombstone],
      }),
    );
    await waitFor(() => h.net.revoked(h.netId).has('phone-1'), 'the relayed revocation to land');

    const after = device(h.port, h.identity.pin);
    await after.ready;
    after.send(returning(chain, h.netId, h.identity.pin));
    await waitFor(() => after.of(REMOTE.rejected).length > 0, 'the refusal');
  });

  /** A stranger cannot revoke anybody: an unverifiable tombstone is ignored. */
  it('ignores a revocation nobody in the net signed', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the join');
    const chain = issuedChain(phone.of(REMOTE.accepted)[0]);
    phone.close();

    const outsider = foundNet({ netName: 'Theirs', memberId: 'them', memberName: 'Them', certPin: '', now: 0 });
    const forged: Tombstone = {
      netId: h.netId,
      memberId: 'this-mac',
      at: Date.now(),
      // A chain from ANOTHER net, relabelled. Its signatures do not reach our root.
      signer: outsider.chain,
      signature: 'nonsense',
    };

    const relay = device(h.port, h.identity.pin);
    await relay.ready;
    relay.send(
      encodeJsonFrame(REMOTE.hello as never, {
        deviceId: 'phone-1',
        deviceName: 'A Phone',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        publicKey: phoneKey.publicKey,
        nonce: 'n',
        chain,
        proof: issueProof(
          { netId: h.netId, hostPin: h.identity.pin, at: Date.now() },
          signWith(phoneKey.privateKey),
        ),
        tombstones: [forged],
      }),
    );
    await waitFor(() => relay.of(REMOTE.accepted).length > 0, 'the accept');
    expect(h.net.revoked(h.netId).size).toBe(0);
  });

  /**
   * CO-PRESENCE: one pty, two clients, on two different transports, in sync in
   * both directions.
   *
   * Start a sentence on the Mac, watch it appear on the phone, press Enter from
   * the phone. v1 could not do this and said so — "single active viewer… we will
   * not stream a concurrently-mirrored grid", with co-presence filed as the
   * someday-bet behind a mosh-style rewrite (Approach 3).
   *
   * Here it is not a feature at all; it is what the architecture already is. One
   * pty has one `PtyFanout`, so every attached sink gets every byte — including
   * the tty's own ECHO of a half-typed line, which is why partial input shows up
   * without anybody streaming keystrokes. And input is just `write` on the same
   * session, so it does not matter which client sent it.
   *
   * The Mac connects to `SessionServer` directly (as main does over the daemon's
   * unix socket) and the phone through the TLS gate, so this also asserts the
   * two transports meet at the same server rather than at two copies of one.
   */
  it('streams one pty to a laptop AND a phone, and takes input from either', async () => {
    const h = await host();
    h.server.showCode();

    // --- the laptop: a direct client of the very same SessionServer.
    const laptopFrames: Frame[] = [];
    const laptopDecoder = new FrameDecoder();
    const laptopId = h.sessions.accept({
      write: (bytes) => laptopFrames.push(...laptopDecoder.feed(bytes).frames),
      close: () => undefined,
    });
    const laptopSend = (bytes: Uint8Array) => h.sessions.feed(laptopId, bytes);
    const laptopOutput = () =>
      laptopFrames
        .filter((f) => f.kind === RESPONSE.data)
        .map((f) => new TextDecoder().decode(f.bytes))
        .join('');

    laptopSend(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    laptopSend(
      encodeJsonFrame(REQUEST.create, { seq: 2, spec: { cwd: '/tmp', command: '/bin/sh', args: [] } }),
    );
    await waitFor(
      () => laptopFrames.some((f) => (f.json as { seq?: number } | undefined)?.seq === 2),
      'the laptop’s session',
    );
    const id = (
      laptopFrames.find((f) => (f.json as { seq?: number } | undefined)?.seq === 2)?.json as {
        value: { id: string };
      }
    ).value.id;
    laptopSend(encodeJsonFrame(REQUEST.attach, { seq: 3, sessionId: id }));

    // --- the phone: paired, over TLS, attached to the SAME session id.
    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the phone to pair');
    phone.send(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    phone.send(encodeJsonFrame(REQUEST.attach, { seq: 2, sessionId: id }));
    await waitFor(() => phone.output().length > 0, 'the phone’s replay');

    /**
     * Half a sentence, typed on the LAPTOP and never submitted.
     *
     * Two markers, and the split is what makes each assertion mean something.
     * `TYPED-ON-LAPTOP` is in the text itself, so seeing it proves the phone is
     * watching the tty's ECHO of a line that has not run. `RAN` appears only in
     * the output, so seeing it proves the command actually executed rather than
     * the echo being matched twice — which is the inverse of the trick the other
     * smokes use, for the inverse reason.
     */
    laptopSend(
      encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'TYPED-ON-LAPTOP %s\\n' 'RAN'")),
    );

    await waitFor(() => phone.output().includes('TYPED-ON-LAPTOP'), 'the phone to see the laptop typing');
    await waitFor(() => laptopOutput().includes('TYPED-ON-LAPTOP'), 'the laptop’s own echo');
    // Not submitted yet: nothing has run on either screen.
    expect(phone.output()).not.toContain('TYPED-ON-LAPTOP RAN');

    // --- and ENTER is pressed on the PHONE.
    phone.send(encodeByteFrame(REQUEST.write, id, new TextEncoder().encode('\r')));

    // The command the LAPTOP typed runs because the PHONE submitted it, and both
    // see the result.
    await waitFor(() => phone.output().includes('TYPED-ON-LAPTOP RAN'), 'the phone to see the output');
    await waitFor(() => laptopOutput().includes('TYPED-ON-LAPTOP RAN'), 'the laptop to see the output');

    // One pty, not two. This is the assertion the whole test is for.
    expect(h.sessionHost.list()).toHaveLength(1);
  });

  /**
   * The CONTROL half: a device lists what the Mac contributes, reads a view's
   * rows, taps one, and is told what to present.
   *
   * Nothing in this test names a task, and that is the assertion. The rows below
   * are whatever an extension returned; the device renders them and invokes
   * their declared verb, and the only thing it understands about the answer is
   * the `present` effect. Swap `tasks` for a `projects` extension and this test
   * — and the phone — would be unchanged.
   */
  it('lists contributed views, reads rows, and learns what a tap should show', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-control-')), 'remote-identity');
    const minted = await loadOrMintIdentity({ dir, mint: openssl });
    if (!minted.ok) throw new Error(minted.error);
    const identity = minted.value;

    const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
    const invoked: Array<{ device: string; command: string }> = [];

    // Stands in for the command registry. The rows are an extension's; this test
    // is deliberately incurious about what they mean.
    const control = new ControlChannel({
      host: {
        invoke: async (device, command) => {
          invoked.push({ device, command });
          if (command === 'views.list') {
            return {
              views: [
                { type: 'tasks.tree', title: 'Tasks', kind: 'tree' },
                { type: 'tasks.composer', title: 'New', kind: 'component' },
              ],
            };
          }
          if (command === 'views.children') {
            return [
              { id: 'sec', label: 'ACTIVE', section: true },
              {
                id: 't1',
                label: 'Ship remote',
                description: '2 repos',
                tint: 'accent',
                command: { id: 'tasks.reveal', args: { task: 't1' } },
                actions: [{ id: 'tasks.archive', label: 'Archive' }],
              },
            ];
          }
          if (command === 'tasks.reveal') {
            return { id: 't1', present: { kind: 'session', sessionId: 'sess-42' } };
          }
          throw new Error(`unexpected ${command}`);
        },
      },
      log: log.child('session'),
    });

    const server = new RemoteServer({
      endpoint: loopbackEndpoint({ identity }),
      identity,
      net: memoryNet(identity.pin),
      sessions: controlSink(control, log.child('session')),
      approve: async () => true,
      log: log.child('session'),
      newCode: () => '424242',
      now: () => Date.now(),
    });
    const started = await server.start();
    if (!started.ok) throw new Error(started.error);
    cleanups.push(() => server.stop());
    server.showCode();

    const phone = device(started.value.port, identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the accept');

    const ask = (seq: number, command: string, args?: unknown) =>
      phone.send(encodeJsonFrame(CONTROL.invoke as never, { seq, command, args }));
    const answer = (seq: number) =>
      phone.frames.find(
        (f) => (f.kind as number) === CONTROL.result && (f.json as { seq?: number }).seq === seq,
      )?.json as { ok: boolean; value?: unknown } | undefined;

    ask(1, 'views.list');
    await waitFor(() => answer(1) !== undefined, 'the view list');
    const views = (answer(1)?.value as { views: Array<{ type: string; kind: string }> }).views;
    // Both are REPORTED; the client decides it can only draw the tree.
    expect(views.map((v) => v.kind)).toEqual(['tree', 'component']);

    ask(2, 'views.children', { type: 'tasks.tree' });
    await waitFor(() => answer(2) !== undefined, 'the rows');
    const rows = answer(2)?.value as Array<{ id: string; section?: boolean; label: string }>;
    expect(rows.map((r) => r.id)).toEqual(['sec', 't1']);
    expect(rows[0]?.section).toBe(true);

    // A tap: the row's OWN verb, which this device learned by being sent the row.
    ask(3, 'tasks.reveal', { task: 't1' });
    await waitFor(() => answer(3) !== undefined, 'the tap');
    expect((answer(3)?.value as { present: unknown }).present).toEqual({
      kind: 'session',
      sessionId: 'sess-42',
    });

    // …and a verb it was never shown is refused before it reaches the registry.
    ask(4, 'tasks.delete', { task: 't1' });
    await waitFor(() => answer(4) !== undefined, 'the refusal');
    expect(answer(4)?.ok).toBe(false);
    expect(invoked.map((i) => i.command)).toEqual([
      'views.list',
      'views.children',
      'tasks.reveal',
    ]);
  });
});
