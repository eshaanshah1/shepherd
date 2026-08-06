// @shepherd/sdk — the surface extensions (and core, and app) agree on.
//
// M0 carries only what P0's scaffold needs to prove the wiring: the branded
// ids, the injected `Clock` (nothing anywhere calls Date.now()), `Disposable`,
// and a result type. M1 grows this into the real API in the core design §4.

export type { Brand } from './brand.ts';
export type { SessionID, PaneID, ExtensionID } from './ids.ts';
export { sessionId, paneId, extensionId } from './ids.ts';
export type { Clock } from './clock.ts';
export { systemClock, manualClock, type ManualClock } from './clock.ts';
export type { Disposable } from './disposable.ts';
export { toDisposable, disposeAll } from './disposable.ts';
export type { Result, Ok, Err } from './result.ts';
export { ok, err, isOk, isErr, unwrap } from './result.ts';
