// Joining, asserted without a socket — which is the reason it is a pure module.
//
// The code and the SAS are carried over from pairing unchanged, and their tests
// with them: the ceremony was right, and only what it GRANTS has changed. What is
// new here is the returning member — a chain and a proof instead of a secret —
// and the refusals around it, which must each stay distinct for the reason the
// code's three refusals are distinct.

import { describe, expect, it } from 'vitest';
import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  PROOF_LIFETIME_MS,
  REMOTE_PROTOCOL_VERSION,
  codeState,
  freshCode,
  hostProofBytes,
  issueHostProof,
  issueProof,
  joinDecision,
  sasChoices,
  sasDigits,
  spendAttempt,
  type Hello,
} from './join.ts';
import { ROOT, issueCredential, type Credential } from './net.ts';

const CERT = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...new Array<number>(28).fill(0)]);
const HOST_PIN = 'host-cert-pin';
const NET = 'net-abc';
const ROOT_KEY = 'root-pub';
const NOW = 1_000_000;

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
      certPin: '',
      issuedAt: 0,
      issuer,
    },
    sign(signingKey),
  );

const chain = [credential('phone', 'mac-mini', 'mac-mini-pub'), credential('mac-mini', ROOT, ROOT_KEY)];

const hello = (over: Partial<Hello> = {}): Hello => ({
  deviceId: 'phone-1',
  deviceName: 'A Phone',
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  publicKey: 'phone-pub',
  nonce: 'client-nonce',
  ...over,
});

/** A returning member: its chain, plus a proof it holds the key the chain names. */
const returning = (over: Partial<Hello> = {}, at = NOW): Hello =>
  hello({
    chain,
    proof: issueProof({ netId: NET, hostPin: HOST_PIN, at }, sign('phone-pub')),
    ...over,
  });

const decide = (over: Partial<Parameters<typeof joinDecision>[0]> = {}) =>
  joinDecision({
    hello: hello(),
    net: { netId: NET, rootPublicKey: ROOT_KEY, revoked: new Set<string>() },
    code: freshCode('123456', NOW),
    now: NOW,
    certSha256: CERT,
    hostPin: HOST_PIN,
    verify,
    ...over,
  });

describe('the pairing code', () => {
  it('is usable for five minutes and three attempts', () => {
    const code = freshCode('123456', NOW);
    expect(code.attemptsLeft).toBe(CODE_ATTEMPTS);
    expect(codeState(code, NOW + CODE_LIFETIME_MS)).toBe('usable');
    expect(codeState(code, NOW + CODE_LIFETIME_MS + 1)).toBe('expired');
  });

  it('is exhausted by a third wrong attempt, and says so distinctly', () => {
    let code = freshCode('123456', NOW);
    for (let i = 0; i < CODE_ATTEMPTS; i += 1) code = spendAttempt(code);
    expect(codeState(code, NOW)).toBe('exhausted');
    expect(codeState(code, NOW)).not.toBe('expired');
  });
});

describe('the SAS', () => {
  it('is six digits from the first four bytes of the certificate hash', () => {
    expect(sasDigits(CERT)).toBe(String(0x12345678 % 1_000_000).padStart(6, '0'));
  });

  it('places the real answer among decoys at a caller-chosen index', () => {
    expect(sasChoices('111111', ['222222', '333333'], 1)).toEqual(['222222', '111111', '333333']);
  });
});

/**
 * The other direction. A client must know it reached the Mac it meant to, and
 * under a net that is no longer "the certificate I pinned" — it is "a member of
 * my net, holding the key its credential names". The nonce is the client's, so
 * the answer cannot be a recording of an earlier one.
 */
describe('the host proving itself back', () => {
  it('signs the nonce the client sent, bound to the net', () => {
    const proof = issueHostProof({ netId: NET, nonce: 'client-nonce' }, sign('mac-mini-pub'));
    expect(verify('mac-mini-pub', hostProofBytes({ netId: NET, nonce: 'client-nonce' }), proof)).toBe(true);
    // Another nonce, or another net, is a different statement.
    expect(verify('mac-mini-pub', hostProofBytes({ netId: NET, nonce: 'other' }), proof)).toBe(false);
    expect(verify('mac-mini-pub', hostProofBytes({ netId: 'other-net', nonce: 'client-nonce' }), proof)).toBe(false);
  });
});

