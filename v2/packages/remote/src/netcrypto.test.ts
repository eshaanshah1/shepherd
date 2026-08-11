// The crypto half, over the SAME chain shapes `net.test.ts` walks with a
// stand-in — so "the walk is right" and "the signatures are real" are two
// statements with a test each, rather than one test that half-proves both.

import { describe, expect, it } from 'vitest';
import { ROOT, issueCredential, verifyChain } from './net.ts';
import { generateMemberKey, netIdOf, signWith, verifySignature } from './netcrypto.ts';

describe('member keys', () => {
  it('signs and verifies its own message', () => {
    const key = generateMemberKey();
    const message = new TextEncoder().encode('hello');
    expect(verifySignature(key.publicKey, message, signWith(key.privateKey)(message))).toBe(true);
  });

  it('refuses a signature from another key', () => {
    const mine = generateMemberKey();
    const theirs = generateMemberKey();
    const message = new TextEncoder().encode('hello');
    expect(verifySignature(mine.publicKey, message, signWith(theirs.privateKey)(message))).toBe(false);
  });

  it('refuses a signature over different bytes', () => {
    const key = generateMemberKey();
    const signature = signWith(key.privateKey)(new TextEncoder().encode('hello'));
    expect(verifySignature(key.publicKey, new TextEncoder().encode('hell0'), signature)).toBe(false);
  });

  it('survives a malformed key or signature rather than throwing', () => {
    // It is fed whatever a peer sent, so this is reachable rather than theoretical.
    expect(verifySignature('not-a-key', new Uint8Array([1]), 'zz')).toBe(false);
  });
});

describe('a net id', () => {
  it('is the SHA-256 of the root public key, and is stable', () => {
    const root = generateMemberKey();
    expect(netIdOf(root.publicKey)).toBe(netIdOf(root.publicKey));
    expect(netIdOf(root.publicKey)).toHaveLength(64);
    expect(netIdOf(generateMemberKey().publicKey)).not.toBe(netIdOf(root.publicKey));
  });
});

describe('a real chain', () => {
  it('verifies transitively, with every signature genuine', () => {
    const root = generateMemberKey();
    const mini = generateMemberKey();
    const laptop = generateMemberKey();
    const phone = generateMemberKey();
    const netId = netIdOf(root.publicKey);

    const credential = (
      memberId: string,
      publicKey: string,
      issuer: string,
      signingKey: string,
    ) =>
      issueCredential(
        { netId, epoch: 1, memberId, name: memberId, publicKey, certPin: `${memberId}-pin`, issuedAt: 0, issuer },
        signWith(signingKey),
      );

    const chain = [
      credential('phone', phone.publicKey, 'macbook', laptop.privateKey),
      credential('macbook', laptop.publicKey, 'mac-mini', mini.privateKey),
      credential('mac-mini', mini.publicKey, ROOT, root.privateKey),
    ];

    const verdict = verifyChain({
      chain,
      netId,
      rootPublicKey: root.publicKey,
      tombstoned: new Set(),
      verify: verifySignature,
    });
    expect(verdict.ok).toBe(true);

    // The same chain against another net's root is refused — the id alone is
    // not the check, the root key is.
    const other = generateMemberKey();
    expect(
      verifyChain({
        chain,
        netId,
        rootPublicKey: other.publicKey,
        tombstoned: new Set(),
        verify: verifySignature,
      }).ok,
    ).toBe(false);
  });
});
