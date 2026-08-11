import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import type { CategoryLogger } from '@shepherd/sdk';
import type { Endpoint, Listening, RemoteConnection } from './endpoint.ts';
import type { Identity } from './identity.ts';
import {
  freshCode,
  issueHostProof,
  joinDecision,
  spendAttempt,
  type Candidate,
  type Hello,
  type PairingCode,
} from './join.ts';
import { issueCredential, type Credential } from './net.ts';
import { signWith, verifySignature } from './netcrypto.ts';
import type { Membership, NetStore } from './netstore.ts';
import {
  issueTombstone,
  mergeEntries,
  rosterAddress,
  verifyTombstone,
  type RosterEntry,
  type Tombstone,
} from './roster.ts';

/**
 * The remote server: a GATE in front of the session protocol.
 *
 * It is deliberately not a second way to reach a session. A connection that gets
 * through the handshake is handed to the same `SessionServer` the Mac's renderer
 * talks to, as an ordinary `Connection` — so a phone speaks the identical
 * protocol, hits the identical fanout, and is handed the identical screen. That
 * is what makes "the phone is just another client for the same pty" a fact about
 * the architecture rather than a claim about it.
 *
 * v1 could not do this. Its remote path was a second implementation — a helper
 * that teed bytes, its own replay ring, its own attach semantics — and the three
 * copies drifted, which is what `applyRemoteCommand` beside `controlRoute` beside
 * `ShortcutActions` was (review §Bad-2).
 *
 * **What the gate now decides is MEMBERSHIP, not a pairing.** A connection either
 * carries a credential chain reaching this net's root — in which case it is
 * admitted with nothing shown to anybody, even if this Mac has never seen the
 * device — or it carries a pairing code and a human is asked. The old
 * host-issued `secret` is gone; nothing bearer-shaped is left on this path.
 *
 * **Frame kinds are disjoint from the session protocol's on purpose** (128+ vs
 * 1–68). One decoder reads both, so a handshake frame arriving mid-stream, or a
 * session frame arriving before the handshake, is a typed refusal rather than a
 * misparse.
 */

export const REMOTE = {
  hello: 128,
  accepted: 129,
  rejected: 130,
  pendingApproval: 131,
} as const;

/** What the host decides about a device that wants into the net. */
export type Approval = (request: {
  readonly candidate: Candidate;
  readonly sas?: string;
  readonly from: string;
}) => Promise<boolean>;

/** Who a connection turned out to be. */
export interface AdmittedMember {
  readonly memberId: string;
  readonly name: string;
}

/**
 * What the remote server hands an accepted connection to. `SessionServer` fits.
 *
 * `accept` RETURNS the id, and that is load-bearing: this server's connection
 * ids are its own, and the session server has another transport (the app's unix
 * socket) numbering from 1 as well. Reusing our id there made the phone's
 * connection 1 evict the Mac's, so the app's replies went to the phone and its
 * own panes went blank. Whoever owns the table owns the id.
 */
export interface SessionSink {
  accept(connection: { write(b: Uint8Array): void; close(): void }): number;
  feed(id: number, bytes: Uint8Array): void;
  disconnect(id: number): void;
}

export interface RemoteServerOptions {
  readonly endpoint: Endpoint;
  readonly identity: Identity;
  /** The nets this device is in, and the roster of each. */
  readonly net: NetStore;
  readonly sessions: SessionSink;
  readonly approve: Approval;
  /**
   * Which MEMBER a connection turned out to be.
   *
   * The sink is handed a connection id and nothing else, which is right for the
   * session protocol and wrong for the control channel: a command invoked by a
   * device is authorized against THAT device's grants, so an invented id
   * (`device-3`) is a caller the grant set can never match. It presented as
   * "device:device-1 is unknown (not registered as a live principal)" on a phone
   * that had just paired successfully.
   */
  readonly onAdmitted?: (connectionId: number, member: AdmittedMember) => void;
  readonly log: CategoryLogger;
  /** Injected: randomness stays out of the model (see `join.ts`). */
  readonly newCode: () => string;
  readonly now: () => number;
  /**
   * Where the DATA path is, told to every admitted client.
   *
   * The client must NOT cache this. A port is the host's to choose — it moves
   * when the daemon restarts on a taken port, or when a transport changes — and
   * a phone holding a stale one dials an address that belongs to nobody and
   * shows a terminal that never paints. Measured: the phone kept dialling the
   * port it paired with long after the daemon had moved.
   *
   * So it rides the ACCEPT, where it is refreshed on every connection, rather
   * than the pairing payload, which is written down once.
   */
  readonly dataPort?: () => number | undefined;
}

