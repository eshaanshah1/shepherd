// The endpoint, over a real TLS socket.
//
// The claim worth proving is the one no unit test of the pairing model can make:
// that a client which pins our certificate gets through, one that does not is
// refused, and the bytes in between are not on the wire in the clear.

import { connect } from 'node:tls';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadOrMintIdentity, peerMatchesPin, type Minter } from './identity.ts';
import { loopbackEndpoint, type RemoteConnection } from './endpoint.ts';

const run = promisify(execFile);
const openssl: Minter = async (args) => {
  try {
    await run('/usr/bin/openssl', [...args]);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

async function identity() {
  const dir = join(await mkdtemp(join(tmpdir(), 'shepherd-endpoint-')), 'remote-identity');
  const minted = await loadOrMintIdentity({ dir, mint: openssl });
  if (!minted.ok) throw new Error(minted.error);
  return minted.value;
}

/** A client that trusts no CA and decides purely on the pin — what a phone does. */
function dial(port: number, pin: string, send: string) {
  return new Promise<{ ok: boolean; why?: string; echoed?: string }>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerX509Certificate();
      if (peer === undefined || !peerMatchesPin(new Uint8Array(peer.raw), pin)) {
        socket.destroy();
        resolve({ ok: false, why: 'pin mismatch' });
        return;
      }
      socket.write(send);
      socket.once('data', (d: Buffer) => {
        socket.destroy();
        resolve({ ok: true, echoed: d.toString() });
      });
    });
    socket.on('error', (e) => resolve({ ok: false, why: String(e) }));
  });
}

describe('the loopback endpoint', () => {
  it('accepts a client that pins it, and carries bytes both ways', async () => {
    const id = await identity();
    const seen: RemoteConnection[] = [];
    const listening = await loopbackEndpoint({ identity: id }).listen((connection) => {
      seen.push(connection);
      connection.onData((bytes) => connection.write(new TextEncoder().encode(`echo:${new TextDecoder().decode(bytes)}`)));
    });
    expect(listening.ok).toBe(true);
    if (!listening.ok) return;

    const answer = await dial(listening.value.port, id.pin, 'hello');
    expect(answer).toEqual({ ok: true, echoed: 'echo:hello' });
    expect(seen[0]?.remoteAddress).toContain('127.0.0.1');
    listening.value.dispose();
  });

  /**
   * There is no CA in this design, so TLS itself cannot refuse an impostor — the
   * pin comparison IS the verification. A test that only checked the happy path
   * would pass against a client that verified nothing at all.
   */
  it('is refused by a client holding the WRONG pin', async () => {
    const id = await identity();
    const listening = await loopbackEndpoint({ identity: id }).listen((connection) => {
      connection.onData(() => connection.write(new TextEncoder().encode('should never arrive')));
    });
    if (!listening.ok) throw new Error(listening.error);

    const answer = await dial(listening.value.port, 'f'.repeat(64), 'hello');
    expect(answer.ok).toBe(false);
    expect(answer.why).toBe('pin mismatch');
    listening.value.dispose();
  });

  it('binds loopback only, never a wildcard', async () => {
    const id = await identity();
    const listening = await loopbackEndpoint({ identity: id }).listen(() => undefined);
    if (!listening.ok) throw new Error(listening.error);
    // A "loopback" endpoint that quietly listened on every interface would be a
    // LAN server nobody decided to run.
    expect(listening.value.address).toBe('127.0.0.1');
    expect(listening.value.port).toBeGreaterThan(0);
    listening.value.dispose();
  });

  it('reports a bind failure rather than throwing', async () => {
    const id = await identity();
    const first = await loopbackEndpoint({ identity: id }).listen(() => undefined);
    if (!first.ok) throw new Error(first.error);

    const second = await loopbackEndpoint({ identity: id, port: first.value.port }).listen(() => undefined);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain('failed to bind');
    first.value.dispose();
  });

  it('encrypts what it carries — the payload is not on the wire', async () => {
    const id = await identity();
    const listening = await loopbackEndpoint({ identity: id }).listen((connection) => {
      connection.onData(() => connection.write(new TextEncoder().encode('SECRET-RESPONSE')));
    });
    if (!listening.ok) throw new Error(listening.error);

    // Asserted about BYTES rather than about the configuration: a test that
    // checked "we passed a key" would pass with TLS switched off.
    const raw: Buffer[] = [];
    const { createConnection } = await import('node:net');
    await new Promise<void>((resolve) => {
      const plain = createConnection({ host: '127.0.0.1', port: listening.value.port }, () => {
        plain.write('SECRET-REQUEST');
        setTimeout(() => {
          plain.destroy();
          resolve();
        }, 200);
      });
      plain.on('data', (d: Buffer) => raw.push(d));
      plain.on('error', () => resolve());
    });
    const onTheWire = Buffer.concat(raw).toString('latin1');
    expect(onTheWire).not.toContain('SECRET-RESPONSE');
    listening.value.dispose();
  });
});
