// The IPC vocabulary, in one file both processes import. Shared code is loaded
// in main AND renderer, so it may import neither electron nor react (lint).

import type { Rect, SplitNode } from '@shepherd/core/layout';

/** One session's agent state, as the chrome needs it. */
export interface AgentIndicatorDTO {
  readonly sessionId: string;
  readonly state: string;
  readonly reason?: string;
}

/** Renderer → main, request/response (`ipcRenderer.invoke`). */
export const INVOKE = {
  sessionCreate: 'session:create',
  sessionAttach: 'session:attach',
  sessionDetach: 'session:detach',
  sessionWrite: 'session:write',
  sessionPaste: 'session:paste',
  sessionResize: 'session:resize',
  /**
   * What a viewer can DISPLAY — an opinion the host arbitrates, not a command.
   *
   * Distinct from `session:resize` because the two mean different things and one
   * of them is now the only thing a pane may say. See `SessionApi.setViewport`.
   */
  sessionViewport: 'session:viewport',
  sessionKill: 'session:kill',
  windowClose: 'window:close',
  layoutGet: 'layout:get',
  layoutViewport: 'layout:viewport',
  commandInvoke: 'command:invoke',
  /**
   * What the palette lists. Pull-shaped like `layoutGet`, and a SNAPSHOT rather
   * than a subscription: the registry changes when an extension activates or is
   * disposed, which never happens while a palette is open.
   */
  commandList: 'command:list',
  /**
   * Pull-shaped, mirroring `layoutGet`: the renderer asks on mount rather than
   * main pushing on `did-finish-load`, which races React's first commit. It also
   * makes an HMR remount re-pull for free.
   */
  agentsGet: 'agents:get',
  /**
   * Contributed views — M3. The renderer asks WHICH views exist and for a
   * tree's rows; it never names a bus topic, which is what the agent relay's
   * allow-list was protecting and what this generalizes.
   */
  viewsList: 'views:list',
  viewsChildren: 'views:children',
  viewsActivate: 'views:activate',
  /**
   * `activate` with the answer kept — what a contributed **component** needs
   * (ADR 0033). It is the same attribution in main, deliberately: a second
   * channel that ran a command a second way is where `{kind:'user'}` would
   * quietly come back.
   */
  viewsInvoke: 'views:invoke',
  /**
   * "What does this row of ANOTHER member's view stand for, and show it here."
   *
   * A separate channel from `activate` because the two are different intentions
   * and only one of them is safe to send across the net: `activate` runs the
   * row's own gesture, which for a task opens a pane and switches the window on
   * whichever machine runs it. See `TreeItem.presents`.
   */
  viewsPresent: 'views:present',
} as const;

/** Main → renderer, fire-and-forget (`webContents.send`). */
export const EMIT = {
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  /**
   * The pty was reshaped. Named `reshaped`, not `resize`, because
   * `INVOKE.sessionResize` already owns `session:resize` — this is the ANSWER
   * coming back after arbitration, not a request going out.
   */
  sessionReshaped: 'session:reshaped',
  layoutChanged: 'layout:changed',
  /** Agent state per session — the indicator's only source. */
  agentsChanged: 'agents:changed',
  /** A contributed view's data changed; re-ask for its rows. */
  viewsChanged: 'views:changed',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];
export type EmitChannel = (typeof EMIT)[keyof typeof EMIT];
export type Channel = InvokeChannel | EmitChannel;

export const invokeChannels = Object.values(INVOKE) as InvokeChannel[];
export const emitChannels = Object.values(EMIT) as EmitChannel[];

/**
 * Output coalescing budget for `session:data`.
 *
 * One `webContents.send` per pty `onData` floods the channel on `yes`-style
 * output — the renderer then spends its frame budget in IPC deserialization
 * rather than in xterm. Main accumulates and flushes on whichever of these
 * comes first. Retrofitting this after xterm is attached is much more
 * expensive than starting with it, so the numbers live here from day one.
 */
export const COALESCE = {
  /** Flush at most this often; ~half a frame at 60Hz. */
  intervalMs: 8,
  /** …or immediately once this much is pending. */
  maxBytes: 32 * 1024,
} as const;

/**
 * `session:data` payloads are `Uint8Array`, never `string`: decoding in main
 * splits multi-byte sequences across chunk boundaries and mangles them before
 * xterm — which owns the decoder — ever sees them.
 */
export interface SessionDataMessage {
  readonly sessionId: string;
  readonly bytes: Uint8Array;
}

