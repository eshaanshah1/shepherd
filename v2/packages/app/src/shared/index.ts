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

export { OutputCoalescer, type CoalescerOptions } from './coalescer.ts';
