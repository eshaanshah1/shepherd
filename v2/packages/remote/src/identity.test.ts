// The identity, against a REAL openssl and a real temp directory.
//
// A faked minter would prove the plumbing and nothing about the thing that
// actually matters — that the certificate Node serves and the pin a phone
// computes are the same certificate. `execFile` is used directly HERE because a
// test may reach the machine (the `boundary/core-tests` carve-out, same reason);
// the shipped code takes a `Minter` and spawns nothing.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrMintIdentity, peerMatchesPin, pinOf, resetIdentity, type Minter } from './identity.ts';
import { sasDigits } from './pairing.ts';

const run = promisify(execFile);

const openssl: Minter = async (args) => {
  try {
    await run('/usr/bin/openssl', [...args]);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

let dirs: string[] = [];
afterEach(() => {
  dirs = [];
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shepherd-identity-'));
  dirs.push(dir);
  return join(dir, 'remote-identity');
}

describe('the remote identity', () => {
  it('mints once and hands back a usable key, cert and pin', async () => {
    const dir = await scratch();
    const minted = await loadOrMintIdentity({ dir, mint: openssl });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(minted.value.keyPem).toContain('PRIVATE KEY');
    expect(minted.value.certPem).toContain('BEGIN CERTIFICATE');
    expect(minted.value.pin).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.value.sha256).toHaveLength(32);
  });

  /**
   * THE property. Every paired device pins this certificate, so a second load
   * that minted again would silently break all of them — and it would present as
   * a network fault rather than as anything about pairing.
   */
  it('is STABLE across reloads — a re-mint would break every paired device', async () => {
    const dir = await scratch();
    const first = await loadOrMintIdentity({ dir, mint: openssl });
    const second = await loadOrMintIdentity({
      dir,
      // If this runs at all, the identity was not reused — so the test would
      // fail on the pin below AND on this refusal, whichever comes first.
      mint: async () => ({ ok: false, error: 'must not mint twice' }),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.pin).toBe(first.value.pin);
    expect(second.value.certPem).toBe(first.value.certPem);
  });

  it('writes the private key 0600 before anything can connect', async () => {
    const dir = await scratch();
    await loadOrMintIdentity({ dir, mint: openssl });
    const mode = (await stat(join(dir, 'key.pem'))).mode & 0o777;
    // A world-readable private key is the whole security model gone, and it is
    // exactly the kind of thing nothing ever reports.
    expect(mode).toBe(0o600);
  });

  it('reports a mint failure rather than throwing', async () => {
    const dir = await scratch();
    const answer = await loadOrMintIdentity({ dir, mint: async () => ({ ok: false, error: 'no openssl' }) });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toContain('no openssl');
  });

  it('reports an unreadable certificate rather than throwing', async () => {
    const dir = await scratch();
    await loadOrMintIdentity({ dir, mint: openssl });
    await writeFile(join(dir, 'cert.pem'), 'not a certificate', 'utf8');

    const answer = await loadOrMintIdentity({ dir, mint: openssl });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    // The caller's move is to reset; a throw would take the app with it.
    expect(answer.error).toContain('could not be read');
  });

  /**
   * Dropping the identity and dropping the pairings is ONE act. Doing either
   * alone leaves a device that can never reconnect and has no way to find out
   * why — so the callback is a parameter rather than a second call to remember.
   */
  it('cannot forget its identity without also dropping every pairing', async () => {
    const dir = await scratch();
    const before = await loadOrMintIdentity({ dir, mint: openssl });
    let dropped = false;

    await resetIdentity({ dir, mint: openssl }, async () => {
      dropped = true;
    });
    expect(dropped).toBe(true);

    const after = await loadOrMintIdentity({ dir, mint: openssl });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.value.pin).not.toBe(before.value.pin);
  });
});

describe('the pin', () => {
  it('matches a peer presenting the same certificate, and nothing else', async () => {
    const dir = await scratch();
    const minted = await loadOrMintIdentity({ dir, mint: openssl });
    if (!minted.ok) throw new Error('mint failed');

    const der = new Uint8Array(
      (await import('node:crypto')).createHash('sha256').update('irrelevant').digest(),
    );
    const realDer = new (await import('node:crypto')).X509Certificate(minted.value.certPem).raw;

    expect(peerMatchesPin(new Uint8Array(realDer), minted.value.pin)).toBe(true);
    expect(peerMatchesPin(der, minted.value.pin)).toBe(false);
    // Case-insensitive on the stored side: a pin that round-tripped through a QR
    // or a settings file must not fail on capitalisation.
    expect(peerMatchesPin(new Uint8Array(realDer), minted.value.pin.toUpperCase())).toBe(true);
  });

  it('is the same digest the SAS digits are derived from', async () => {
    const dir = await scratch();
    const minted = await loadOrMintIdentity({ dir, mint: openssl });
    if (!minted.ok) throw new Error('mint failed');

    // One digest, two uses — so the digits a human compares describe the exact
    // certificate a client pins.
    const { pin, sha256 } = pinOf(minted.value.certPem);
    expect(pin).toBe(minted.value.pin);
    expect(sasDigits(sha256)).toBe(sasDigits(minted.value.sha256));
  });
});
