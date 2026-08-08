// The renderer's entire view of the main process, declared once, in a file
// loaded by both — so the preload cannot expose something the renderer does not
// know about, and the renderer cannot reach for something the preload does not
// offer. Shared code imports neither electron nor react (lint).

import type { TreeItem } from '@shepherd/sdk';
import type {
  IpcResult,
  LayoutSnapshot,
  SessionCreateRequest,
  SessionDataMessage,
  SessionDescriptor,
  SessionExitMessage,
  ViewportRect,
  AgentIndicatorDTO,
} from './channels.ts';

/**
 * Sessions. `bytes` crosses as a `Uint8Array` in both directions, never a
 * string: decoding in main splits multi-byte sequences at chunk boundaries and
 * mangles them before xterm — which owns the decoder — ever sees them.
 *
 * Note what is NOT here: no generic `invoke(channel, …)`. A page that is
 * compromised can only say the things this interface already knows how to say,
 * and widening it is an edit to `BRIDGE_SURFACE` below, which a test reads.
 */
export interface SessionApi {
  create(request: SessionCreateRequest): Promise<IpcResult<SessionDescriptor>>;
  attach(sessionId: string): Promise<IpcResult<SessionDescriptor>>;
  detach(sessionId: string): Promise<IpcResult<void>>;
  write(sessionId: string, data: string | Uint8Array): Promise<IpcResult<void>>;
  paste(sessionId: string, text: string): Promise<IpcResult<void>>;
  resize(sessionId: string, cols: number, rows: number): Promise<IpcResult<void>>;
  kill(sessionId: string): Promise<IpcResult<void>>;
  /** Returns an unsubscribe function — a pane that unmounts stops listening. */
  onData(listener: (message: SessionDataMessage) => void): () => void;
  onExit(listener: (message: SessionExitMessage) => void): () => void;
}

/**
 * The one funnel, from the page's side.
 *
 * This replaces the M0 `onCommand` subscription, and the direction is the whole
 * point: main used to *tell* the renderer what a menu key meant because the
 * renderer owned the layout. It doesn't any more — the kernel does — so a
 * gesture in the page is a *transport* into the same `CommandRegistry` that ⌘D
 * and `shepherd pane split` reach.
 *
 * `invoke(command, args)` is not the generic `invoke(channel, …)` escape hatch
 * the note above refuses. A channel is a private door into main; a command id is
 * a public verb that is authorized in the dispatcher against an attributed
 * caller before any handler runs. The page can only say the things the registry
 * already offers, and main decides — the page never asserts — that this caller
 * is `{kind:'user'}`.
 */
export interface CommandsApi {
  invoke(command: string, args?: unknown): Promise<IpcResult<unknown>>;
}

/**
 * The layout, read-only from the page: fetch the projection once, then follow it.
 *
 * `setViewport` is the exception, and it is not a mutation of the tree — core
 * has no DOM and `neighbor` needs a rect, so the renderer measures its pane area
 * and publishes it. That is what lets `layout.focusDirection` take no rect
 * argument and stay invokable from a CLI or an extension.
 */
export interface LayoutApi {
  get(): Promise<IpcResult<LayoutSnapshot>>;
  /** Returns an unsubscribe function. */
  onChanged(listener: (snapshot: LayoutSnapshot) => void): () => void;
  setViewport(rect: ViewportRect): Promise<IpcResult<void>>;
}

/**
 * The window itself. One verb, and after P4a it has no caller: ⌘W's
 * fall-through to the window is decided in core (`onLastPaneClosed`), so main
 * closes its own window and the renderer no longer has to work out which case
 * it is in. Kept because it is the only sanctioned way for a page to ask —
 * `window.close()` from page script is a Chromium-policy coin flip for a window
 * the page did not open — and the next thing that needs it should not have to
 * re-derive that.
 */
export interface WindowApi {
  close(): Promise<IpcResult<void>>;
}

/**
 * Agent state, read-only from the page — the same pull-then-follow shape as the
 * layout, and for the same reason: a push-only channel leaves a renderer that
 * mounted late (every HMR reload) blank until the next transition.
 *
 * Note what is NOT here: any way to name a bus topic. Main relays exactly one,
 * by an allow-list it owns. `claude.hook` carries whole hook payloads — tool
 * inputs, prompts, file contents — on the same bus, and a page that could
 * subscribe by name could ask for it.
 */
export interface AgentsApi {
  get(): Promise<IpcResult<readonly AgentIndicatorDTO[]>>;
  /** Returns an unsubscribe function. */
  onChanged(listener: (indicators: readonly AgentIndicatorDTO[]) => void): () => void;
}

/**
 * Contributed views (M3). The page asks WHICH views exist, for a named view's
 * rows, and reports a click — and can name neither a bus topic nor a caller.
 * Who a click runs as is main's decision (D14).
 */
export interface ViewContributionDTO {
  readonly extension: string;
  readonly type: string;
  /** How the page must draw it. `component` resolves against the UI table. */
  readonly kind: 'tree' | 'component';
  readonly component?: string;
  readonly surface?: 'dock' | 'overlay';
  readonly key?: string;
  readonly title?: string;
}

export interface ViewsApi {
  list(): Promise<IpcResult<readonly ViewContributionDTO[]>>;
  children(type: string, parent?: string): Promise<IpcResult<readonly TreeItem[]>>;
  activate(type: string, command: { readonly id: string; readonly args?: unknown }): Promise<IpcResult<void>>;
  /**
   * A contributed component running a command **as the extension that
   * contributed it** — never as the page, and never as the user.
   *
   * The page names the view type, which main told it about, and the command id.
   * It cannot name a caller here any more than it can on `commands.invoke`.
   */
  invoke(type: string, command: string, args?: unknown): Promise<IpcResult<unknown>>;
  onChanged(listener: (type: string) => void): () => void;
}

export interface ShepherdBridge {
  readonly session: SessionApi;
  readonly commands: CommandsApi;
  readonly layout: LayoutApi;
  readonly agents: AgentsApi;
  readonly views: ViewsApi;
  readonly window: WindowApi;
}

/**
 * The allowlist, as data.
 *
 * `preload/api.ts` is asserted to expose exactly this and nothing else, and the
 * terminal smoke re-asserts it against the REAL `window.shepherd` inside a real
 * renderer — where `contextIsolation` is what actually decides whether
 * `window.require` exists, which no unit test can tell you.
 */
export const BRIDGE_SURFACE = {
  session: [
    'create',
    'attach',
    'detach',
    'write',
    'paste',
    'resize',
    'kill',
    'onData',
    'onExit',
  ],
  commands: ['invoke'],
  layout: ['get', 'onChanged', 'setViewport'],
  agents: ['get', 'onChanged'],
  /**
   * Contributed views (M3). The page may ask which views exist, for a named
   * view's rows, and report a click — and nothing else. It cannot name a bus
   * topic or a caller, which is what the agent relay's allow-list was
   * protecting and what this generalizes without widening.
   */
  views: ['list', 'children', 'activate', 'invoke', 'onChanged'],
  window: ['close'],
} as const satisfies Record<keyof ShepherdBridge, readonly string[]>;

export type BridgeNamespace = keyof typeof BRIDGE_SURFACE;

/** Globals that must NOT be reachable from the page. Asserted in the smoke. */
export const FORBIDDEN_GLOBALS = ['require', 'process', 'module', 'global'] as const;