interface ClientState {
  readonly connection: RemoteConnection;
  readonly decoder: FrameDecoder;
  /** True once the handshake succeeded and the session server owns the frames. */
  admitted: boolean;
  /**
   * What the SESSION server calls this connection — set once admitted.
   *
   * Not our `connection.id`: see `SessionSink.accept`. It doubles as the
   * "the sink knows about this one" flag, so there is one fact rather than two
   * that can disagree.
   */
  sessionClientId?: number;
  memberId?: string;
}

export class RemoteServer {
  readonly #options: RemoteServerOptions;
  readonly #log: CategoryLogger;
  readonly #clients = new Map<number, ClientState>();
  #code: PairingCode | undefined;
  #listening: Listening | undefined;
  /** What each connection said it serves on, until it is admitted. */
  readonly #advertised = new Map<number, Hello['advertise']>();

  constructor(options: RemoteServerOptions) {
    this.#options = options;
    this.#log = options.log;
  }

  get port(): number | undefined {
    return this.#listening?.port;
  }

  /** The digits to show. Minting a new one invalidates whatever was showing. */
  showCode(): string {
    this.#code = freshCode(this.#options.newCode(), this.#options.now());
    return this.#code.digits;
  }

  get activeCode(): string | undefined {
    return this.#code?.digits;
  }

