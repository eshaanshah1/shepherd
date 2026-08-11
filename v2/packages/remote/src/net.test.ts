// The net's trust core, asserted without crypto — which is the reason signing
// and verification are injected.
//
// The chain is what replaces a pairwise secret, so the cases that matter are the
// ways a chain can LOOK valid and not be: signed by the wrong key, chaining
// through a member that has since been revoked, or claiming a different net.

import { describe, expect, it } from 'vitest';
import {
  ROOT,
  credentialBytes,
  issueCredential,
  verifyChain,
  type Credential,
} from './net.ts';

const NET = 'net-abc';
const ROOT_KEY = 'root-pub';
const NOW = 1_000_000;

/**
 * A stand-in for a signature: deterministic, and wrong for any other key.
 *
 * Real Ed25519 is exercised in `netcrypto.test.ts`, over a chain this same
 * function shapes. What is under test HERE is the walk — who must have signed
 * what — and a real key pair would only make those cases harder to read.
 */
const sign = (privateKey: string, message: Uint8Array): string =>
  `signed-by:${privateKey}:${Buffer.from(message).toString('base64')}`;
const verify = (publicKey: string, message: Uint8Array, signature: string): boolean =>
  signature === sign(publicKey, message);

const issue = (over: Partial<Credential> & Pick<Credential, 'memberId' | 'issuer'>, signingKey: string): Credential =>
  issueCredential(
    {
      netId: NET,
      epoch: 1,
      name: over.memberId,
      publicKey: `${over.memberId}-pub`,
      certPin: `${over.memberId}-pin`,
      issuedAt: NOW,
      ...over,
    },
    (message) => sign(signingKey, message),
  );

/** The founding Mac: admitted by the net's root key itself. */
const founder = issue({ memberId: 'mac-mini', issuer: ROOT }, ROOT_KEY);
/** A laptop the founder admitted. */
const laptop = issue({ memberId: 'macbook', issuer: 'mac-mini' }, 'mac-mini-pub');
/** A phone the LAPTOP admitted — the transitive case the whole design is for. */
const phone = issue({ memberId: 'phone', issuer: 'macbook' }, 'macbook-pub');

const check = (chain: readonly Credential[], tombstoned: readonly string[] = []) =>
  verifyChain({ chain, netId: NET, rootPublicKey: ROOT_KEY, tombstoned: new Set(tombstoned), verify });

describe('a credential', () => {
  it('signs every field, so none of them can be edited in flight', () => {
    const renamed = { ...phone, name: 'Not A Phone' };
    expect(credentialBytes(renamed)).not.toEqual(credentialBytes(phone));
    expect(check([renamed, laptop, founder]).ok).toBe(false);
  });

  it('excludes the signature from what it signs', () => {
    expect(credentialBytes({ ...phone, signature: 'anything' })).toEqual(credentialBytes(phone));
  });
});

describe('verifyChain', () => {
  it('admits a member the founder signed directly', () => {
    const verdict = check([laptop, founder]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.member.memberId).toBe('macbook');
  });

  /**
   * The point of the whole design: the phone joined via the laptop, and the Mac
   * mini — which has never seen it — admits it with no ceremony.
   */
  it('admits a member admitted by a member, transitively', () => {
    expect(check([phone, laptop, founder]).ok).toBe(true);
  });

  it('refuses a chain that does not reach the root', () => {
    const verdict = check([phone, laptop]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('root');
  });

  it('refuses a credential signed by a key that is not its issuer', () => {
    const forged = issue({ memberId: 'stranger', issuer: 'macbook' }, 'stranger-pub');
    const verdict = check([forged, laptop, founder]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('signature');
  });

  /** A self-signed credential claiming the root admitted it. */
  it('refuses an impostor that signed itself as the root', () => {
    const impostor = issue({ memberId: 'impostor', issuer: ROOT }, 'impostor-pub');
    expect(check([impostor]).ok).toBe(false);
  });

  it('refuses a chain whose links name a different net', () => {
    const elsewhere = issue({ memberId: 'macbook', issuer: 'mac-mini', netId: 'other-net' }, 'mac-mini-pub');
    const verdict = check([elsewhere, founder]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('net');
  });

  it('refuses a chain whose links do not join up', () => {
    // `phone` names `macbook` as its issuer, but the next link is the founder.
    const verdict = check([phone, founder]);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a tombstoned member', () => {
    expect(check([phone, laptop, founder], ['phone']).ok).toBe(false);
  });

  /**
   * Revoking a member has to take its admissions with it. Otherwise a lost phone
   * that admitted something before it went missing leaves that thing inside the
   * net, and the revocation the user performed did less than it appeared to.
   */
  it('refuses a member admitted BY a tombstoned member', () => {
    const verdict = check([phone, laptop, founder], ['macbook']);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('revoked');
  });

  it('refuses an empty chain', () => {
    expect(check([]).ok).toBe(false);
  });
});
