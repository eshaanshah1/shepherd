import { verifyChain, type Credential, type Sign, type Verify } from './net.ts';

/**
 * Joining a shep-net: everything decidable without a socket.
 *
 * Ported from the pairwise `pairing.ts` this replaces, and **the ceremony comes
 * with it unchanged** — it was right, and only what it GRANTS has changed. The
 * two halves, and conflating them is how short-code pairing gets broken:
 *
 *   - The **code** AUTHORIZES. Six digits shown on the admitting device, and all
 *     it proves is that a human is standing at it. It is short because a person
 *     types it, which is exactly why it cannot also secure the channel.
 *   - The **SAS** AUTHENTICATES. Digits derived from the certificate both ends
 *     actually negotiated, so a man in the middle — who necessarily presented a
 *     different certificate — produces different digits. The host shows THREE
 *     candidates and the user picks the joiner's: an "Allow?" button gets pressed
 *     without looking; picking one of three cannot be satisfied without reading
 *     the other screen.
 *
 * **What is new is the returning member.** It presents a credential chain instead
 * of a secret this Mac issued it, which is what lets a device this Mac has never
 * seen be admitted with no ceremony at all. A chain is public, though — it
 * travels to every member — so it is accompanied by a **proof**: a signature,
 * with the member's own key, over the net id, THIS HOST'S certificate pin, and a
 * timestamp. The host pin is the channel binding: a proof captured against the
 * laptop is meaningless at the Mac mini, because it names the laptop.
 *
 * Nothing bearer-shaped survives from the old model. `secret` and `pin` are gone.
 */

/** Bumped because the handshake changed shape; messages stay additive otherwise. */
export const REMOTE_PROTOCOL_VERSION = 4;

/** Five minutes, three attempts, one device. */
export const CODE_LIFETIME_MS = 5 * 60 * 1000;
export const CODE_ATTEMPTS = 3;

/**
 * How long a proof is good for, in either direction.
 *
 * Symmetric because the two clocks are not synchronized and neither is
 * authoritative; a minute is far longer than a handshake and far shorter than a
 * useful replay window.
 */
export const PROOF_LIFETIME_MS = 60_000;

export interface PairingCode {
  readonly digits: string;
  readonly issuedAt: number;
  readonly attemptsLeft: number;
}

export function freshCode(digits: string, now: number): PairingCode {
  return { digits, issuedAt: now, attemptsLeft: CODE_ATTEMPTS };
}

/**
 * Why a code is unusable, as a value.
 *
 * Expiry and attempt-exhaustion are DIFFERENT refusals, deliberately: to
 * somebody holding a phone, "that code has expired" and "too many tries" call for
 * different actions, and a single "invalid" makes both look like a typo.
 */
export type CodeState = 'usable' | 'expired' | 'exhausted';

export function codeState(code: PairingCode | undefined, now: number): CodeState | 'absent' {
  if (code === undefined) return 'absent';
  if (code.attemptsLeft <= 0) return 'exhausted';
  if (now - code.issuedAt > CODE_LIFETIME_MS) return 'expired';
  return 'usable';
}

/** One spent attempt. Returns the code so the caller stores what it gets back. */
export function spendAttempt(code: PairingCode): PairingCode {
  return { ...code, attemptsLeft: Math.max(0, code.attemptsLeft - 1) };
}

/**
 * Six digits from the first four bytes of the certificate's SHA-256.
 *
 * The DER of the whole certificate is the one representation every client can
 * produce identically — `SecCertificateCopyData` in v1, `cert.encoded` on
 * Android, `X509Certificate.raw` here — so the digits match without anybody
 * agreeing on a serialization.
 */
export function sasDigits(certSha256: Uint8Array): string {
  const n =
    ((certSha256[0] ?? 0) << 24) |
    ((certSha256[1] ?? 0) << 16) |
    ((certSha256[2] ?? 0) << 8) |
    (certSha256[3] ?? 0);
  return String((n >>> 0) % 1_000_000).padStart(6, '0');
}

/** The real SAS among decoys, at a caller-chosen index. Randomness stays out. */
export function sasChoices(real: string, decoys: readonly string[], insertAt: number): string[] {
  const out = [...decoys];
  out.splice(Math.min(Math.max(0, insertAt), out.length), 0, real);
  return out;
}

export interface Proof {
  readonly at: number;
  readonly signature: string;
}

/** What a proof signs: the net, the host it is FOR, and when it was made. */
export function proofBytes(fields: { netId: string; hostPin: string; at: number }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(['shepherd-net-proof-v1', fields.netId, fields.hostPin, fields.at]),
  );
}

export function issueProof(fields: { netId: string; hostPin: string; at: number }, sign: Sign): Proof {
  return { at: fields.at, signature: sign(proofBytes(fields)) };
}

/**
 * What the HOST signs to prove itself back: the net, and the client's nonce.
 *
 * A nonce rather than a timestamp because this direction has one — the client
 * just chose it — and a value the verifier picked cannot be answered with a
 * recording. The client's own proof cannot work that way: it speaks first, so it
 * has no nonce from us to sign, and a timestamp bound to our certificate pin is
 * the closest thing available to it.
 */
export function hostProofBytes(fields: { netId: string; nonce: string }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(['shepherd-net-host-proof-v1', fields.netId, fields.nonce]),
  );
}

export function issueHostProof(fields: { netId: string; nonce: string }, sign: Sign): string {
  return sign(hostProofBytes(fields));
}

