// The session half of the kernel: the replay ring, the record-and-fan-out seam
// over it, and `SessionHost` — the registry of live PTYs that owns one
// `PtyFanout` each and carries the `onWillCreate` env-injection seam.
export { PtyRing } from './ring.ts';
export { PtyFanout, type PtySink } from './fanout.ts';
export {
  SessionHost,
  resolveSpec,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_RING_BYTES,
  DEFAULT_TERM,
  type ResolvedSpec,
  type SessionError,
  type SessionErrorCode,
  type SessionExit,
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
  SESSION_COMMANDS,
  type SessionCommandsOptions,
  type ViewingLookup,
} from './commands.ts';
