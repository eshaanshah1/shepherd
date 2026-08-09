/**
 * Pairing: everything decidable without a socket.
 *
 * Ported from v1's `LANIdentity.swift` + `pairingDecision`, and the discipline
 * comes with it — **randomness stays out of the model**. Codes, secrets and
 * decoys are passed IN, so every decision here is a pure function a test can
 * pin without stubbing a generator.
 *
 * **The two halves are different jobs, and conflating them is how short-code
 * pairing gets broken:**
 *
 *   - The **code** AUTHORIZES. Six digits shown on the host, and all it proves
 *     is that a human is standing at the machine. It is short because a person
 *     types it, which is exactly why it cannot also be the thing that secures
 *     the channel.
 *   - The **SAS** AUTHENTICATES. Digits derived from the certificate both ends
 *     actually negotiated, so a man in the middle — who necessarily presented a
 *     different certificate — produces different digits.
 *
 * v1's other finding is kept because it is about people rather than crypto: the
 * host shows THREE candidate digit groups and the user picks the client's. An
 * "Allow?" button gets pressed without looking; picking one of three cannot be
 * satisfied without reading the phone.
 */

/** Bumped on a breaking change; messages stay additive otherwise. */
export const REMOTE_PROTOCOL_VERSION = 3;

/** Five minutes, three attempts, one device. */
export const CODE_LIFETIME_MS = 5 * 60 * 1000;
export const CODE_ATTEMPTS = 3;

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
 * somebody holding a phone, "that code has expired" and "too many tries" call
 * for different actions, and a single "invalid" message makes both look like a
 * typo.
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

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  /** What a returning device presents. The CODE is only ever used once. */
  readonly secret: string;
  /** The certificate hash this device pinned, hex. */
  readonly pin: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
}

/** What a client says first. Byte-compatible in spirit with v1's `Hello`. */
export interface Hello {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly protocolVersion: number;
  /** First contact only. */
  readonly pairingCode?: string;
  /** Every later contact. */
  readonly secret?: string;
  /**
   * The client already held our certificate hash (from a QR) and ENFORCED it
   * during the handshake rather than learning it.
   *
   * With a pin, a man in the middle was refused at the handshake, so there is
   * nothing left for a human to compare — and asking anyway trains people to
   * confirm digits they have not read. Absent behaves as `false`, so an older
   * client is unaffected.
   */
  readonly pinVerified?: boolean;
}

export type PairingDecision =
  | { readonly kind: 'accept'; readonly device: PairedDevice; readonly returning: boolean }
  /** A human must confirm. `sas` is absent when the client pinned us. */
  | { readonly kind: 'needsApproval'; readonly device: PairedDevice; readonly sas?: string }
  | { readonly kind: 'reject'; readonly reason: string; readonly spendsAttempt: boolean };

export interface PairingInput {
  readonly hello: Hello;
  readonly devices: readonly PairedDevice[];
  readonly code: PairingCode | undefined;
  readonly now: number;
  /** Minted by the caller — see the file comment. */
  readonly newSecret: string;
  /** SHA-256 of our certificate DER, for the digits a human compares. */
  readonly certSha256: Uint8Array;
}

/**
 * The whole handshake decision, as one function.
 *
 * Order is load-bearing. A KNOWN device is checked before the code, so a paired
 * phone reconnecting never consumes an attempt on a code it is not using — v1
 * spent attempts before the identity check, and a background reconnect could
 * therefore exhaust a code the user was still typing.
 */
export function pairingDecision(input: PairingInput): PairingDecision {
  const { hello, devices, code, now, newSecret, certSha256 } = input;

  if (hello.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    return {
      kind: 'reject',
      reason: `this Mac speaks remote protocol ${REMOTE_PROTOCOL_VERSION}, the device speaks ${hello.protocolVersion}`,
      spendsAttempt: false,
    };
  }
  if (hello.deviceId === '') {
    return { kind: 'reject', reason: 'the device sent no id', spendsAttempt: false };
  }

  // A device we already know, presenting the secret we issued it.
  const known = devices.find((device) => device.id === hello.deviceId);
  if (known !== undefined) {
    if (hello.secret !== undefined && hello.secret === known.secret) {
      return { kind: 'accept', device: { ...known, lastSeenAt: now }, returning: true };
    }
    // Known id, wrong secret. NOT an attempt against the code: it is a claim
    // about an identity, and answering it with the pairing flow would let anyone
    // who guesses a device id burn somebody else's code.
    return {
      kind: 'reject',
      reason: 'that device is paired, but did not present the secret it was issued',
      spendsAttempt: false,
    };
  }

  // First contact: the code is the only thing that can authorize it.
  const state = codeState(code, now);
  if (state !== 'usable') {
    const reason =
      state === 'expired'
        ? 'the pairing code has expired — show a new one'
        : state === 'exhausted'
          ? 'too many attempts on that pairing code — show a new one'
          : 'no pairing code is active on this Mac';
    return { kind: 'reject', reason, spendsAttempt: false };
  }
  if (hello.pairingCode === undefined || hello.pairingCode !== code?.digits) {
    return { kind: 'reject', reason: 'wrong pairing code', spendsAttempt: true };
  }

  const device: PairedDevice = {
    id: hello.deviceId,
    name: hello.deviceName === '' ? 'a device' : hello.deviceName,
    secret: newSecret,
    pin: '',
    pairedAt: now,
    lastSeenAt: now,
  };
  return hello.pinVerified === true
    ? { kind: 'needsApproval', device }
    : { kind: 'needsApproval', device, sas: sasDigits(certSha256) };
}
