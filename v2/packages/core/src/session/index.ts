// The session half of the kernel: the terminal mirror (the host's authoritative
// screen), the record-and-fan-out seam over it, the pure resize arbitration, and
// `SessionHost` — the registry of live PTYs that owns one `PtyFanout` each and
// carries the `onWillCreate` env-injection seam.
export {
  TerminalMirror,
  DEFAULT_SCROLLBACK,
  type ObservedPatch,
  type ScreenState,
  type TerminalMirrorOptions,
} from './mirror.ts';
export { cwdFromOsc7, isShellPromptTitle } from './osc.ts';
export { arbitrate, type Viewport } from './viewport.ts';
export { PtyFanout, type PtySink } from './fanout.ts';
export {
  SessionHost,
  resolveSpec,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_TERM,
  type ResolvedSpec,
  type SessionError,
  type SessionErrorCode,
  type SessionExit,
  type SessionObserved,
  type SessionResize,
  type SessionHostOptions,
  type SessionInfo,
  type SessionSpec,
  type WillCreateEvent,
  type WillCreateHook,
  type WillCreatePatch,
  foregroundReading,
  type ForegroundReading,
} from './host.ts';
export {
  registerSessionCommands,
  principalOf,
  SESSION_COMMANDS,
  type SessionCommandsOptions,
  type ViewerSink,
} from './commands.ts';
export {
  reconcile,
  type ReconcileInput,
  type ReconcileOutcome,
  type SessionClaim,
} from './reconcile.ts';
export {
  SessionLifetime,
  type PrincipalKey,
  type ReleaseOutcome,
  type SessionHold,
  type SessionHolder,
  type SessionLifetimeOptions,
} from './lifetime.ts';
export {
  FrameDecoder,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  REQUEST,
  RESPONSE,
  encodeByteFrame,
  encodeJsonFrame,
  isByteKind,
  type Frame,
  type FrameKind,
  type ProtocolError,
  type ProtocolErrorCode,
  type RequestKind,
  type ResponseKind,
} from './protocol.ts';
export {
  SessionServer,
  type ClientRole,
  type Connection,
  type SessionServerOptions,
} from './server.ts';
export { HookJournal, DEFAULT_JOURNAL_LIMIT, type HookEnvelope } from './hook-journal.ts';
