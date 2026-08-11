// The join payload: everything a device needs to join, as ONE string a QR can
// carry and a person can paste.
//
// The cases that matter are the malformed ones. A half-understood payload must
// be a refusal that says what is missing, never a join attempt that fails later
// against a Mac that cannot explain why.

import { describe, expect, it } from 'vitest';
import { generateMemberKey, netIdOf } from './netcrypto.ts';
import { encodeJoinURI, parseJoinURI, type PairingPayload } from './payload.ts';

// A real key and its real id: the payload asserts they agree, so a fabricated
// pair would only ever exercise the refusal.
const root = generateMemberKey().publicKey;

const payload: PairingPayload = {
  host: '192.168.1.7',
  port: 8723,
  dataPort: 8724,
  pin: 'ab'.repeat(32),
  code: '424242',
  netId: netIdOf(root),
  netName: "Eshaan's net",
  rootPublicKey: root,
  protocolVersion: 4,
};

describe('a join payload', () => {
  it('round-trips through one URI', () => {
    expect(parseJoinURI(encodeJoinURI(payload))).toEqual(payload);
  });

  it('survives a net name with spaces and punctuation', () => {
    const named = { ...payload, netName: 'Home & Away / 2' };
    expect(parseJoinURI(encodeJoinURI(named))?.netName).toBe('Home & Away / 2');
  });

  it('omits what is absent rather than encoding an empty one', () => {
    const { code: _code, dataPort: _dataPort, ...rest } = payload;
    const uri = encodeJoinURI(rest);
    expect(uri).not.toContain('code=');
    expect(uri).not.toContain('data=');
    expect(parseJoinURI(uri)).toEqual(rest);
  });

  /**
   * The four that make a join possible at all. Missing any of them and the
   * device would dial, be refused, and have nothing to tell the user — so it is
   * refused HERE, where the missing field can be named.
   */
  it.each(['host', 'pin', 'net', 'root'])('refuses a payload with no %s', (field) => {
    const uri = encodeJoinURI(payload);
    const stripped = uri.replace(new RegExp(`[?&]${field}=[^&]*`), (m) => (m[0] === '?' ? '?' : ''));
    expect(parseJoinURI(stripped)).toBeUndefined();
  });

  it('refuses a net id that is not the hash of the root key it carries', () => {
    // The two check each other, so a payload that names one net and carries
    // another net's key is caught before a single byte is sent.
    expect(parseJoinURI(encodeJoinURI({ ...payload, netId: '00'.repeat(32) }))).toBeUndefined();
  });

  it('refuses something that is not a shepherd join link at all', () => {
    expect(parseJoinURI('https://example.com/join?host=1.2.3.4')).toBeUndefined();
    expect(parseJoinURI('nonsense')).toBeUndefined();
    expect(parseJoinURI('')).toBeUndefined();
  });

  it('refuses a protocol version this build does not speak', () => {
    expect(parseJoinURI(encodeJoinURI({ ...payload, protocolVersion: 3 }))).toBeUndefined();
  });

  it('refuses a port that is not a port', () => {
    expect(parseJoinURI(encodeJoinURI(payload).replace('port=8723', 'port=nope'))).toBeUndefined();
  });
});
