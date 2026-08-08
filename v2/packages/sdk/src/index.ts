// @shepherd/sdk — the surface extensions (and core, and app) agree on.
//
// Layout of this package:
//   primitives   brand/ids/clock/disposable/result/schema/log — pure, no API
//                shape in them; core and the app use these too.
//   the API      api-sessions / api-layout / api-kernel, gathered by api.ts
//                into `Shepherd`. Types only: core implements them.
//   the contract caller / envelope / permission / manifest — what a caller is,
//                what an event carries, what an extension may do and declares.
//
// Everything in the API surface is **proposed** (sketch §7): reached through
// `api.proposed`, third-party extensions may touch it in dev builds only, and
// built-ins are required to consume it — that requirement is the proving ground.

// ---------------------------------------------------------------- primitives
export type { Brand } from './brand.ts';
export type { SessionID, PaneID, ExtensionID, NodeID, RootID } from './ids.ts';
export { sessionId, paneId, extensionId, nodeId, rootId } from './ids.ts';
export type { Clock } from './clock.ts';
export { systemClock, manualClock, type ManualClock } from './clock.ts';
export type { Disposable } from './disposable.ts';
export { toDisposable, disposeAll } from './disposable.ts';
export type { Result, Ok, Err } from './result.ts';
export { ok, err, isOk, isErr, unwrap } from './result.ts';
export type { Schema, SchemaIssue, OptionalSchema, Infer } from './schema.ts';
export { s, formatIssues } from './schema.ts';
export type { Logger, CategoryLogger, LogLevel, LogCategory, LogRecord, LogSink, LoggerOptions } from './log.ts';
export { createLogger, formatLine, passes, parseLogLevel, nullLogger, LOG_LEVELS, LOG_CATEGORIES } from './log.ts';

// ------------------------------------------------------------------ contract
export type { Caller, CallerKind } from './caller.ts';
export { USER, KERNEL, callerLabel, externalCallerSchema } from './caller.ts';
export type { Envelope, SeqVerdict } from './envelope.ts';
export { seqVerdict } from './envelope.ts';
export type { Permission, ExtensionSource } from './permission.ts';
export { PERMISSIONS, isPermission } from './permission.ts';
export type { Manifest, ActivationEvent, ContributedCommand, ContributedView } from './manifest.ts';
export { manifestSchema } from './manifest.ts';

// ----------------------------------------------------------------------- API
export type {
  Attachment,
  Env,
  LayoutTarget,
  RegionName,
  Session,
  SessionAPI,
  SessionCreateOptions,
  SessionDraft,
  SessionMeta,
} from './api-sessions.ts';
export { REGIONS } from './api-sessions.ts';
export type {
  FocusDirection,
  ExtensionViewProps,
  LayoutAPI,
  LayoutLeaf,
  LayoutNode,
  LayoutRoot,
  LayoutSplit,
  Rect,
  SplitAxis,
  StatusItem,
  TreeDataProvider,
  TreeItem,
  ViewAPI,
  ViewInvokeError,
  ViewProvider,
  ViewRef,
} from './api-layout.ts';
export type {
  AttentionAPI,
  AttentionLevel,
  AttentionState,
  CommandAPI,
  CommandError,
  CommandErrorCode,
  CommandSpec,
  EventAPI,
  ExecErr,
  ExecOk,
  ExecOptions,
  ExtensionPoint,
  ExtensionsAPI,
  KV,
  PointsAPI,
  ProcessAPI,
  SecretStore,
} from './api-kernel.ts';
export type { ActivateFn, ExtensionContext, ProposedAPI, Shepherd } from './api.ts';

/**
 * The extension-point primitive, which core-design §4.7 puts here: "the SDK
 * ships a standard extension-point primitive", so *any* extension can be a
 * platform rather than only the core.
 *
 * It lived in `@shepherd/core` until M2, when its first real consumer turned out
 * to be an extension rather than the kernel: a point hands back live objects
 * holding provider **functions**, which cannot cross a message port — so the
 * registry has to run in the utility process beside the extensions using it, and
 * `boundaries.js` (rightly) denies `@shepherd/core` there. Core re-exports it, so
 * nothing outside core moved.
 */
export { DuplicatePointError, PointRegistry } from './points.ts';
export type { DefinePointOptions, PointRegistryOptions } from './points.ts';
