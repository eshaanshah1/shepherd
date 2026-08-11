import { verifyChain, type Credential, type Sign, type Verify } from './net.ts';

/**
 * The roster: who is in the net, where they were last seen, and who is out.
 *
 * Membership proves WHO a peer is; it does not say where to find them. A phone
 * that joined via the laptop still has to locate the Mac mini, and discovery is
 * a transport's business (`api.ts`) — mDNS answers for a LAN and a tailnet
 * enumerates itself, but neither answers across networks. So members exchange
 * this on every connect, and a member nobody discovered is still dialable at the
 * address it was last seen on.
 *
 * **An entry is a HINT and carries no signature.** An address is not authority:
 * dialing a forged one reaches a machine that cannot present a credential chain,
 * so the lie costs an attacker a connection attempt and gains them nothing.
 * Signing them would buy nothing and would make every member's address list a
 * thing that has to be re-signed whenever it changes.
 *
 * **A tombstone IS signed, because it DENIES.** A forged revocation is the real
 * attack in this direction — it would evict a device its owner still wants — so
 * a tombstone carries its signer's whole chain and is verified before it counts.
 * Carrying the chain rather than naming a member is what makes revocation travel
 * more than one hop: a Mac can accept "the phone is revoked" relayed by a laptop
 * it has never met.
 *
 * Merging is last-write-wins per member for entries and EARLIEST-wins for
 * tombstones — see each function for why those are opposite.
 */

export interface RosterEntry {
  readonly memberId: string;
  readonly name: string;
  /** Last-known `host:port` pairs, most recent first. Hints — see above. */
  readonly addrs: readonly string[];
  /**
   * Where that member's DATA path listens, when it has one.
   *
   * Carried beside the addresses rather than inside them because it is the same
   * host on a different port, and a client needs both to be useful: control
   * gets it a view list, data gets it a terminal.
   */
  readonly dataPort?: number;
  readonly admittedBy: string;
  readonly admittedAt: number;
  /** Whose record is newer, when two members disagree about this one. */
  readonly updatedAt: number;
}

export interface Tombstone {
  readonly netId: string;
  /** The member being revoked. */
  readonly memberId: string;
  readonly at: number;
  /** The signer's own chain, leaf first. See the file comment. */
  readonly signer: readonly Credential[];
  readonly signature: string;
}

/** What a tombstone's signature covers. An array, for `credentialBytes`' reason. */
export function tombstoneBytes(tombstone: Omit<Tombstone, 'signature' | 'signer'>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(['shepherd-net-tombstone-v1', tombstone.netId, tombstone.memberId, tombstone.at]),
  );
}

export function issueTombstone(fields: Omit<Tombstone, 'signature'>, sign: Sign): Tombstone {
  return { ...fields, signature: sign(tombstoneBytes(fields)) };
}

export interface TombstoneCheck {
  readonly tombstone: Tombstone;
  readonly netId: string;
  readonly rootPublicKey: string;
  /** Already-known revocations: a revoked member may not revoke anyone else. */
  readonly revoked: ReadonlySet<string>;
  readonly verify: Verify;
}

/**
 * Did a member of this net really say this?
 *
 * Two questions, and both have to be asked: is the signer a member (its chain),
 * and did that signer sign these bytes (the signature). Checking only the second
 * would accept a well-formed statement from a stranger.
 */
export function verifyTombstone(check: TombstoneCheck): boolean {
  const { tombstone, netId, rootPublicKey, revoked, verify } = check;
  if (tombstone.netId !== netId) return false;

  const signer = verifyChain({
    chain: tombstone.signer,
    netId,
    rootPublicKey,
    tombstoned: revoked,
    verify,
  });
  if (!signer.ok) return false;

  return verify(signer.member.publicKey, tombstoneBytes(tombstone), tombstone.signature);
}

/**
 * Entries: **last write wins**, because an entry describes something that
 * changes — a name, an address — and the newest report is the useful one.
 *
 * Sorted by member id so two members that merged the same facts in a different
 * order hold the same list. Convergence you cannot observe is convergence you
 * cannot debug.
 */
export function mergeEntries(
  mine: readonly RosterEntry[],
  theirs: readonly RosterEntry[],
): readonly RosterEntry[] {
  const best = new Map<string, RosterEntry>();
  for (const entry of [...mine, ...theirs]) {
    const held = best.get(entry.memberId);
    if (held === undefined || entry.updatedAt > held.updatedAt) best.set(entry.memberId, entry);
  }
  return [...best.values()].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * Tombstones: **earliest wins**, which is the opposite rule and deliberately so.
 *
 * A revocation is not a fact that changes; it is a fact that happened. Keeping
 * the earliest record preserves when the device actually stopped being trusted,
 * and means a member cannot make a revocation look more recent than it was by
 * re-signing it.
 */
export function mergeTombstones(
  mine: readonly Tombstone[],
  theirs: readonly Tombstone[],
): readonly Tombstone[] {
  const best = new Map<string, Tombstone>();
  for (const tombstone of [...mine, ...theirs]) {
    const held = best.get(tombstone.memberId);
    if (held === undefined || tombstone.at < held.at) best.set(tombstone.memberId, tombstone);
  }
  return [...best.values()].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/** The set `verifyChain` consults. */
export function revokedIds(tombstones: readonly Tombstone[]): ReadonlySet<string> {
  return new Set(tombstones.map((tombstone) => tombstone.memberId));
}

/**
 * A peer's address as a roster hint, built from the half each side is right
 * about: the IP as the HOST saw it, and the port the member said it SERVES on.
 *
 * A member's source port is the connection's, not the member's — ephemeral, and
 * gone the moment the socket closes. Recording that is what made the first
 * roster useless: every entry named a port nobody could dial.
 *
 * Two cases yield nothing, and both are honest rather than defensive. A member
 * that advertises no port serves nothing (a phone), so there is no address to
 * hold. And loopback would hand every other member an address that resolves, on
 * their own machine, to themselves.
 */
export function rosterAddress(
  remoteAddress: string,
  servingPort: number | undefined,
): readonly string[] {
  if (servingPort === undefined) return [];
  const host = remoteAddress.split(':')[0] ?? '';
  if (host === '' || host === '127.0.0.1' || host === '::1') return [];
  return [`${host}:${servingPort}`];
}
