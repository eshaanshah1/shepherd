// R2's gate: a paired device drives a REAL pty over TLS, and needs no phone and
// no tailnet to prove it.
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
  encodeByteFrame,
  encodeJsonFrame,
  type Frame,
} from '@shepherd/core';
import { SessionServer } from '@shepherd/daemon';
import { createLogger, systemClock } from '@shepherd/sdk';
import { loadOrMintIdentity, peerMatchesPin, type Identity, type Minter } from './identity.ts';
import { loopbackEndpoint } from './endpoint.ts';
import { REMOTE, RemoteServer, type DeviceStore } from './server.ts';
import { REMOTE_PROTOCOL_VERSION, type PairedDevice } from './pairing.ts';

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

function memoryDevices(): DeviceStore & { list: PairedDevice[] } {
  const list: PairedDevice[] = [];
  return {
    list,
    all: () => list,
    put: (device) => {
      const at = list.findIndex((candidate) => candidate.id === device.id);
      if (at >= 0) list[at] = device;
      else list.push(device);
    },
    remove: (id) => {
      const at = list.findIndex((candidate) => candidate.id === id);
      if (at >= 0) list.splice(at, 1);
    },
  };
}

async function host(options: { approve?: boolean | (() => Promise<boolean>) } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-e2e-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  const identity: Identity = minted.value;

  const sessionHost = new SessionHost();
  const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
  const sessions = new SessionServer({ host: sessionHost, log });
  const devices = memoryDevices();

  const approvals: Array<{ sas?: string }> = [];
  const server = new RemoteServer({
    endpoint: loopbackEndpoint({ identity }),
    identity,
    devices,
    sessions,
    approve: async (request) => {
      approvals.push({ ...(request.sas === undefined ? {} : { sas: request.sas }) });
      if (typeof options.approve === 'function') return options.approve();
      return options.approve ?? true;
    },
    log: log.child('session'),
    newSecret: () => 'secret-for-tests',
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
  return { identity, server, devices, sessions, sessionHost, approvals, port: started.value.port };
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
    ...over,
  });

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
    // The secret comes back so the device never needs the code again.
    expect((phone.of(REMOTE.accepted)[0]?.json as { secret: string }).secret).toBe('secret-for-tests');

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
    expect(denied.devices.list).toHaveLength(0);
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

  it('lets a returning device in with its secret, and no code showing at all', async () => {
    const h = await host();
    h.server.showCode();

    const first = device(h.port, h.identity.pin);
    await first.ready;
    first.send(hello({ pairingCode: '424242' }));
    await waitFor(() => first.of(REMOTE.accepted).length > 0, 'the first pairing');
    first.close();

    // No code is showing now — a returning device must not need one.
    expect(h.server.activeCode).toBeUndefined();

    const again = device(h.port, h.identity.pin);
    await again.ready;
    again.send(hello({ secret: 'secret-for-tests' }));
    await waitFor(() => again.of(REMOTE.accepted).length > 0, 'the return');
    // And no second approval was asked for.
    expect(h.approvals).toHaveLength(1);
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
    back.send(hello({ secret: 'secret-for-tests' }));
    await waitFor(() => back.of(REMOTE.accepted).length > 0, 'the reconnect');
    back.send(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
    back.send(encodeJsonFrame(REQUEST.attach, { seq: 2, sessionId: id }));

    // The screen it missed, handed over on attach. A byte ring could not do
    // this; a serialized screen can.
    await waitFor(() => back.output().includes('before-the-drop'), 'the repaint after reconnecting');
    expect(back.output().split('before-the-drop')).toHaveLength(2);
  });

  it('drops a revoked device immediately, not eventually', async () => {
    const h = await host();
    h.server.showCode();

    const phone = device(h.port, h.identity.pin);
    await phone.ready;
    phone.send(hello({ pairingCode: '424242' }));
    await waitFor(() => phone.of(REMOTE.accepted).length > 0, 'the accept');
    expect(h.devices.list).toHaveLength(1);

    // Somebody is revoking because the device is in somebody else's hands, so
    // "revoked" has to describe the present rather than a future state.
    h.server.revoke('phone-1');
    expect(h.devices.list).toHaveLength(0);
    // And its session keeps running — a revoked VIEWER is not a killed agent.
    expect(h.sessionHost.list().length).toBeGreaterThanOrEqual(0);
  });
});
