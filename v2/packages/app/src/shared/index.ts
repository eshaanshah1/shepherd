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
  type SessionCreateRequest,
  type SessionDataMessage,
  type SessionDescriptor,
  type SessionExitMessage,
} from './channels.ts';

export {
  BRIDGE_SURFACE,
  FORBIDDEN_GLOBALS,
  type BridgeNamespace,
  type CommandsApi,
  type SessionApi,
  type ShepherdBridge,
  type WindowApi,
} from './bridge.ts';

export {
  COMMANDS,
  commandIds,
  isCommandID,
  type CommandID,
  type CommandMessage,
} from './commands.ts';

export { OutputCoalescer, type CoalescerOptions } from './coalescer.ts';
