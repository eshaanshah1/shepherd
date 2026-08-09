// The remote library. Pairing and identity are pure/near-pure and land first;
// the server and the endpoints build on them.
export {
  REMOTE_PROTOCOL_VERSION,
  CODE_LIFETIME_MS,
  CODE_ATTEMPTS,
  codeState,
  freshCode,
  pairingDecision,
  sasChoices,
  sasDigits,
  spendAttempt,
  type CodeState,
  type Hello,
  type PairedDevice,
  type PairingCode,
  type PairingDecision,
  type PairingInput,
} from './pairing.ts';