/**
 * The pty's new grid. A viewer must reshape to it — the size is arbitrated
 * between everyone watching, so it changes without this renderer asking.
 */
export interface SessionResizeMessage {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionExitMessage {
  readonly sessionId: string;
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * The wire DTOs.
 *
 * Deliberately their own types rather than re-exports of core's `SessionSpec` /
 * `SessionError`: this file is loaded in the renderer, and a type alias is one
 * refactor away from becoming a value import that drags node-pty across the
 * process boundary. Same discipline as the layout's persisted DTOs — a field
 * reaches the wire because somebody wrote it here.
 */
export interface SessionCreateRequest {
  /**
   * Both optional, and main fills them in — see `shellDefaults` in
   * @shepherd/platform-darwin. The renderer has no `os.homedir()` and no
   * `$SHELL`, so a required `cwd` here would only ever be a guess it invented.
   */
  readonly cwd?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly term?: string;
  readonly paneId?: string;
}

export interface SessionDescriptor {
  readonly sessionId: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
}

/**
 * The layout, as the renderer receives it. Main owns the tree; this is the
 * projection of ONE root; `LayoutSnapshots` below is the envelope it pushes on
 * `layout:changed` and answers `layout:get` with.
 *
 * **The tree crosses as plain `SplitNode` data.** That is why the type above
 * refuses to alias core's session DTOs but this one aliases core's tree: the
 * objection there is that a type alias is one refactor away from a *value*
 * import dragging node-pty into a page, and `@shepherd/core/layout` has no
 * node-pty, no electron and no OS API anywhere in its import graph — it is the
 * one core subpath the renderer may import outright (`tooling/eslint/boundaries.js`).
 * `SplitNode` is readonly interfaces of strings and numbers, so Electron's
 * structured clone carries it as-is.
 *
 * It is emphatically NOT run through `serializeNode`/`deserializeNode` on the
 * way: `deserializeNode` mints FRESH pane ids by design (a restored pane is a
 * new pane), which on a per-update wire would rename every pane on every push
 * and destroy the identity the terminal registry is keyed by.
 */
export interface LayoutSnapshot {
  readonly root: string;
  /**
   * The pane group this root is a TAB OF — its own id unless somebody grouped
   * it, so every root has one and nothing here is optional.
   *
   * The page reads it twice: to build the tab strip (the roots sharing the
   * active root's group) and to decide which sidebar row is selected. Both are
   * derivations of this envelope rather than state, which is what keeps the
   * strip and the highlight from being able to disagree with the stage.
   */
  readonly group: string;
  /**
   * The pane tree, or **null for a root that holds no panes** — which is a real
   * state since the empty-state fix: closing the last pane of the home root
   * leaves it open and empty rather than closing the window.
   *
   * The root still travels. Dropping it from the envelope instead would make
   * `active` name a root the page cannot find, and the stage would draw nothing
   * at all with nothing anywhere saying why — the failure the old code had in
   * reverse.
   */
  readonly tree: SplitNode | null;
  /** Already resolved: never a stale id, and never null while a pane exists. */
  readonly focusedPaneId: string | null;
  readonly zoomedPaneId: string | null;
  /** paneId -> sessionId, for panes showing a live session. */
  readonly sessions: Readonly<Record<string, string>>;
}

/**
 * **Every** root, and which one the window is showing.
 *
 * A root is a pane group; the window draws one at a time and the sidebar
 * switches between them (v1's workspaces). The renderer is sent all of them
 * rather than just the active one because it keeps every root MOUNTED and hides
 * the inactive ones with `display: none` — a root it had never been told about
 * would have to be built on the switch, and building a pane is creating a pty.
 * That is the same rule v1 learned as "a remounted pane is a new PTY", one
 * process along, and it is why this is an envelope rather than a swap.
 */
export interface LayoutSnapshots {
  /** The root the window shows. Every other root is mounted and hidden. */
  readonly active: string;
  readonly roots: readonly LayoutSnapshot[];
}

/** The pane area, in its own coordinates. Pushed by the renderer on resize. */
export type ViewportRect = Rect;

export interface IpcError {
  readonly code: string;
  readonly message: string;
}

/**
 * Every handler answers with this. A rejected `invoke` in the renderer arrives
 * as an Error whose message has been mangled by Electron's serializer and whose
 * `code` is gone — so failures are values here, exactly as they are in core.
 */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError };
