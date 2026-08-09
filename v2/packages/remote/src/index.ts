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
export {
  loadOrMintIdentity,
  resetIdentity,
  peerMatchesPin,
  pinOf,
  type Identity,
  type IdentityOptions,
  type Minter,
} from './identity.ts';
export {
  loopbackEndpoint,
  type Endpoint,
  type Listening,
  type LoopbackOptions,
  type RemoteConnection,
} from './endpoint.ts';
export {
  REMOTE,
  RemoteServer,
  type Approval,
  type DeviceStore,
  type RemoteServerOptions,
  type SessionSink,
} from './server.ts';
export { CONTROL, ControlChannel, type ControlChannelOptions, type ControlHost } from './control.ts';
export type {
  PairingPayload,
  PairingRequest,
  PairingRequestHandler,
  RemoteAPI,
} from './api.ts';
