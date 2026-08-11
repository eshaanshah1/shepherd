import { s, type KV } from '@shepherd/sdk';
import { ROOT, issueCredential, type Credential } from './net.ts';
import { generateMemberKey, netIdOf, signWith, type MemberKey } from './netcrypto.ts';
import {
  mergeEntries,
  mergeTombstones,
  revokedIds,
  type RosterEntry,
  type Tombstone,
} from './roster.ts';

/**
 * The nets this device belongs to, in THE store.
 *
 * It replaces the flat `paired` device list, and the reasoning that put that
 * list here holds unchanged: one persistence mechanism on purpose (ADR 0021 —
 * `node:sqlite`, stdlib, no native build against Electron's ABI), and both
 * processes opening the same database, which is what lets a device join ONCE and
 * connect twice (control to the app, data to the daemon) off one record.
 *
 * The invariant that makes sharing safe also holds unchanged: **only the app
 * ever admits a new member**, because only the app can show an approval. The
 * daemon reads. A headless process cannot let a stranger in.
 *
 * **`s.stored`, not `s.object`** (D15): a record written by a newer build must
 * read as "a net you are in with a field I do not understand", never as "you are
 * in no net" — the second would leave this Mac serving nobody while its
 * credentials sat on disk.
 */

const MEMBERSHIPS = 'memberships';
const ACTIVE = 'active-net';
const rosterKey = (netId: string) => `roster:${netId}`;
const tombstoneKey = (netId: string) => `tombstones:${netId}`;

/** What this device holds about one net it belongs to. */
export interface Membership {
  readonly netId: string;
  readonly netName: string;
  /** Hex SPKI DER. Every member holds it; it is what a chain terminates at. */
  readonly rootPublicKey: string;
  /**
   * Set ONLY on the device that founded the net.
   *
   * Any member can admit — an admission is signed with the admitter's OWN key,
   * not this one — so the root key is needed exactly once, when the net is
   * created. It stays where it was generated rather than travelling to every
   * member, because a key that is everywhere is a key that leaks from anywhere.
   */
  readonly rootPrivateKey?: string;
  readonly memberId: string;
  /** This device's own signing key pair for this net. */
  readonly memberKey: MemberKey;
  /** This device's chain, leaf first — what it presents to other members. */
  readonly chain: readonly Credential[];
  readonly joinedAt: number;
}

/**
 * Found a net: mint its root key, mint this device's member key, and sign the
 * one credential the root key will ever sign.
 *
 * The root key is used **once**. Every later admission is signed by the admitting
 * member's own key (any member may admit), so the root exists to be the thing a
 * chain terminates at rather than a thing anybody reaches for. It stays on this
 * device; a key copied to every member is a key that leaks from any of them.
 */
export function foundNet(options: {
  readonly netName: string;
  readonly memberId: string;
  readonly memberName: string;
  /** This device's TLS certificate pin, when it serves. Empty when it does not. */
  readonly certPin: string;
  readonly now: number;
}): Membership {
  const root = generateMemberKey();
  const memberKey = generateMemberKey();
  const netId = netIdOf(root.publicKey);
  const credential = issueCredential(
    {
      netId,
      epoch: 1,
      memberId: options.memberId,
      name: options.memberName,
      publicKey: memberKey.publicKey,
      certPin: options.certPin,
      issuedAt: options.now,
      issuer: ROOT,
    },
    signWith(root.privateKey),
  );
  return {
    netId,
    netName: options.netName,
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
    memberId: options.memberId,
    memberKey,
    chain: [credential],
    joinedAt: options.now,
  };
}

export interface NetStore {
  memberships(): readonly Membership[];
  /** The net whose transports are live. See `active` for why there is one. */
  active(): Membership | undefined;
  setActiveNet(netId: string | undefined): void;
  putMembership(membership: Membership): void;
  removeMembership(netId: string): void;

