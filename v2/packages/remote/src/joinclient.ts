import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import { err, ok, type Result } from '@shepherd/sdk';
import { peerMatchesPin } from './identity.ts';
import { REMOTE_PROTOCOL_VERSION, hostProofBytes, issueProof } from './join.ts';
import { verifyChain, type Credential } from './net.ts';
import { generateMemberKey, netIdOf, signWith, verifySignature } from './netcrypto.ts';
import type { Membership } from './netstore.ts';
import { parseJoinURI } from './payload.ts';

/**
 * This Mac, joining somebody else's net.
 *
 * **The half that was missing.** The server could HOST a join and could not BE
 * the joiner, so "any device pairs with any device" was true for a phone and
 * false for a second Mac — which is exactly the case the whole design exists
 * for. A Mac that joins gains a membership, and from then on every other member
 * admits it on sight, including members it has never dialled.
 *
 * **It verifies the Mac that answers, and this is not a formality.** A join link
 * carries an address, a certificate pin and a net; the pin proves only that the
 * certificate is the one the link named. So the host must return its own chain
 * and a signature over a nonce chosen HERE, and both are checked before anything
 * it says is believed. Without that, anyone who obtained a link could stand at
 * that address and issue "memberships" for a net they are not in.
 *
 * One connection, one answer, then the socket closes: joining is not attaching.
 * What a member does with its membership afterwards is `RemoteServer`'s business
 * on one side and the session protocol's on the other.
 */

const REMOTE = { hello: 128, accepted: 129, rejected: 130, pendingApproval: 131 } as const;

export interface JoinOptions {
  /** A `shepherd://join?…` link, as `remote.pair` prints it. */
  readonly uri: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /**
   * This Mac's OWN certificate pin, for the credential it will be issued.
   *
   * A member that serves carries it so other members can bind its credential to
   * the certificate it presents. Empty is honest for a device that serves
   * nothing, and is what a phone sends.
   */
  readonly certPin: string;
  readonly now: () => number;
  /**
   * Already a member of this net: present the chain instead of a code.
   *
   * Reaching a member Mac this way is how a device that joined elsewhere is
   * admitted with no ceremony — and the answer is the membership it already has,
   * not a new one.
   */
  readonly membership?: Membership;
  /**
   * How long to wait for the whole exchange.
   *
   * Generous, because the middle of it is a human deciding. A join that hangs
   * forever is indistinguishable from a Mac that is not there, and the person
   * waiting cannot tell which without being told.
   */
  readonly timeoutMs?: number;
}

export const JOIN_TIMEOUT_MS = 120_000;

export async function joinNet(options: JoinOptions): Promise<Result<Membership, string>> {
  const facts = parseJoinURI(options.uri);
  if (facts === undefined) {
    return err(
      `that is not a join link this build can use — it must be a shepherd://join link for protocol ${REMOTE_PROTOCOL_VERSION}`,
    );
  }
  if (options.membership !== undefined && options.membership.netId !== facts.netId) {
    // Silently joining a second net because a link said so is how a device ends
    // up in a net nobody meant it to be in.
    return err('that link is for a different net than the membership you hold');
  }

  const key = options.membership?.memberKey ?? generateMemberKey();
  const nonce = randomBytes(16).toString('hex');

  return await new Promise<Result<Membership, string>>((resolve) => {
    let settled = false;
    const finish = (answer: Result<Membership, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };

    const timer = setTimeout(
      () => finish(err(`no answer from ${facts.host}:${facts.port} — is Shepherd serving there?`)),
      options.timeoutMs ?? JOIN_TIMEOUT_MS,
    );

    const socket: TLSSocket = connect(
      { host: facts.host, port: facts.port, rejectUnauthorized: false },
      () => {
        /**
         * The pin, checked before a single byte of ours is written.
         *
         * There is no CA anywhere in this design, so TLS itself cannot answer
         * "is this the Mac the link named" — the comparison IS the verification,
         * and it has to be written out rather than implied by a flag.
         */
        const peer = socket.getPeerX509Certificate();
        if (peer === undefined || !peerMatchesPin(new Uint8Array(peer.raw), facts.pin)) {
          finish(err('that Mac presented a different certificate than the link named'));
          return;
        }
        socket.write(
          encodeJsonFrame(REMOTE.hello as never, {
            deviceId: options.deviceId,
            deviceName: options.deviceName,
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            publicKey: key.publicKey,
            certPin: options.certPin,
            nonce,
            // We enforced the pin during the handshake rather than learning it,
            // so the other Mac can skip asking a human to compare digits.
            pinVerified: true,
            ...(options.membership === undefined
              ? { ...(facts.code === undefined ? {} : { pairingCode: facts.code }) }
              : {
                  chain: options.membership.chain,
                  proof: issueProof(
                    { netId: facts.netId, hostPin: facts.pin, at: options.now() },
                    signWith(key.privateKey),
                  ),
                }),
          }),
        );
      },
    );

    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      const { frames } = decoder.feed(new Uint8Array(chunk));
      for (const frame of frames) {
        const answer = read(frame, { facts, key, nonce, held: options.membership });
        if (answer !== undefined) finish(answer);
      }
    });
    socket.on('error', (error: Error) => finish(err(`could not reach ${facts.host}:${facts.port}: ${error.message}`)));
    socket.on('close', () => finish(err('that Mac closed the connection without answering')));
  });
}

/** One frame. Undefined means "keep waiting" — which `pendingApproval` is. */
function read(
  frame: Frame,
  context: {
    facts: NonNullable<ReturnType<typeof parseJoinURI>>;
    key: { publicKey: string; privateKey: string };
    nonce: string;
    held: Membership | undefined;
  },
): Result<Membership, string> | undefined {
  const kind = frame.kind as number;
  if (kind === REMOTE.pendingApproval) return undefined; // a human is deciding
  if (kind === REMOTE.rejected) {
    const reason = (frame.json as { reason?: string } | undefined)?.reason ?? 'refused';
    return err(reason);
  }
  if (kind !== REMOTE.accepted) return err(`that Mac sent something unexpected (frame ${kind})`);

  const body = frame.json as {
    netId?: string;
    netName?: string;
    rootPublicKey?: string;
    memberId?: string;
    hostChain?: readonly Credential[];
    chain?: readonly Credential[];
    proof?: string;
  };

  const { facts, key, nonce, held } = context;
  const netId = body.netId;
  const root = body.rootPublicKey;
  if (netId === undefined || root === undefined) return err('that Mac named no net');
  // The id and the key check each other, and both must be the ones the link named.
  if (netIdOf(root) !== netId.toLowerCase()) return err('that net’s id does not match its root key');
  if (netId !== facts.netId || root !== facts.rootPublicKey) {
    return err('that Mac belongs to a different net than the link named');
  }

  const hostChain = body.hostChain;
  if (hostChain === undefined) return err('that Mac sent no membership of its own');
  const hostVerdict = verifyChain({
    chain: hostChain,
    netId,
    rootPublicKey: root,
    tombstoned: new Set(),
    verify: verifySignature,
  });
  if (!hostVerdict.ok) return err(hostVerdict.reason);

  if (body.proof === undefined) return err('that Mac did not prove it holds its own key');
  if (!verifySignature(hostVerdict.member.publicKey, hostProofBytes({ netId, nonce }), body.proof)) {
    return err('that Mac could not prove it holds the key its membership names');
  }

  // Already a member: nothing was reissued, and nothing needs to be.
  if (body.chain === undefined) {
    if (held !== undefined) return ok(held);
    return err('that Mac admitted us but issued no membership');
  }

  const issued = verifyChain({
    chain: body.chain,
    netId,
    rootPublicKey: root,
    tombstoned: new Set(),
    verify: verifySignature,
  });
  if (!issued.ok) return err(`that Mac issued a membership that does not check out: ${issued.reason}`);
  if (issued.member.publicKey !== key.publicKey) {
    // It describes a key we do not hold, so it could never be proven to anybody.
    return err('that Mac issued a membership for a different key');
  }

  return ok({
    netId,
    netName: body.netName ?? facts.netName,
    rootPublicKey: root,
    memberId: issued.member.memberId,
    memberKey: key,
    chain: body.chain,
    joinedAt: issued.member.issuedAt,
  });
}
