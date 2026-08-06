// The renderer's entire view of the main process, declared once, in a file
// loaded by both — so the preload cannot expose something the renderer does not
// know about, and the renderer cannot reach for something the preload does not
// offer. Shared code imports neither electron nor react (lint).

import type {
  IpcResult,
  SessionCreateRequest,
  SessionDataMessage,
  SessionDescriptor,
  SessionExitMessage,
} from './channels.ts';
import type { CommandMessage } from './commands.ts';

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
 * Menu commands, main → renderer, one way.
 *
 * The keys live on real menu items with real accelerators (that is what makes
 * ⌘D work at all on macOS), so the *decision* has to travel from main to the
 * renderer, which is the only process that knows the layout. Hence a
 * subscription rather than a request: main says what was chosen, the renderer
 * decides what it means.
 */
export interface CommandsApi {
  onCommand(listener: (message: CommandMessage) => void): () => void;
}

/**
 * The window itself. Exactly one verb, and it exists for one case: ⌘W closes
 * the focused pane, and on the LAST pane it falls through to closing the
 * window. Only the renderer knows which of those it is, so only the renderer
 * can ask. (`window.close()` from page script is a Chromium-policy coin flip
 * for a window the page did not open; a named channel is not.)
 */
export interface WindowApi {
  close(): Promise<IpcResult<void>>;
}

export interface ShepherdBridge {
  readonly session: SessionApi;
  readonly commands: CommandsApi;
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
  commands: ['onCommand'],
  window: ['close'],
} as const satisfies Record<keyof ShepherdBridge, readonly string[]>;

export type BridgeNamespace = keyof typeof BRIDGE_SURFACE;

/** Globals that must NOT be reachable from the page. Asserted in the smoke. */
export const FORBIDDEN_GLOBALS = ['require', 'process', 'module', 'global'] as const;