  roster(netId: string): readonly RosterEntry[];
  /** Fold in what a peer sent; returns the merged list. */
  mergeRoster(netId: string, entries: readonly RosterEntry[]): readonly RosterEntry[];
  tombstones(netId: string): readonly Tombstone[];
  addTombstone(netId: string, tombstone: Tombstone): void;
  revoked(netId: string): ReadonlySet<string>;
}

const CREDENTIAL = s.stored({
  netId: s.string(),
  epoch: s.number(),
  memberId: s.string(),
  name: s.string(),
  publicKey: s.string(),
  certPin: s.string(),
  issuedAt: s.number(),
  issuer: s.string(),
  signature: s.string(),
});

const MEMBERSHIP = s.stored({
  netId: s.string(),
  netName: s.string(),
  rootPublicKey: s.string(),
  rootPrivateKey: s.optional(s.string()),
  memberId: s.string(),
  memberKey: s.stored({ publicKey: s.string(), privateKey: s.string() }),
  chain: s.array(CREDENTIAL),
  joinedAt: s.number(),
});

const ENTRY = s.stored({
  memberId: s.string(),
  name: s.string(),
  addrs: s.array(s.string()),
  admittedBy: s.string(),
  admittedAt: s.number(),
  updatedAt: s.number(),
});

const TOMBSTONE = s.stored({
  netId: s.string(),
  memberId: s.string(),
  at: s.number(),
  signer: s.array(CREDENTIAL),
  signature: s.string(),
});

const MEMBERSHIPS_SCHEMA = s.array(MEMBERSHIP);
const ROSTER_SCHEMA = s.array(ENTRY);
const TOMBSTONES_SCHEMA = s.array(TOMBSTONE);

export function kvNetStore(kv: KV): NetStore {
  /**
   * Read on EVERY call rather than cached — the rule the device list already
   * followed, for the same reason: two processes share this, so a cache would be
   * one of them believing a member is still in the net after the other revoked
   * it. Revocation that takes effect eventually is not revocation.
   */
  const all = (): readonly Membership[] => kv.get(MEMBERSHIPS, MEMBERSHIPS_SCHEMA) ?? [];

  const store: NetStore = {
    memberships: all,

    /**
     * One active net, and it is core's business rather than the app's only
     * because the transports read it: which peers may be dialled, and which are
     * merely visible, is decided here.
     */
    active() {
      const netId = kv.get(ACTIVE, s.string());
      const nets = all();
      if (netId === undefined) return nets[0];
      return nets.find((membership) => membership.netId === netId) ?? nets[0];
    },

    setActiveNet(netId) {
      if (netId === undefined) kv.delete(ACTIVE);
      else kv.set(ACTIVE, netId);
    },

    putMembership(membership) {
      kv.set(MEMBERSHIPS, [
        ...all().filter((held) => held.netId !== membership.netId),
        membership,
      ]);
      // Joining your first net selects it. A device in exactly one net that
      // serves nobody because nothing was "selected" is a state the user cannot
      // see and cannot fix.
      if (kv.get(ACTIVE, s.string()) === undefined) kv.set(ACTIVE, membership.netId);
    },

    removeMembership(netId) {
      kv.set(MEMBERSHIPS, all().filter((held) => held.netId !== netId));
      kv.delete(rosterKey(netId));
      kv.delete(tombstoneKey(netId));
      if (kv.get(ACTIVE, s.string()) === netId) kv.delete(ACTIVE);
    },

    roster: (netId) => kv.get(rosterKey(netId), ROSTER_SCHEMA) ?? [],

    mergeRoster(netId, entries) {
      const merged = mergeEntries(store.roster(netId), entries);
      kv.set(rosterKey(netId), merged);
      return merged;
    },

    tombstones: (netId) => kv.get(tombstoneKey(netId), TOMBSTONES_SCHEMA) ?? [],

    addTombstone(netId, tombstone) {
      kv.set(tombstoneKey(netId), mergeTombstones(store.tombstones(netId), [tombstone]));
    },

    revoked: (netId) => revokedIds(store.tombstones(netId)),
  };

  return store;
}