/** What a client says first. */
export interface Hello {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly protocolVersion: number;
  /** A member returning: its chain, leaf first. */
  readonly chain?: readonly Credential[];
  /** Possession of the key the chain names. Required with a chain. */
  readonly proof?: Proof;
  /** First contact only. */
  readonly pairingCode?: string;
  /** The joiner's member signing key, hex SPKI — what its credential will name. */
  readonly publicKey?: string;
  /** The joiner's own TLS certificate pin, when it serves. Empty when it does not. */
  readonly certPin?: string;
  /**
   * The client already held our certificate pin and ENFORCED it during the
   * handshake rather than learning it.
   *
   * With a pin, a man in the middle was refused at the handshake, so there is
   * nothing left for a human to compare — and asking anyway trains people to
   * confirm digits they have not read. Absent behaves as `false`.
   */
  readonly pinVerified?: boolean;
  /** Random from the client; the host signs it back so the client can check US. */
  readonly nonce?: string;
}

/** This Mac's net, as the decision needs it. */
export interface NetState {
  readonly netId: string;
  readonly rootPublicKey: string;
  readonly revoked: ReadonlySet<string>;
}

/** Who a credential would be issued to, once a human approves. */
export interface Candidate {
  readonly memberId: string;
  readonly name: string;
  readonly publicKey: string;
  readonly certPin: string;
}

export type JoinDecision =
  /** A member of this net, proven. Nothing is shown to anybody. */
  | { readonly kind: 'accept'; readonly member: Credential }
  /** A human must confirm. `sas` is absent when the client pinned us. */
  | { readonly kind: 'admit'; readonly candidate: Candidate; readonly sas?: string }
  | { readonly kind: 'reject'; readonly reason: string; readonly spendsAttempt: boolean };

export interface JoinInput {
  readonly hello: Hello;
  /** Undefined when this Mac is in no net — then there is nothing to admit to. */
  readonly net: NetState | undefined;
  readonly code: PairingCode | undefined;
  readonly now: number;
  /** SHA-256 of our certificate DER, for the digits a human compares. */
  readonly certSha256: Uint8Array;
  /** The same digest as hex — what a proof is bound to. */
  readonly hostPin: string;
  readonly verify: Verify;
}

/**
 * The whole handshake decision, as one function.
 *
 * Order is load-bearing, and it is the order the pairwise model arrived at after
 * getting it wrong: a device claiming MEMBERSHIP is resolved before the code is
 * consulted, so a member reconnecting in the background never spends an attempt
 * on a code the user is still typing. v1 spent the attempt first, and a code
 * would stop working for reasons nothing on screen explained.
 */
export function joinDecision(input: JoinInput): JoinDecision {
  const { hello, net, code, now, certSha256, hostPin, verify } = input;

  if (hello.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    return refuse(
      `this Mac speaks remote protocol ${REMOTE_PROTOCOL_VERSION}, the device speaks ${hello.protocolVersion}`,
    );
  }
  if (hello.deviceId === '') return refuse('the device sent no id');
  if (net === undefined) return refuse('this Mac is not in a shep-net yet');

  // A device claiming membership. Resolved either way here — a chain that does
  // not check out is NOT then offered the pairing flow, because answering a
  // failed membership claim with a code prompt is how a guessed identity gets to
  // burn somebody else's code.
  if (hello.chain !== undefined) {
    const verdict = verifyChain({
      chain: hello.chain,
      netId: net.netId,
      rootPublicKey: net.rootPublicKey,
      tombstoned: net.revoked,
      verify,
    });
    if (!verdict.ok) return refuse(verdict.reason);

    if (hello.proof === undefined) return refuse('that membership came with no proof it belongs to this device');
    if (Math.abs(now - hello.proof.at) > PROOF_LIFETIME_MS) {
      return refuse('that proof of membership is stale — the two clocks are too far apart');
    }
    const signed = proofBytes({ netId: net.netId, hostPin, at: hello.proof.at });
    if (!verify(verdict.member.publicKey, signed, hello.proof.signature)) {
      return refuse('that membership was not proven by the device presenting it');
    }
    return { kind: 'accept', member: verdict.member };
  }

  // First contact. A credential names a key, so a joiner with none cannot be
  // issued one — refused before the code is looked at, since an approval that
  // cannot produce a membership is a human asked a pointless question.
  if (hello.publicKey === undefined || hello.publicKey === '') {
    return refuse('the device sent no signing key to issue a membership over');
  }

  const state = codeState(code, now);
  if (state !== 'usable') {
    return refuse(
      state === 'expired'
        ? 'the pairing code has expired — show a new one'
        : state === 'exhausted'
          ? 'too many attempts on that pairing code — show a new one'
          : 'no pairing code is active on this Mac',
    );
  }
  if (hello.pairingCode === undefined || hello.pairingCode !== code?.digits) {
    return { kind: 'reject', reason: 'wrong pairing code', spendsAttempt: true };
  }

  const candidate: Candidate = {
    memberId: hello.deviceId,
    name: hello.deviceName === '' ? 'a device' : hello.deviceName,
    publicKey: hello.publicKey,
    certPin: hello.certPin ?? '',
  };
  return hello.pinVerified === true
    ? { kind: 'admit', candidate }
    : { kind: 'admit', candidate, sas: sasDigits(certSha256) };
}

function refuse(reason: string): JoinDecision {
  return { kind: 'reject', reason, spendsAttempt: false };
}