describe('joinDecision — a returning member', () => {
  /**
   * The whole point: this device has a chain that reaches the net's root, and
   * this Mac has never seen it. No code, no approval, nothing showing on screen.
   */
  it('admits a member this Mac has never met', () => {
    const answer = decide({ hello: returning(), code: undefined });
    expect(answer.kind).toBe('accept');
    if (answer.kind !== 'accept') return;
    expect(answer.member.memberId).toBe('phone');
  });

  /**
   * A chain is public — it travels to every member. Possession of the key it
   * names is what makes it this device's chain rather than a copy of somebody
   * else's, so the proof is not optional.
   */
  it('refuses a chain presented without a proof of the key it names', () => {
    const answer = decide({ hello: returning({ proof: undefined }), code: undefined });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('proof');
  });

  it('refuses a proof signed by some other key', () => {
    const answer = decide({
      hello: returning({ proof: issueProof({ netId: NET, hostPin: HOST_PIN, at: NOW }, sign('thief-pub')) }),
      code: undefined,
    });
    expect(answer.kind).toBe('reject');
  });

  /**
   * The proof names the host it was made for, so one captured on the laptop
   * cannot be replayed at the Mac mini.
   */
  it('refuses a proof made for a different host', () => {
    const answer = decide({
      hello: returning({
        proof: issueProof({ netId: NET, hostPin: 'another-macs-pin', at: NOW }, sign('phone-pub')),
      }),
      code: undefined,
    });
    expect(answer.kind).toBe('reject');
  });

  it('refuses a stale proof', () => {
    const answer = decide({ hello: returning({}, NOW - PROOF_LIFETIME_MS - 1), code: undefined });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('stale');
  });

  it('refuses a revoked member, naming revocation rather than a bad signature', () => {
    const answer = decide({
      hello: returning(),
      net: { netId: NET, rootPublicKey: ROOT_KEY, revoked: new Set(['phone']) },
      code: undefined,
    });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('revoked');
  });

  /**
   * The ordering rule, carried over from pairing: a member returning must never
   * consume an attempt on a code the user is still typing.
   */
  it('does NOT spend a code attempt when a chain fails to check out', () => {
    const answer = decide({ hello: returning({ chain: [chain[0] as Credential] }) });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.spendsAttempt).toBe(false);
  });
});

describe('joinDecision — a device with no membership', () => {
  it('asks for approval on the right code, and shows digits to compare', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456' }) });
    expect(answer.kind).toBe('admit');
    if (answer.kind !== 'admit') return;
    expect(answer.sas).toBe(sasDigits(CERT));
    expect(answer.candidate.publicKey).toBe('phone-pub');
  });

  it('skips the digits when the client enforced a pin it already had', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456', pinVerified: true }) });
    expect(answer.kind).toBe('admit');
    if (answer.kind !== 'admit') return;
    expect(answer.sas).toBeUndefined();
  });

  it('spends an attempt on a wrong code, and only then', () => {
    const answer = decide({ hello: hello({ pairingCode: '000000' }) });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.spendsAttempt).toBe(true);
  });

  it('refuses an expired code without spending an attempt on it', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456' }), now: NOW + CODE_LIFETIME_MS + 1 });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('expired');
    expect(answer.spendsAttempt).toBe(false);
  });

  /**
   * A credential names a key, so there is nothing to issue one over. Refused
   * before the code is even looked at, since an approval that cannot produce a
   * membership is a human asked a pointless question.
   */
  it('refuses a joiner that sent no signing key', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456', publicKey: undefined }) });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('key');
    expect(answer.spendsAttempt).toBe(false);
  });
});

describe('joinDecision — refusals that come before anything else', () => {
  it('refuses a protocol it does not speak, naming both versions', () => {
    const answer = decide({ hello: hello({ protocolVersion: REMOTE_PROTOCOL_VERSION + 5 }) });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain(String(REMOTE_PROTOCOL_VERSION));
    expect(answer.reason).toContain(String(REMOTE_PROTOCOL_VERSION + 5));
  });

  it('refuses a device that sends no id', () => {
    expect(decide({ hello: hello({ deviceId: '' }) }).kind).toBe('reject');
  });

  /** A Mac serving no net has nothing to admit anyone TO. */
  it('refuses everything when this Mac is in no net', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456' }), net: undefined });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('net');
    expect(answer.spendsAttempt).toBe(false);
  });
});
