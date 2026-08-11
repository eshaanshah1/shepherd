// The roster: who is in the net, where they were last seen, and who has been
// revoked. Merging is where two members that have been apart agree again, so
// these tests are about disagreement.

import { describe, expect, it } from 'vitest';
import { ROOT, issueCredential, type Credential } from './net.ts';
import {
  issueTombstone,
  rosterAddress,
  selfAdvertisement,
  splitAddress,
  mergeEntries,
  mergeTombstones,
  revokedIds,
  verifyTombstone,
  type RosterEntry,
} from './roster.ts';

const NET = 'net-abc';
const ROOT_KEY = 'root-pub';

const sign = (privateKey: string) => (message: Uint8Array) =>
  `signed-by:${privateKey}:${Buffer.from(message).toString('base64')}`;
const verify = (publicKey: string, message: Uint8Array, signature: string): boolean =>
  signature === sign(publicKey)(message);

const credential = (memberId: string, issuer: string, signingKey: string): Credential =>
  issueCredential(
    {
      netId: NET,
      epoch: 1,
      memberId,
      name: memberId,
      publicKey: `${memberId}-pub`,
      certPin: `${memberId}-pin`,
      issuedAt: 0,
      issuer,
    },
    sign(signingKey),
  );

const founderChain = [credential('mac-mini', ROOT, ROOT_KEY)];
const laptopChain = [credential('macbook', 'mac-mini', 'mac-mini-pub'), ...founderChain];

const entry = (over: Partial<RosterEntry> & Pick<RosterEntry, 'memberId'>): RosterEntry => ({
  name: over.memberId,
  addrs: [],
  admittedBy: 'mac-mini',
  admittedAt: 0,
  updatedAt: 0,
  ...over,
});

