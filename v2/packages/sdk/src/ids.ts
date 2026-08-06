import type { Brand } from './brand.ts';

/** THE correlation key for a terminal session — main process, IPC, and remote. */
export type SessionID = Brand<string, 'SessionID'>;
/** A leaf of the layout tree. One pane shows at most one session. */
export type PaneID = Brand<string, 'PaneID'>;
/** An extension's manifest id, e.g. `shepherd.tasks`. */
export type ExtensionID = Brand<string, 'ExtensionID'>;

export const sessionId = (raw: string): SessionID => raw as SessionID;
export const paneId = (raw: string): PaneID => raw as PaneID;
export const extensionId = (raw: string): ExtensionID => raw as ExtensionID;
