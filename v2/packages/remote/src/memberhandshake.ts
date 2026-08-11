import { createHash } from 'node:crypto';
import { FrameDecoder, MAX_FRAME_BYTES, encodeJsonFrame, type Frame } from '@shepherd/core';
import { REMOTE_PROTOCOL_VERSION, hostProofBytes, issueProof } from './join.ts';
import { verifyChain, type Credential } from './net.ts';
import { signWith, verifySignature } from './netcrypto.ts';
import type { Membership } from './netstore.ts';

/**
 * The handshake one member performs against another, in one place.
 *
 * There are now TWO things a Mac dials on another member — the control channel
 * (`memberclient.ts`, which invokes commands) and the data channel
 * (`membersession.ts`, which attaches to a pty) — and the door is identical for
 * both. Membership is the whole registration: a chain that reaches the net's
 * root is admitted with nothing shown to anybody, even if the other machine has
 * never seen this one.
 *
 * **Extracted rather than copied, and that is the point.** Two implementations
 * of "is this really a member of my net, holding the certificate it claims" are
 * two implementations that drift, and the one that drifts is the one that quietly
 * stops checking something. The four checks below are the entire security of
 * dialling an address out of a gossiped roster; a second copy of them is a second
 * chance to lose one.
 */

/**
 * The handshake's frame kinds, disjoint from the session protocol's (128+ vs
 * 1–68) so one decoder reads both and neither can become the other's type.
 */
export const REMOTE_KINDS = {
  hello: 128,
  accepted: 129,
  rejected: 130,
  pendingApproval: 131,
} as const;

export interface MemberHelloOptions {
  readonly membership: Membership;
  readonly deviceId: string;
  readonly deviceName: string;
  /** The sha256 of the certificate the peer just presented. See below. */
  readonly observedPin: string;
  readonly nonce: string;
  readonly now: number;
  /** What this Mac serves on, so the member can list it in its own roster. */
  readonly advertise?: { readonly port: number; readonly dataPort?: number };
}

/**
 * The hello a member sends.
 *
 * `observedPin` is LEARNED from the connection, not trusted: it is signed into
 * the proof so the peer can tell it reached the certificate it thinks it did,
 * and the `accepted` frame must then produce a credential naming that same
 * certificate or `checkMemberAccept` refuses. That round trip is what lets this
 * dial a roster address with no pin in hand.
 */
export function memberHelloFrame(options: MemberHelloOptions): Uint8Array {
  return encodeJsonFrame(REMOTE_KINDS.hello as never, {
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    publicKey: options.membership.memberKey.publicKey,
    certPin: '',
    nonce: options.nonce,
    pinVerified: true,
    ...(options.advertise === undefined ? {} : { advertise: options.advertise }),
    chain: options.membership.chain,
    proof: issueProof(
      { netId: options.membership.netId, hostPin: options.observedPin, at: options.now },
      signWith(options.membership.memberKey.privateKey),
    ),
  });
}

/** The sha256 of a certificate, as both ends name it. */
export function certPinOf(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Is this really a member of our net, holding the certificate it claims?
 *
 * Returns the reason it is NOT, or `undefined` when every check passed —
 * refusals are values here so a caller can put the member's own words in a log
 * rather than a summary of them.
 */
export function checkMemberAccept(
  frame: Frame,
  membership: Membership,
  nonce: string,
  observedPin: string,
): string | undefined {
  const body = frame.json as {
    netId?: string;
    rootPublicKey?: string;
    hostChain?: readonly Credential[];
    proof?: string;
  };
  if (body.netId !== membership.netId || body.rootPublicKey !== membership.rootPublicKey) {
    return 'that member belongs to a different net';
  }
  if (body.hostChain === undefined) return 'that member sent no membership of its own';
  const verdict = verifyChain({
    chain: body.hostChain,
    netId: membership.netId,
    rootPublicKey: membership.rootPublicKey,
    tombstoned: new Set(),
    verify: verifySignature,
  });
  if (!verdict.ok) return verdict.reason;
  if (body.proof === undefined) return 'that member did not prove it holds its own key';
  if (
    !verifySignature(
      verdict.member.publicKey,
      hostProofBytes({ netId: membership.netId, nonce }),
      body.proof,
    )
  ) {
    return 'that member could not prove it holds the key its membership names';
  }
  // The credential names the certificate it serves on, which is what makes
  // dialling a roster address with no pin in hand safe.
  if (verdict.member.certPin !== '' && verdict.member.certPin.toLowerCase() !== observedPin) {
    return 'that member’s certificate is not the one its membership names';
  }
  return undefined;
}

/**
 * One frame off the front of a buffer, and **the bytes that follow it**.
 *
 * This exists for one reason: on the data channel the handshake and the session
 * protocol share a socket, and the moment `accepted` arrives every subsequent
 * byte belongs to a different reader. `FrameDecoder` keeps its leftovers inside
 * itself, so feeding it the chunk that carries `accepted` would strand any
 * session frame that arrived in the same TCP segment inside a decoder the
 * session client does not own — a lost snapshot or a lost keystroke, appearing
 * only under the timing that packs two frames into one read.
 *
 * So the handover reads exactly one frame and hands the remainder on. The length
 * arithmetic is here; the DECODING is still core's, fed a slice of exactly one
 * frame, so there is no second implementation of the payload rules.
 */
export type SplitFrame =
  | { readonly kind: 'frame'; readonly frame: Frame; readonly rest: Uint8Array }
  /** Not enough bytes yet — keep accumulating and ask again. */
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'error'; readonly message: string };

export function splitFrame(bytes: Uint8Array): SplitFrame {
  if (bytes.length < 5) return { kind: 'incomplete' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, true);
  /**
   * Judged BEFORE waiting for the body, exactly as `FrameDecoder` does — and for
   * the same reason: a peer claiming `0xFFFFFFFF` must be refused rather than
   * accumulated toward. Answering "incomplete" here would buffer forever on a
   * frame that can never arrive, which is the memory denial-of-service
   * `MAX_FRAME_BYTES` exists to close. Found by the test, not by reading.
   */
  if (length > MAX_FRAME_BYTES) {
    return { kind: 'error', message: `frame claims ${length} bytes, cap is ${MAX_FRAME_BYTES}` };
  }
  if (length < 1) return { kind: 'error', message: 'a frame must carry at least a kind' };
  const total = 4 + length;
  if (bytes.length < total) return { kind: 'incomplete' };
  const decoder = new FrameDecoder();
  const { frames, error } = decoder.feed(bytes.subarray(0, total));
  if (error !== undefined) return { kind: 'error', message: `${error.code}: ${error.message}` };
  const frame = frames[0];
  if (frame === undefined) return { kind: 'error', message: 'a whole frame decoded to nothing' };
  return { kind: 'frame', frame, rest: bytes.subarray(total) };
}
