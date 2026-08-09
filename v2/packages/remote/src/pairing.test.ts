// Pairing, asserted without a socket — which is the reason it is a pure module.
//
// The cases that matter are refusals, and each one is a DIFFERENT refusal on
// purpose: to somebody holding a phone, "expired", "too many tries" and "wrong
// code" call for three different actions, and a single "invalid" makes all three
// look like a typo.

import { describe, expect, it } from 'vitest';
import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  REMOTE_PROTOCOL_VERSION,
  codeState,
  freshCode,
  pairingDecision,
  sasChoices,
  sasDigits,
  spendAttempt,
  type Hello,
  type PairedDevice,
} from './pairing.ts';

const CERT = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...new Array<number>(28).fill(0)]);
const NOW = 1_000_000;

const hello = (over: Partial<Hello> = {}): Hello => ({
  deviceId: 'phone-1',
  deviceName: 'A Phone',
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  ...over,
});

const decide = (over: Partial<Parameters<typeof pairingDecision>[0]> = {}) =>
  pairingDecision({
    hello: hello(),
    devices: [],
    code: freshCode('123456', NOW),
    now: NOW,
    newSecret: 'secret-1',
    certSha256: CERT,
    ...over,
  });

const paired: PairedDevice = {
  id: 'phone-1',
  name: 'A Phone',
  secret: 'secret-1',
  pin: 'abc',
  pairedAt: NOW - 1000,
  lastSeenAt: NOW - 1000,
};

describe('the pairing code', () => {
  it('is usable for five minutes and three attempts', () => {
    const code = freshCode('123456', NOW);
    expect(code.attemptsLeft).toBe(CODE_ATTEMPTS);
    expect(codeState(code, NOW)).toBe('usable');
    expect(codeState(code, NOW + CODE_LIFETIME_MS)).toBe('usable');
    expect(codeState(code, NOW + CODE_LIFETIME_MS + 1)).toBe('expired');
  });

  it('is exhausted by a third wrong attempt, and says so distinctly', () => {
    let code = freshCode('123456', NOW);
    for (let i = 0; i < CODE_ATTEMPTS; i += 1) code = spendAttempt(code);
    expect(codeState(code, NOW)).toBe('exhausted');
    // Not 'expired': the two are different things to the person holding a phone.
    expect(codeState(code, NOW)).not.toBe('expired');
  });

  it('reports no code at all as its own state', () => {
    expect(codeState(undefined, NOW)).toBe('absent');
  });
});

describe('the SAS', () => {
  it('is six digits from the first four bytes of the certificate hash', () => {
    // 0x12345678 mod 1e6, zero padded — the same arithmetic v1 and the Android
    // client already do, so the digits agree with no shared serialization.
    expect(sasDigits(CERT)).toBe(String(0x12345678 % 1_000_000).padStart(6, '0'));
    expect(sasDigits(CERT)).toHaveLength(6);
  });

  it('pads a small value rather than showing four digits', () => {
    expect(sasDigits(new Uint8Array([0, 0, 0, 7]))).toBe('000007');
  });

  it('places the real answer among decoys at a caller-chosen index', () => {
    expect(sasChoices('111111', ['222222', '333333'], 1)).toEqual(['222222', '111111', '333333']);
    // Clamped rather than throwing: an out-of-range index is a caller bug, and
    // refusing to show a pairing sheet is a worse outcome than showing it.
    expect(sasChoices('111111', ['222222'], 99)).toEqual(['222222', '111111']);
  });
});

describe('pairingDecision', () => {
  it('refuses a protocol it does not speak, naming both versions', () => {
    const answer = decide({ hello: hello({ protocolVersion: REMOTE_PROTOCOL_VERSION + 5 }) });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain(String(REMOTE_PROTOCOL_VERSION));
    expect(answer.reason).toContain(String(REMOTE_PROTOCOL_VERSION + 5));
    expect(answer.spendsAttempt).toBe(false);
  });

  it('accepts a known device presenting its secret, with no code involved', () => {
    const answer = decide({
      hello: hello({ secret: 'secret-1' }),
      devices: [paired],
      code: undefined, // no code is showing, and none is needed
      now: NOW + 5_000,
    });
    expect(answer.kind).toBe('accept');
    if (answer.kind !== 'accept') return;
    expect(answer.returning).toBe(true);
    expect(answer.device.lastSeenAt).toBe(NOW + 5_000);
  });

  /**
   * The ordering fix. v1 spent an attempt before checking identity, so a paired
   * phone reconnecting in the background could exhaust a code the user was still
   * typing — the code would stop working for reasons nothing on screen explained.
   */
  it('does NOT spend a code attempt on a known device with a bad secret', () => {
    const answer = decide({ hello: hello({ secret: 'wrong' }), devices: [paired] });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.spendsAttempt).toBe(false);
    expect(answer.reason).toContain('did not present the secret');
  });

  it('asks for approval on first contact with the right code, and shows digits', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456' }) });
    expect(answer.kind).toBe('needsApproval');
    if (answer.kind !== 'needsApproval') return;
    expect(answer.sas).toBe(sasDigits(CERT));
    expect(answer.device.secret).toBe('secret-1');
  });

  /**
   * With a pin there is nothing left to compare: a man in the middle was refused
   * at the handshake. Asking anyway teaches people to confirm digits they have
   * not read, which is the failure the digits exist to prevent.
   */
  it('skips the digits when the client enforced a pin it already had', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456', pinVerified: true }) });
    expect(answer.kind).toBe('needsApproval');
    if (answer.kind !== 'needsApproval') return;
    expect(answer.sas).toBeUndefined();
  });

  it('spends an attempt on a wrong code, and only then', () => {
    const wrong = decide({ hello: hello({ pairingCode: '000000' }) });
    expect(wrong.kind).toBe('reject');
    if (wrong.kind !== 'reject') return;
    expect(wrong.spendsAttempt).toBe(true);
  });

  it('refuses an expired code without spending an attempt on it', () => {
    const answer = decide({
      hello: hello({ pairingCode: '123456' }),
      now: NOW + CODE_LIFETIME_MS + 1,
    });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('expired');
    expect(answer.spendsAttempt).toBe(false);
  });

  it('refuses when no code is showing at all', () => {
    const answer = decide({ hello: hello({ pairingCode: '123456' }), code: undefined });
    expect(answer.kind).toBe('reject');
    if (answer.kind !== 'reject') return;
    expect(answer.reason).toContain('no pairing code');
  });

  it('lets a revoked device pair again, as a stranger', () => {
    // Revocation drops the record, so the device is simply unknown — it needs a
    // code and an approval, exactly like a phone nobody has seen.
    const answer = decide({ hello: hello({ secret: 'secret-1', pairingCode: '123456' }), devices: [] });
    expect(answer.kind).toBe('needsApproval');
  });

  it('refuses a device that sends no id', () => {
    const answer = decide({ hello: hello({ deviceId: '' }) });
    expect(answer.kind).toBe('reject');
  });
});
