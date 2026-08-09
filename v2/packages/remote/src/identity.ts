import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@shepherd/sdk';

/**
 * This Mac's TLS identity for remote clients: a self-signed certificate minted
 * once and kept forever.
 *
 * **Kept forever is the load-bearing part.** Every paired device pins this
 * certificate, so re-minting silently breaks all of them — the phone would
 * refuse the connection and look like a network fault. `reset` therefore exists
 * as ONE function that drops the identity and the pairings together, because
 * doing either alone leaves a device that can never reconnect and cannot say why.
 *
 * Node takes PEM key/cert directly, which deletes v1's entire identity problem.
 * Its `LANIdentity.swift` is a wall of Security.framework workarounds — a p12
 * import, RSA rather than EC because an EC p12 makes `SecPKCS12Import` *raise*
 * from inside `SecIdentityCreate`, a non-empty passphrase because an empty one
 * is `-25293`, and `kSecImportToMemoryOnly` so repeated loads stop filling the
 * login keychain. None of those are facts about TLS; they are facts about
 * `SecPKCS12Import`. Do not port them.
 *
 * What DOES carry over is the pin format: **SHA-256 over the whole certificate
 * DER**. It is the one representation `SecCertificateCopyData` (v1),
 * `cert.encoded` (Android) and `X509Certificate.raw` (here) all produce
 * identically, so nobody has to agree on a serialization.
 */

/** Where a caller may run `openssl`. Injected, so this module spawns nothing. */
export type Minter = (args: readonly string[]) => Promise<Result<void, string>>;

export interface Identity {
  readonly keyPem: string;
  readonly certPem: string;
  /** SHA-256 of the certificate DER, lowercase hex. The pin a client stores. */
  readonly pin: string;
  /** The same digest as bytes, for `sasDigits`. */
  readonly sha256: Uint8Array;
}

export interface IdentityOptions {
  /** `<support>/remote-identity`. */
  readonly dir: string;
  readonly mint: Minter;
}

const KEY = 'key.pem';
const CERT = 'cert.pem';
/** Ten years. A pinned certificate's expiry is a scheduled outage, not security. */
const DAYS = '3650';

export async function loadOrMintIdentity(options: IdentityOptions): Promise<Result<Identity, string>> {
  const keyPath = join(options.dir, KEY);
  const certPath = join(options.dir, CERT);

  const existing = await read(keyPath, certPath);
  if (existing !== undefined) return describe(existing.keyPem, existing.certPem);

  await mkdir(options.dir, { recursive: true });
  const minted = await options.mint([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    // No passphrase. The file mode is the protection, exactly as for an
    // unencrypted `~/.ssh/id_ed25519` — a constant passphrase in the source
    // would be theatre, and v1 said so about its own.
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    DAYS,
    '-subj',
    '/CN=shepherd',
    // Named so a client that DOES validate a hostname can, even though ours
    // pins instead. Costs nothing and removes a future footgun.
    '-addext',
    'subjectAltName=DNS:shepherd,IP:127.0.0.1',
  ]);
  if (!minted.ok) return err(`could not mint a remote identity: ${minted.error}`);

  // 0600 BEFORE anything can connect. A world-readable private key is the whole
  // security model gone, and it is the kind of thing nothing ever reports.
  await chmod(keyPath, 0o600);

  const written = await read(keyPath, certPath);
  if (written === undefined) return err('openssl reported success but wrote no identity');
  return describe(written.keyPem, written.certPem);
}

/**
 * Forget this Mac's identity.
 *
 * The caller MUST drop every pairing with it — every device pinned the
 * certificate being deleted, and one that is left paired can never reconnect and
 * has no way to discover why. That is why this takes the callback rather than
 * leaving it to a second call somebody can forget.
 */
export async function resetIdentity(
  options: IdentityOptions,
  dropAllPairings: () => Promise<void>,
): Promise<void> {
  await rm(options.dir, { recursive: true, force: true });
  await dropAllPairings();
}

/** The pin a client should have been given, from a certificate in hand. */
export function pinOf(certPem: string): { pin: string; sha256: Uint8Array } {
  const digest = createHash('sha256').update(new X509Certificate(certPem).raw).digest();
  return { pin: digest.toString('hex'), sha256: new Uint8Array(digest) };
}

/**
 * Whether a peer is the one we paired with.
 *
 * There is no CA anywhere in this design, so TLS itself cannot answer it — the
 * comparison IS the verification, and it has to be written out rather than
 * assumed from a `rejectUnauthorized` flag.
 */
export function peerMatchesPin(peerDer: Uint8Array, pin: string): boolean {
  const actual = createHash('sha256').update(peerDer).digest('hex');
  // Length-equal compare on hex of a fixed size; a timing side channel on a
  // value the peer already knows is not a threat, but constant work is free here.
  return actual.length === pin.length && actual === pin.toLowerCase();
}

async function read(keyPath: string, certPath: string): Promise<{ keyPem: string; certPem: string } | undefined> {
  try {
    const [keyPem, certPem] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(certPath, 'utf8'),
    ]);
    return { keyPem, certPem };
  } catch {
    return undefined;
  }
}

function describe(keyPem: string, certPem: string): Result<Identity, string> {
  try {
    const { pin, sha256 } = pinOf(certPem);
    return ok({ keyPem, certPem, pin, sha256 });
  } catch (error) {
    // A truncated or hand-edited cert lands here. Reported rather than thrown:
    // the caller's move is to reset, and a throw would take the app with it.
    return err(`the stored remote certificate could not be read: ${String(error)}`);
  }
}
