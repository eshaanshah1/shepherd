import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import type { Sign, Verify } from './net.ts';

/**
 * The one module in the net that touches `node:crypto`. Everything it produces
 * is fed to `net.ts`, which stays pure and knows none of this.
 *
 * **Ed25519, not RSA or ECDSA-over-a-curve-we-pick.** Key generation is
 * sub-millisecond (against ~70ms for the RSA-2048 TLS identity), signatures are
 * 64 bytes, and there is no parameter to get wrong — no curve choice, no hash
 * choice, no padding mode. `node:crypto` signs it with a null digest, which is
 * why `sign(null, …)` below is correct rather than a mistake.
 *
 * **Keys travel as hex DER**, not PEM: they ride inside JSON frames and get
 * stored in a KV, and a PEM's newlines and armour survive neither well. SPKI for
 * public, PKCS8 for private — the two encodings `node:crypto` reads back without
 * being told anything else about them.
 *
 * Note what this module does NOT own: the TLS identity. That is `identity.ts`,
 * it is RSA, and it is a different key for a different job — TLS terminates the
 * channel, a member key signs statements about membership. The credential binds
 * them by carrying the certificate's pin.
 */

export interface MemberKey {
  /** Hex SPKI DER — what a credential carries and a peer verifies against. */
  readonly publicKey: string;
  /** Hex PKCS8 DER — never leaves this device. */
  readonly privateKey: string;
}

export function generateMemberKey(): MemberKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

/** A `Sign` bound to one member's private key, for `issueCredential`. */
export function signWith(privateKeyHex: string): Sign {
  return (message) => {
    const key = createPrivateKey({
      key: Buffer.from(privateKeyHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    return nodeSign(null, message, key).toString('hex');
  };
}

/**
 * Total, because it is fed whatever a peer sent.
 *
 * A malformed key or a signature that is not hex must be a refusal, not a throw:
 * this runs on the handshake path, and in the daemon a throw takes every pty the
 * user has open with it (ADR 0036).
 */
export const verifySignature: Verify = (publicKeyHex, message, signatureHex) => {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return nodeVerify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
};

/**
 * A net's id: the SHA-256 of its root public key, lowercase hex.
 *
 * Derived rather than minted, so an id cannot name a key nobody holds — and two
 * devices comparing net ids are comparing the thing that actually decides
 * membership.
 */
export function netIdOf(rootPublicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(rootPublicKeyHex, 'hex')).digest('hex');
}
