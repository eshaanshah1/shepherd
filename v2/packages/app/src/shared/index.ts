export {
  COALESCE,
  EMIT,
  INVOKE,
  emitChannels,
  invokeChannels,
  type Channel,
  type EmitChannel,
  type InvokeChannel,
  type IpcError,
  type IpcResult,
  type LayoutSnapshot,
  type SessionCreateRequest,
  type SessionDataMessage,
  type SessionDescriptor,
  type SessionExitMessage,
  type ViewportRect,
} from './channels.ts';

export {
  BRIDGE_SURFACE,
  FORBIDDEN_GLOBALS,
  type BridgeNamespace,
  type CommandsApi,
  type LayoutApi,
  type SessionApi,
  type ShepherdBridge,
  type WindowApi,
} from './bridge.ts';

// `menu-commands.ts` is deliberately absent: it imports @shepherd/core/layout as
// a value, and this barrel is what the sandboxed preload pulls in.
export { COMMANDS, commandIds, type CommandID } from './commands.ts';

export { OutputCoalescer, type CoalescerOptions } from './coalescer.ts';