describe('mergeEntries', () => {
  it('keeps members only one side has ever heard of', () => {
    const merged = mergeEntries([entry({ memberId: 'a' })], [entry({ memberId: 'b' })]);
    expect(merged.map((e) => e.memberId).sort()).toEqual(['a', 'b']);
  });

  it('takes the newer record when both sides know a member', () => {
    const merged = mergeEntries(
      [entry({ memberId: 'a', addrs: ['10.0.0.1:8723'], updatedAt: 10 })],
      [entry({ memberId: 'a', addrs: ['10.0.0.9:8723'], updatedAt: 20 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.addrs).toEqual(['10.0.0.9:8723']);
  });

  it('keeps what it has when the incoming record is older', () => {
    const merged = mergeEntries(
      [entry({ memberId: 'a', addrs: ['new'], updatedAt: 20 })],
      [entry({ memberId: 'a', addrs: ['old'], updatedAt: 10 })],
    );
    expect(merged[0]?.addrs).toEqual(['new']);
  });

  it('is stable in order, so two members converge on the same list', () => {
    const mine = [entry({ memberId: 'b' }), entry({ memberId: 'a' })];
    const theirs = [entry({ memberId: 'c' })];
    expect(mergeEntries(mine, theirs)).toEqual(mergeEntries(mine, theirs));
    expect(mergeEntries(mine, theirs).map((e) => e.memberId)).toEqual(
      mergeEntries(theirs, mine).map((e) => e.memberId),
    );
  });
});

describe('tombstones', () => {
  const tombstone = issueTombstone(
    { netId: NET, memberId: 'phone', at: 500, signer: laptopChain },
    sign('macbook-pub'),
  );

  const check = (over: Partial<Parameters<typeof verifyTombstone>[0]> = {}) =>
    verifyTombstone({
      tombstone,
      netId: NET,
      rootPublicKey: ROOT_KEY,
      revoked: new Set<string>(),
      verify,
      ...over,
    });

  it('is accepted when a member of the net signed it', () => {
    expect(check()).toBe(true);
  });

  /**
   * A tombstone carries its signer's whole chain rather than naming a member and
   * hoping the reader knows them. Without that, revocation would only travel one
   * hop — a Mac could not accept "the phone is revoked" relayed by a laptop it
   * had never met, which is exactly the case gossip exists to cover.
   */
  it('is accepted from a member this device has never met, via its chain', () => {
    expect(check()).toBe(true);
    expect(tombstone.signer).toHaveLength(2);
  });

  it('is refused when the signer is not in this net', () => {
    expect(check({ rootPublicKey: 'some-other-root' })).toBe(false);
  });

  it('is refused when the signature is over different bytes', () => {
    expect(check({ tombstone: { ...tombstone, memberId: 'macbook' } })).toBe(false);
  });

  /** A revoked device must not be able to revoke everyone else on its way out. */
  it('is refused when the signer has itself been revoked', () => {
    expect(check({ revoked: new Set(['macbook']) })).toBe(false);
  });

  it('merges to the EARLIEST record of a revocation', () => {
    const later = issueTombstone(
      { netId: NET, memberId: 'phone', at: 900, signer: founderChain },
      sign('mac-mini-pub'),
    );
    const merged = mergeTombstones([tombstone], [later]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.at).toBe(500);
  });

  it('reduces to the set the chain walk consults', () => {
    expect(revokedIds([tombstone])).toEqual(new Set(['phone']));
  });
});

describe('rosterAddress', () => {
  it('pairs the IP we saw with the port they told us', () => {
    // Their source port (54321) is the connection's and dies with it; 8723 is
    // what they actually listen on.
    expect(rosterAddress('192.168.1.7:54321', 8723)).toEqual(['192.168.1.7:8723']);
  });

  it('records nothing for a member that serves nothing', () => {
    // A phone. Listed in the roster by name, with nowhere to dial it.
    expect(rosterAddress('192.168.1.7:54321', undefined)).toEqual([]);
  });

  it('records nothing for loopback', () => {
    // It would hand every other member an address that resolves, on their own
    // machine, to themselves.
    expect(rosterAddress('127.0.0.1:54321', 8723)).toEqual([]);
    expect(rosterAddress('::1:54321', 8723)).toEqual([]);
  });
});

describe('splitAddress', () => {
  it('splits a hint at its port', () => {
    expect(splitAddress('192.168.1.7:8723')).toEqual({ host: '192.168.1.7', port: 8723 });
    expect(splitAddress('[fd00::1]:8723')).toEqual({ host: '[fd00::1]', port: 8723 });
  });

  /**
   * The one this exists for. An entry written by a build whose `rosterAddress`
   * did not carry the port is a bare IP, and slicing it at its last `:` dials
   * `192.168.0.11` on port 192 — a machine that was never in this net. Two of
   * them sat in `SYN_SENT` in a real profile, which is what "that member is
   * asleep" looked like from the app.
   */
  it('refuses a hint that names no port, rather than inventing one', () => {
    expect(splitAddress('192.168.0.117')).toBeUndefined();
    expect(splitAddress('')).toBeUndefined();
    expect(splitAddress(':8723')).toBeUndefined();
    expect(splitAddress('192.168.0.117:')).toBeUndefined();
    expect(splitAddress('192.168.0.117:nope')).toBeUndefined();
    expect(splitAddress('192.168.0.117:99999')).toBeUndefined();
  });
});

/**
 * The mirror of `rosterAddress`, and a defect measured on two real Macs: a Mac
 * launched without `--shepherd-remote=wifi` served control on loopback and still
 * advertised its port, so every other member held an entry that looked perfectly
 * healthy and could never be dialled.
 */
describe('selfAdvertisement', () => {
  it('advertises a real address', () => {
    expect(selfAdvertisement({ host: '192.168.1.20', port: 8722 })).toEqual({ port: 8722 });
    expect(selfAdvertisement({ host: '192.168.1.20', port: 8722 }, 8724)).toEqual({
      port: 8722,
      dataPort: 8724,
    });
  });

  it('advertises NOTHING when what it serves on is loopback', () => {
    for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', '']) {
      expect(selfAdvertisement({ host, port: 8722 }, 8724)).toBeUndefined();
    }
  });

  it('advertises nothing when it is not serving at all', () => {
    expect(selfAdvertisement(undefined)).toBeUndefined();
    expect(selfAdvertisement(undefined, 8724)).toBeUndefined();
  });
});
