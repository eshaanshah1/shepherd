// The remote library. The net's trust core (`net`, `join`, `roster`) is pure and
// lands first; identity, the store, the server and the endpoints build on it.
export {
  ROOT,
  MAX_CHAIN,
  credentialBytes,
  issueCredential,
  verifyChain,
  type ChainInput,
  type ChainVerdict,
  type Credential,
  type Sign,
  type Verify,
} from './net.ts';
export {
  generateMemberKey,
  netIdOf,
  signWith,
  verifySignature,
  type MemberKey,
} from './netcrypto.ts';
export {
  REMOTE_PROTOCOL_VERSION,
  CODE_LIFETIME_MS,
  CODE_ATTEMPTS,
  PROOF_LIFETIME_MS,
  codeState,
  freshCode,
  hostProofBytes,
  issueHostProof,
  issueProof,
  joinDecision,
  proofBytes,
  sasChoices,
  sasDigits,
  spendAttempt,
  type Candidate,
  type CodeState,
  type Hello,
  type JoinDecision,
  type JoinInput,
  type NetState,
  type PairingCode,
  type Proof,
} from './join.ts';
export {
  issueTombstone,
  mergeEntries,
  mergeTombstones,
  revokedIds,
  tombstoneBytes,
  verifyTombstone,
  type RosterEntry,
  type Tombstone,
  type TombstoneCheck,
} from './roster.ts';
export { foundNet, kvNetStore, type Membership, type NetStore } from './netstore.ts';
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
  wifiEndpoint,
  localAddress,
  type Endpoint,
  type Listening,
  type LoopbackOptions,
  type RemoteConnection,
} from './endpoint.ts';
export {
  REMOTE,
  RemoteServer,
  type AdmittedMember,
  type Approval,
  type RemoteServerOptions,
  type SessionSink,
} from './server.ts';
export { CONTROL, ControlChannel, controlSink, type ControlChannelOptions, type ControlHost } from './control.ts';
export type { JoinRequest, JoinRequestHandler, NetSummary, RemoteAPI } from './api.ts';
export {
  JOIN_SCHEME,
  encodeJoinURI,
  parseJoinURI,
  type PairingPayload,
} from './payload.ts';

export {
  registerTransport,
  resolveTransport,
  transportNames,
  type EndpointFactory,
} from './transports.ts';
