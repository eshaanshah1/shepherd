/**
 * A shep-net: membership as the credential, replacing the pairwise pairing this
 * package started with.
 *
 * **Why this exists at all.** The model it replaces was pairwise and asymmetric —
 * a host held a `secret` it issued to one device, that device held a `pin` of one
 * host's certificate — so `N` devices cost `N × (N−1) / 2` ceremonies and every
 * new device made it worse. Here a device joins ONCE and every other member
 * admits it on first contact, having never seen it.
 *
 * **The shape.** A net is a name and a root key pair; its **id is the SHA-256 of
 * the root public key**. Every member holds its own key pair and a `Credential`
 * signed by whichever member admitted it, so a chain reads
 * `me ← admitter ← … ← root`. Any member may admit, which makes every member an
 * intermediate authority — the option that keeps "any device pairs with any
 * device" and needs no designated machine to be online.
 *
 * **Randomness and crypto stay OUT**, exactly as they do in the join ceremony:
 * signing and verification are passed in, so every decision here is a pure
 * function a test pins without a key pair. `netcrypto.ts` is the one place that
 * touches `node:crypto`, and it is tested against these same shapes.
 *
 * **What binds a credential to a TLS connection is `certPin`.** The credential
 * says "this member's certificate hashes to X"; the transport observes the
 * certificate the peer actually presented and compares. Without that a stolen
 * credential would be a bearer token — which is the very thing §8 of the design
 * refused to carry forward from the old `secret`.
 */

/** The issuer of a founding member's credential: the net's root key itself. */
export const ROOT = 'root';

/**
 * How many links a chain may have.
 *
 * Not a security boundary — a longer chain is refused, not exploited — but a
 * bound on work a stranger can ask this Mac to do before it has admitted them.
 * Eight is far past any real net: it is `founder → … → you` across eight devices.
 */
export const MAX_CHAIN = 8;

export interface Credential {
  /** Which net this asserts membership of. Hex SHA-256 of the root public key. */
  readonly netId: string;
  /**
   * The net's epoch when this was issued.
   *
   * Carried, and deliberately not enforced yet. Rotation — re-issuing every
   * credential so that anything not re-issued falls out by SILENCE rather than
   * by being told — is the fail-closed answer to revocation, and the design
   * defers the operation while shipping the field, so adding it later is not a
   * protocol bump.
   */
  readonly epoch: number;
  readonly memberId: string;
  readonly name: string;
  /** The member's own signing key, hex SPKI DER. */
  readonly publicKey: string;
  /** Hex SHA-256 of the member's TLS certificate DER. See the file comment. */
  readonly certPin: string;
  readonly issuedAt: number;
  /** The `memberId` that admitted this one, or `ROOT` for a founder. */
  readonly issuer: string;
  /** Hex, over `credentialBytes`. */
  readonly signature: string;
}

/** Sign these bytes with the caller's key. Injected — see the file comment. */
export type Sign = (message: Uint8Array) => string;
export type Verify = (publicKey: string, message: Uint8Array, signature: string) => boolean;

/**
 * Exactly what a signature covers: every field except the signature.
 *
 * A JSON **array**, not an object: array order is fixed by construction, whereas
 * object key order is a property of whoever built the object. Two peers must
 * hash the same bytes, and "we both used JSON.stringify" is not enough to
 * guarantee that.
 */
export function credentialBytes(credential: Omit<Credential, 'signature'> & { signature?: string }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'shepherd-net-credential-v1',
      credential.netId,
      credential.epoch,
      credential.memberId,
      credential.name,
      credential.publicKey,
      credential.certPin,
      credential.issuedAt,
      credential.issuer,
    ]),
  );
}

/** Admit a member: the signing key is the ISSUER's, or the net's root key. */
export function issueCredential(fields: Omit<Credential, 'signature'>, sign: Sign): Credential {
  return { ...fields, signature: sign(credentialBytes(fields)) };
}

export interface ChainInput {
  /** Leaf first, the root-issued founder last. */
  readonly chain: readonly Credential[];
  readonly netId: string;
  /** Hex SPKI DER of the net's root key — every member holds it. */
  readonly rootPublicKey: string;
  readonly tombstoned: ReadonlySet<string>;
  readonly verify: Verify;
}

export type ChainVerdict =
  | { readonly ok: true; readonly member: Credential }
  | { readonly ok: false; readonly reason: string };

/**
 * Is this peer a member of this net?
 *
 * The walk, and the order is the argument: identity claims are checked before
 * signatures so a malformed chain costs no verification work, and revocation is
 * checked across the WHOLE chain rather than the leaf alone — a member admitted
 * by a since-revoked device must fall with it, or revoking a lost phone would
 * leave everything it ever admitted inside the net.
 */
export function verifyChain(input: ChainInput): ChainVerdict {
  const { chain, netId, rootPublicKey, tombstoned, verify } = input;

  if (chain.length === 0) return refuse('the device presented no membership at all');
  if (chain.length > MAX_CHAIN) return refuse(`a membership chain may not be ${chain.length} links long`);

  for (const link of chain) {
    if (link.netId !== netId) return refuse('that membership is for a different net');
    if (tombstoned.has(link.memberId)) {
      const leaf = link.memberId === chain[0]?.memberId;
      return refuse(leaf ? 'that device was revoked' : `it was admitted by ${link.name}, which was revoked`);
    }
  }

  // Each link must name the next one as its issuer, and the last must name the
  // root. A list cannot contain a cycle, so this is the whole structural check.
  for (let i = 0; i < chain.length - 1; i += 1) {
    const link = chain[i];
    const issuer = chain[i + 1];
    if (link === undefined || issuer === undefined) return refuse('that membership chain is malformed');
    if (link.issuer !== issuer.memberId) return refuse('that membership chain does not join up');
  }

  const last = chain[chain.length - 1];
  if (last === undefined || last.issuer !== ROOT) {
    return refuse('that membership does not chain to the root of this net');
  }

  // Signatures last, and every one of them: a chain is only as good as its
  // weakest link, so there is no "the leaf verified" shortcut.
  for (let i = 0; i < chain.length; i += 1) {
    const link = chain[i];
    if (link === undefined) return refuse('that membership chain is malformed');
    const key = i === chain.length - 1 ? rootPublicKey : chain[i + 1]?.publicKey;
    if (key === undefined || !verify(key, credentialBytes(link), link.signature)) {
      return refuse(`the signature on ${link.name}'s membership does not check out`);
    }
  }

  return { ok: true, member: chain[0] as Credential };
}

function refuse(reason: string): ChainVerdict {
  return { ok: false, reason };
}