  async start(): Promise<ReturnType<Endpoint['listen']>> {
    const started = await this.#options.endpoint.listen((connection) => this.#accept(connection));
    if (started.ok) {
      this.#listening = started.value;
      this.#log.info(
        `remote is serving on ${this.#options.endpoint.kind} ${started.value.address}:${started.value.port}`,
      );
    } else {
      // A branch that ends in "and then nothing happens" says why: with no
      // listener, a phone's connection attempt is indistinguishable from a
      // firewall block, which cost v1 a session of tcpdump.
      this.#log.error(`remote did not start: ${started.error}`);
    }
    return started;
  }

  /**
   * Revoke a member and drop it NOW.
   *
   * Two halves, and both are needed. The **tombstone** is the durable half: it
   * is signed, it gossips to every other member, and it is what makes the
   * revocation true anywhere but here. Dropping the live connections is the
   * immediate half — leaving them up until they happen to close would mean
   * "revoked" describes a future state, and the person doing the revoking is
   * usually doing it because the device is in somebody else's hands.
   */
  revoke(memberId: string): void {
    const membership = this.#options.net.active();
    if (membership === undefined) {
      this.#log.warn(`cannot revoke ${memberId}: this Mac is in no net`);
      return;
    }
    this.#options.net.addTombstone(
      membership.netId,
      issueTombstone(
        { netId: membership.netId, memberId, at: this.#options.now(), signer: membership.chain },
        signWith(membership.memberKey.privateKey),
      ),
    );
    for (const [id, client] of [...this.#clients]) {
      if (client.memberId !== memberId) continue;
      client.connection.close();
      this.#drop(id);
    }
    this.#log.info(`revoked ${memberId} and dropped its live connections`);
  }

  stop(): void {
    for (const [id, client] of [...this.#clients]) {
      client.connection.close();
      this.#drop(id);
    }
    this.#listening?.dispose();
    this.#listening = undefined;
  }

  // ------------------------------------------------------------------ internals

  #accept(connection: RemoteConnection): void {
    this.#clients.set(connection.id, {
      connection,
      decoder: new FrameDecoder(),
      admitted: false,
    });
    connection.onClose(() => this.#drop(connection.id));
    connection.onData((bytes) => this.#onData(connection.id, bytes));
    this.#log.info(`remote connection ${connection.id} from ${connection.remoteAddress}`);
  }

  #drop(id: number): void {
    const client = this.#clients.get(id);
    if (client === undefined) return;
    // The session server hears about it only if it was ever told about it —
    // and when it does, R1's rule applies: viewers go, sessions do not.
    if (client.sessionClientId !== undefined) this.#options.sessions.disconnect(client.sessionClientId);
    this.#advertised.delete(id);
    this.#clients.delete(id);
  }

  #onData(id: number, bytes: Uint8Array): void {
    const client = this.#clients.get(id);
    if (client === undefined) return;

    // Admitted: the session protocol owns every byte from here. Fed straight
    // through rather than re-decoded, so there is exactly one decoder per
    // connection and no chance of the two disagreeing about a frame boundary.
    if (client.sessionClientId !== undefined) {
      this.#options.sessions.feed(client.sessionClientId, bytes);
      return;
    }

    const { frames, error } = client.decoder.feed(bytes);
    for (const frame of frames) this.#handshake(client, frame);
    if (error) {
      this.#log.error(`remote ${id} sent an unusable frame (${error.code}): ${error.message}`);
      client.connection.close();
      this.#drop(id);
    }
  }

  #handshake(client: ClientState, frame: Frame): void {
    // Compared as a NUMBER: the remote kinds live above the session protocol's
    // range on purpose (128+ vs 1-68) and are deliberately not members of its
    // union, so one decoder reads both without either becoming the other's type.
    if ((frame.kind as number) !== REMOTE.hello) {
      // A session frame before the handshake is the shape an attacker's first
      // probe takes, and the shape a buggy client takes. Both get the same
      // answer, and neither reaches a pty.
      this.#reject(client, 'send hello before anything else');
      return;
    }

    const hello = frame.json as Hello & {
      readonly roster?: readonly RosterEntry[];
      readonly tombstones?: readonly Tombstone[];
    };
    this.#advertised.set(client.connection.id, hello.advertise);
    const membership = this.#options.net.active();
    const decision = joinDecision({
      hello,
      net:
        membership === undefined
          ? undefined
          : {
              netId: membership.netId,
              rootPublicKey: membership.rootPublicKey,
              revoked: this.#options.net.revoked(membership.netId),
            },
      code: this.#code,
      now: this.#options.now(),
      certSha256: this.#options.identity.sha256,
      hostPin: this.#options.identity.pin,
      verify: verifySignature,
    });

    if (decision.kind === 'reject') {
      if (decision.spendsAttempt && this.#code !== undefined) {
        this.#code = spendAttempt(this.#code);
      }
      this.#reject(client, decision.reason);
      return;
    }

    // Only reachable with a net: `joinDecision` refuses everything without one.
    if (membership === undefined) {
      this.#reject(client, 'this Mac is not in a shep-net yet');
      return;
    }

    if (decision.kind === 'accept') {
      // Gossip travels on the connection of a member that is already proven —
      // never before, or a stranger could revoke the net on its way past the door.
      this.#gossip(membership, hello, client.connection.remoteAddress);
      this.#admit(client, membership, decision.member, hello.nonce);
      return;
    }

    // Needs a human. The connection stays open and idle meanwhile — the client
    // is told so explicitly rather than being left to guess from silence.
    this.#send(client, REMOTE.pendingApproval, {});
    void this.#options
      .approve({
        candidate: decision.candidate,
        ...(decision.sas === undefined ? {} : { sas: decision.sas }),
        from: client.connection.remoteAddress,
      })
      .then((approved) => {
        if (!this.#clients.has(client.connection.id)) return; // gave up waiting
        if (!approved) {
          this.#reject(client, 'this Mac declined the join');
          return;
        }
        // The code is one device, once. Burning it on approval — not on the
        // attempt — means a denied join does not cost the next attempt.
        this.#code = undefined;
        const credential = this.#issue(membership, decision.candidate);
        // No roster write here: `#admit` is the ONE writer, and it runs next.
        // Two writes in the same millisecond is a tie last-write-wins cannot
        // break, and the loser carried the addresses.
        this.#admit(client, membership, credential, hello.nonce, [credential, ...membership.chain]);
      })
      .catch((error: unknown) => {
        this.#log.error(`approval threw for ${decision.candidate.memberId}: ${String(error)}`);
        this.#reject(client, 'the approval could not be shown');
      });
  }

  /**
   * Admit a member into this net: a credential over the key it presented, signed
   * with THIS device's member key.
   *
   * Any member may admit, which is what makes a join cost one ceremony instead of
   * one per device already in the net. The signature is ours rather than the
   * net root's — the root key stays on the founding device — so the new member's
   * chain simply grows by one link.
   */
  #issue(membership: Membership, candidate: Candidate): Credential {
    return issueCredential(
      {
        netId: membership.netId,
        epoch: membership.chain[0]?.epoch ?? 1,
        memberId: candidate.memberId,
        name: candidate.name,
        publicKey: candidate.publicKey,
        certPin: candidate.certPin,
        issuedAt: this.#options.now(),
        issuer: membership.memberId,
      },
      signWith(membership.memberKey.privateKey),
    );
  }

  /**
   * Fold in what a proven member brought: roster entries as hints, tombstones
   * only after each is verified.
   *
   * Entries are taken on trust because a forged address costs an attacker a
   * failed connection and gains them nothing — the chain check happens on
   * connect. A tombstone DENIES, so it is checked: net, signer's chain, and the
   * signature over the bytes it claims.
   */
  #gossip(membership: Membership, hello: { roster?: readonly RosterEntry[]; tombstones?: readonly Tombstone[] }, from: string): void {
    if (hello.roster !== undefined && hello.roster.length > 0) {
      this.#options.net.mergeRoster(membership.netId, hello.roster);
    }
    for (const tombstone of hello.tombstones ?? []) {
      const trustworthy = verifyTombstone({
        tombstone,
        netId: membership.netId,
        rootPublicKey: membership.rootPublicKey,
        revoked: this.#options.net.revoked(membership.netId),
        verify: verifySignature,
      });
      if (!trustworthy) {
        this.#log.warn(`ignored an unverifiable revocation of ${tombstone.memberId} relayed by ${from}`);
        continue;
      }
      this.#options.net.addTombstone(membership.netId, tombstone);
      // A revocation that arrives while its subject is connected must land now,
      // for the reason `revoke` drops connections rather than waiting.
      for (const [id, client] of [...this.#clients]) {
        if (client.memberId !== tombstone.memberId) continue;
        client.connection.close();
        this.#drop(id);
      }
    }
  }

  #admit(
    client: ClientState,
    membership: Membership,
    member: Credential,
    nonce: string | undefined,
    issuedChain?: readonly Credential[],
  ): void {
    client.admitted = true;
    client.memberId = member.memberId;

    /**
     * Bookkeeping, and it must not be able to refuse a member — still less to
     * end the process.
     *
     * This runs in the daemon too, where a throw kills every terminal the user
     * has open (ADR 0036: the session outlives the app, so the daemon dying is
     * the one failure the design cannot absorb). The member is already
     * authenticated by the time we are here.
     */
    try {
      const now = this.#options.now();
      const advertised = this.#advertised.get(client.connection.id);
      this.#options.net.mergeRoster(membership.netId, [
        {
          memberId: member.memberId,
          name: member.name,
          addrs: rosterAddress(client.connection.remoteAddress, advertised?.port),
          ...(advertised?.dataPort === undefined ? {} : { dataPort: advertised.dataPort }),
          admittedBy: member.issuer,
          admittedAt: member.issuedAt,
          updatedAt: now,
        },
      ]);
    } catch (error) {
      this.#log.warn(`could not record ${member.memberId} in the roster: ${String(error)}`);
    }

    /**
     * The client is told who IT is, who WE are, and everything the net knows.
     *
     * `chain` is present only for a device that just joined — a returning member
     * already holds its own and would gain nothing from a copy. `proof` answers
     * the client's nonce, which is how the client knows it reached a member of
     * its net rather than whoever answered on that address; under a net there is
     * no pinned certificate left to tell it that.
     */
    this.#send(client, REMOTE.accepted, {
      netId: membership.netId,
      netName: membership.netName,
      /**
       * The net's root key, and a joiner cannot do without it: a membership with
       * no root is a membership that can never CHECK anybody — the device would
       * hold a credential and have no way to verify the next Mac it met. It is
       * not taken on trust either, since the net id it was handed is the hash of
       * this key, so the two verify each other.
       */
      rootPublicKey: membership.rootPublicKey,
      memberId: member.memberId,
      hostChain: membership.chain,
      ...(issuedChain === undefined ? {} : { chain: issuedChain }),
      ...(nonce === undefined
        ? {}
        : {
            proof: issueHostProof(
              { netId: membership.netId, nonce },
              signWith(membership.memberKey.privateKey),
            ),
          }),
      roster: this.#rosterWithSelf(membership),
      tombstones: this.#options.net.tombstones(membership.netId),
      ...(this.#options.dataPort?.() === undefined ? {} : { dataPort: this.#options.dataPort() }),
    });

    // From here the connection IS a session connection. No translation layer,
    // no second protocol — that is the whole design.
    client.sessionClientId = this.#options.sessions.accept({
      write: (bytes) => client.connection.write(bytes),
      close: () => client.connection.close(),
    });

    // Announced with the id the SINK chose, and only once it has one, so a
    // consumer that keys per-connection state off this hears the same number
    // `feed` and `disconnect` will use. Nothing can arrive in between — this
    // whole path is synchronous — so ordering costs the sink nothing.
    this.#options.onAdmitted?.(client.sessionClientId, { memberId: member.memberId, name: member.name });
    this.#log.info(`remote ${client.connection.id} admitted as ${member.name} (${member.memberId})`);
  }

  /**
   * The roster as this Mac would have somebody else hold it — itself included.
   *
   * A member never writes its own entry, because entries are written when
   * somebody connects and nobody connects to themselves. Handing out that list
   * unaltered gives a client everyone EXCEPT the machine it is talking to, which
   * is the one address it definitely needs.
   *
   * Its own address comes from the listener rather than the store, so it is
   * whatever it is actually bound to right now.
   */
  #rosterWithSelf(membership: Membership): readonly RosterEntry[] {
    const held = this.#options.net.roster(membership.netId);
    const listening = this.#listening;
    if (listening === undefined) return held;
    const self: RosterEntry = {
      memberId: membership.memberId,
      name: membership.chain[0]?.name ?? membership.memberId,
      addrs: rosterAddress(listening.address, listening.port),
      ...(this.#options.dataPort?.() === undefined ? {} : { dataPort: this.#options.dataPort() }),
      admittedBy: membership.chain[0]?.issuer ?? '',
      admittedAt: membership.joinedAt,
      updatedAt: this.#options.now(),
    };
    return mergeEntries(held, [self]);
  }

  #reject(client: ClientState, reason: string): void {
    this.#log.warn(`remote ${client.connection.id} refused: ${reason}`);
    this.#send(client, REMOTE.rejected, { reason });
    client.connection.close();
    this.#drop(client.connection.id);
  }

  #send(client: ClientState, kind: number, body: Record<string, unknown>): void {
    try {
      client.connection.write(encodeJsonFrame(kind as never, body));
    } catch (error) {
      this.#log.warn(`writing to remote ${client.connection.id} threw: ${String(error)}`);
    }
  }
}
