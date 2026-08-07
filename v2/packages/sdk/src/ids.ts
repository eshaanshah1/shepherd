import type { Brand } from './brand.ts';

/** THE correlation key for a terminal session — main process, IPC, and remote. */
export type SessionID = Brand<string, 'SessionID'>;
/** A leaf of the layout tree. One pane shows at most one session. */
export type PaneID = Brand<string, 'PaneID'>;
/** An extension's manifest id, e.g. `shepherd.tasks`. */
export type ExtensionID = Brand<string, 'ExtensionID'>;
/**
 * Any node of the layout tree — a split, a region, or a leaf. A leaf's node id
 * and the `PaneID` of the pane it holds are deliberately different types: the
 * tree addresses structure, a pane addresses a surface, and v1 spent real time
 * on bugs where one was passed for the other.
 */
export type NodeID = Brand<string, 'NodeID'>;
/** One layout root per window. Multi-window is more roots over one session pool. */
export type RootID = Brand<string, 'RootID'>;

export const sessionId = (raw: string): SessionID => raw as SessionID;
export const paneId = (raw: string): PaneID => raw as PaneID;
export const extensionId = (raw: string): ExtensionID => raw as ExtensionID;
export const nodeId = (raw: string): NodeID => raw as NodeID;
export const rootId = (raw: string): RootID => raw as RootID;
