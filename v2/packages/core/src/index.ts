// @shepherd/core — the kernel.
//
// Two directories, both of which the design names:
//   src/layout/   — the SplitTree port. Pure, immutable, platform-free.
//   src/session/  — PtyRing + PtyFanout now; SessionHost (node-pty) in P2.
//
// They are directories rather than packages on purpose: one tsconfig, one
// vitest project, one boundary-lint rule. Splitting them into workspace
// packages would triple the project-reference wiring and buy nothing in M0.
export { newSessionId, newPaneId, type RandomId } from './identity.ts';

export {
  authorize,
  emptyGrants,
  CommandRegistry,
  DuplicateCommandError,
  type CommandRegistryOptions,
  type GrantSet,
  type Verdict,
} from './commands/index.ts';

export { EventBus, type EventBusOptions } from './events/index.ts';

export {
  SqliteStore,
  MIGRATIONS,
  LATEST_VERSION,
  type Migration,
  type SqliteStoreOptions,
} from './storage/index.ts';

export { debounce, type Debounced } from './util/index.ts';

export {
  LayoutStore,
  registerLayoutCommands,
  LAYOUT_COMMANDS,
  type CloseOutcome,
  type LayoutCommandsOptions,
  type LayoutStoreOptions,
  type PersistedLayout,
  type SessionSink,
} from './layout/index.ts';

export {
  ControlIngress,
  EventsIngress,
  UnixHttpServer,
  reclaimSocketPath,
  COMMANDS_ROUTE,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EVENTS_ROUTE,
  INVOKE_ROUTE,
  SUBSCRIBE_ROUTE,
  type ControlIngressOptions,
  type EventsIngressOptions,
  type ReclaimOutcome,
  type Route,
  type RouteRequest,
  type RouteResponse,
  type UnixHttpServerOptions,
} from './ingress/index.ts';

export type {
  Pane,
  PaneInit,
  SplitAxis,
  FocusDirection,
  Rect,
  SplitNode,
  SplitDivider,
  TreeEdit,
  PersistedPane,
  PersistedNode,
} from './layout/index.ts';
export {
  makePane,
  displayTitle,
  leaf,
  split,
  leafIds,
  panes,
  firstLeafId,
  findPane,
  containsPane,
  splitPane,
  updatePane,
  setRatio,
  clampRatio,
  frames,
  dividers,
  dividerKey,
  neighbor,
  siblingLeaf,
  closing,
  MIN_RATIO,
  MAX_RATIO,
  serializePane,
  serializeNode,
  deserializeNode,
  LayoutDecodeError,
} from './layout/index.ts';

export {
  PtyRing,
  PtyFanout,
  SessionHost,
  resolveSpec,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_RING_BYTES,
  DEFAULT_TERM,
  type PtySink,
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
  registerSessionCommands,
  SESSION_COMMANDS,
  type SessionCommandsOptions,
  type ViewingLookup,
} from './session/index.ts';

export { ViewingResolver, type Presence } from './attention/index.ts';
export { route, wantsAttention, type RoutingDecision, type RoutingInput } from './attention/index.ts';
export {
  AttentionStore,
  ATTENTION_TOPIC,
  attentionTarget,
  type AttentionChanged,
  type AttentionStoreOptions,
  type AttentionTarget,
  type DecideOptions,
} from './attention/index.ts';
export {
  ATTENTION_COMMANDS,
  registerAttentionCommands,
  type AttentionCommandsOptions,
} from './attention/index.ts';

export {
  parseManifest,
  isExtensionIdShape,
  isVersion,
  isVersionRange,
  type ManifestError,
} from './extensions/index.ts';
export {
  permissionDiff,
  PermissionStore,
  type PermissionDiff,
  type ReviewOutcome,
} from './extensions/index.ts';
export { PointRegistry, DuplicatePointError, type PointRegistryOptions } from './extensions/index.ts';
export {
  ExtensionRegistry,
  shouldActivate,
  type ActivationTrigger,
  type Activator,
  type ExtensionRecord,
  type ExtensionRegistryOptions,
  type ExtensionState,
} from './extensions/index.ts';
