// The net store, over a real KV shape — a Map behind the same three methods, so
// what is asserted is this module's reads and writes rather than SQLite's.

import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { ROOT, issueCredential, verifyChain } from './net.ts';
import { netIdOf, verifySignature } from './netcrypto.ts';
import { issueTombstone } from './roster.ts';
import { foundNet, kvNetStore, type Membership } from './netstore.ts';

const sign = (message: Uint8Array) => `signed:${Buffer.from(message).toString('base64')}`;

function fakeKV(): KV {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, schema: Schema<T>): T | undefined {
      if (!values.has(key)) return undefined;
      const parsed = schema.parse(JSON.parse(JSON.stringify(values.get(key))));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  };
}

const membership = (netId: string): Membership => ({
  netId,
  netName: `${netId} net`,
  rootPublicKey: `${netId}-root-pub`,
  memberId: 'this-mac',
  memberKey: { publicKey: 'mine-pub', privateKey: 'mine-priv' },
  chain: [
    issueCredential(
      {
        netId,
        epoch: 1,
        memberId: 'this-mac',
        name: 'This Mac',
        publicKey: 'mine-pub',
        certPin: 'mine-cert',
        issuedAt: 0,
        issuer: ROOT,
      },
      sign,
    ),
  ],
  joinedAt: 0,
});

describe('founding a net', () => {
  it('mints a net whose id IS its root key, with this device inside it', () => {
    const founded = foundNet({ netName: 'Home', memberId: 'mac-mini', memberName: 'Mac mini', certPin: 'pin', now: 7 });

    expect(founded.netId).toBe(netIdOf(founded.rootPublicKey));
    /**
     * The root PRIVATE key is gone — it signed once and was destroyed, so the
     * founder holds nothing anybody else lacks. A membership that still carried
     * it would make one member permanently more powerful than the rest, which
     * is the thing this net does not have.
     */
    expect(JSON.stringify(founded)).not.toContain('rootPrivateKey');
    expect(founded.chain).toHaveLength(1);
    expect(
      verifyChain({
        chain: founded.chain,
        netId: founded.netId,
        rootPublicKey: founded.rootPublicKey,
        tombstoned: new Set(),
        verify: verifySignature,
      }).ok,
    ).toBe(true);
  });

  it('mints a different net every time', () => {
    const one = foundNet({ netName: 'Home', memberId: 'a', memberName: 'A', certPin: '', now: 0 });
    const two = foundNet({ netName: 'Home', memberId: 'a', memberName: 'A', certPin: '', now: 0 });
    expect(one.netId).not.toBe(two.netId);
  });
});

describe('memberships', () => {
  it('remembers a net across a fresh store over the same KV', () => {
    const kv = fakeKV();
    kvNetStore(kv).putMembership(membership('net-a'));
    expect(kvNetStore(kv).memberships().map((m) => m.netId)).toEqual(['net-a']);
  });

  it('holds several nets at once but exactly one active', () => {
    const store = kvNetStore(fakeKV());
    store.putMembership(membership('net-a'));
    store.putMembership(membership('net-b'));
    expect(store.memberships()).toHaveLength(2);

    store.setActiveNet('net-b');
    expect(store.active()?.netId).toBe('net-b');
    store.setActiveNet('net-a');
    expect(store.active()?.netId).toBe('net-a');
  });

  /**
   * The first net joined is the active one. A device that has joined exactly one
   * net and is serving nobody because nothing was "selected" is a bug the user
   * has no way to see.
   */
  it('makes the first net joined active without being asked', () => {
    const store = kvNetStore(fakeKV());
    store.putMembership(membership('net-a'));
    expect(store.active()?.netId).toBe('net-a');
  });

  it('replaces a membership of the same net rather than adding a second', () => {
    const store = kvNetStore(fakeKV());
    store.putMembership(membership('net-a'));
    store.putMembership({ ...membership('net-a'), netName: 'renamed' });
    expect(store.memberships()).toHaveLength(1);
    expect(store.memberships()[0]?.netName).toBe('renamed');
  });

  it('leaves no active net behind when the active one is left', () => {
    const store = kvNetStore(fakeKV());
    store.putMembership(membership('net-a'));
    store.removeMembership('net-a');
    expect(store.memberships()).toEqual([]);
    expect(store.active()).toBeUndefined();
  });

  it('reads a record written by a newer build rather than losing the net', () => {
    // `s.stored`: a record with an unknown field was written by a build ahead of
    // this one, and treating it as absent would leave a device serving a net it
    // believes it is not in.
    const kv = fakeKV();
    kv.set('memberships', [{ ...membership('net-a'), somethingNew: true }]);
    expect(kvNetStore(kv).memberships()).toHaveLength(1);
  });
});

describe('the roster', () => {
  const store = kvNetStore(fakeKV());
  store.putMembership(membership('net-a'));

  it('merges what a peer sends into what it already knows', () => {
    store.mergeRoster('net-a', [
      { memberId: 'phone', name: 'Phone', addrs: ['10.0.0.2:8723'], admittedBy: 'this-mac', admittedAt: 1, updatedAt: 1 },
    ]);
    store.mergeRoster('net-a', [
      { memberId: 'phone', name: 'Phone', addrs: ['10.0.0.9:8723'], admittedBy: 'this-mac', admittedAt: 1, updatedAt: 9 },
      { memberId: 'laptop', name: 'Laptop', addrs: [], admittedBy: 'this-mac', admittedAt: 2, updatedAt: 2 },
    ]);
    expect(store.roster('net-a').map((e) => e.memberId)).toEqual(['laptop', 'phone']);
    expect(store.roster('net-a').find((e) => e.memberId === 'phone')?.addrs).toEqual(['10.0.0.9:8723']);
  });

  it('keeps the roster of each net to itself', () => {
    store.putMembership(membership('net-b'));
    expect(store.roster('net-b')).toEqual([]);
  });

  it('records a revocation and reduces it to the set the chain walk reads', () => {
    const tombstone = issueTombstone(
      { netId: 'net-a', memberId: 'phone', at: 5, signer: membership('net-a').chain },
      sign,
    );
    store.addTombstone('net-a', tombstone);
    expect(store.revoked('net-a')).toEqual(new Set(['phone']));
    // Recorded once, however many times it is heard.
    store.addTombstone('net-a', tombstone);
    expect(store.tombstones('net-a')).toHaveLength(1);
  });
});
